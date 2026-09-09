// R2 upload client — Worker API.
//
// APPEND-ONLY BY DESIGN. There is no route that deletes a stored object. The only
// destructive-looking route is /api/upload/abort, which calls
// R2MultipartUpload.abort() — that discards the parts of an in-flight, never-
// completed upload and cannot touch a stored object. It exists because abandoned
// multipart uploads otherwise bill for their parts until R2 reaps them after 7 days.
//
// Static assets (the UI) are served without invoking this Worker at all; only
// /api/* reaches here, per assets.run_worker_first in wrangler.jsonc.

import { AwsClient } from "aws4fetch";
import { verifyAccessJwt, AccessError } from "./access.js";
import { resolveKey, resolveBrowsePrefix, KeyError } from "./keys.js";

// Default part size for legacy proxied uploads. Presigned uploads compute part
// size dynamically in handleCreate based on file size.
const DEFAULT_PART_SIZE = 50 * 1024 * 1024; // 50 MiB

// Dynamic part sizing constants — 300 MiB floor balances fewer HTTP round-trips
// against memory and retry cost. R2 allows up to 5 GiB per part.
const MIN_PART_SIZE = 300 * 1024 * 1024; // 300 MiB floor
const MAX_PARTS = 9500;                  // headroom under R2's 10,000 limit

// Objects at or below one part skip multipart entirely.
const SINGLE_PUT_MAX = DEFAULT_PART_SIZE;

// R2 list() returns at most 1000 keys per call.
const BROWSE_PAGE_SIZE = 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Defensive: assets normally handle non-/api paths before we run.
    if (!url.pathname.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not Found", { status: 404 });
    }

    let identity;
    try {
      identity = await verifyAccessJwt(request, env);
    } catch (err) {
      if (err instanceof AccessError) {
        return json({ error: err.message }, err.status);
      }
      throw err;
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /api/config":
          return json({
            partSize: DEFAULT_PART_SIZE,
            singlePutMax: SINGLE_PUT_MAX,
            uploadPrefix: env.UPLOAD_PREFIX || "",
            email: identity.email,
            customerName: env.CUSTOMER_NAME || "",
            bucketLabel: env.R2_BUCKET_NAME || "",
            publicBaseUrl: stripTrailingSlashes(env.PUBLIC_BASE_URL || ""),
            presignedUploads: hasPresignedConfig(env),
          });

        case "GET /api/browse":
          return await handleBrowse(env, url);

        case "GET /api/head":
          return await handleHead(env, url);

        case "PUT /api/upload/single":
          return await handleSingle(request, env, url, identity);

        case "POST /api/upload/create":
          return await handleCreate(request, env, identity);

        case "PUT /api/upload/part":
          return await handlePart(request, env, url);

        case "POST /api/upload/complete":
          return await handleComplete(request, env, identity);

        case "POST /api/upload/abort":
          return await handleAbort(request, env, identity);

        case "POST /api/upload/presign-single":
          return await handlePresignSingle(request, env, identity);

        case "POST /api/upload/presign-parts":
          return await handlePresignParts(request, env, identity);

        default:
          return json({ error: `No route for ${request.method} ${url.pathname}` }, 404);
      }
    } catch (err) {
      if (err instanceof KeyError) return json({ error: err.message }, 400);
      if (err instanceof BadRequest) return json({ error: err.message }, err.status);
      logEvent({
        op: "unhandled",
        status: 500,
        email: identity?.email,
        error: errText(err),
      });
      console.error("Unhandled error", err?.stack || String(err));
      return json({ error: "Internal error" }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Browse — list folders and files at a given prefix.
// ---------------------------------------------------------------------------

async function handleBrowse(env, url) {
  const listPrefix = resolveBrowsePrefix(
    url.searchParams.get("prefix") || "",
    env.UPLOAD_PREFIX || "",
  );
  const cursor = url.searchParams.get("cursor") || undefined;

  try {
    const listed = await env.BUCKET.list({
      prefix: listPrefix,
      delimiter: "/",
      cursor,
      limit: BROWSE_PAGE_SIZE,
    });

    // R2 returns common prefixes as "folders" (delimitedPrefixes).
    const folders = (listed.delimitedPrefixes || []).map((p) => {
      // Strip the listPrefix to get the folder name, then strip trailing slash.
      const relative = p.startsWith(listPrefix) ? p.slice(listPrefix.length) : p;
      return {
        name: relative.replace(/\/$/, ""),
        prefix: p,
      };
    });

    const files = (listed.objects || []).map((obj) => {
      const relative = obj.key.startsWith(listPrefix)
        ? obj.key.slice(listPrefix.length)
        : obj.key;
      return {
        name: relative,
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded?.toISOString?.() ?? null,
      };
    });

    return json({
      prefix: listPrefix,
      folders,
      files,
      truncated: listed.truncated || false,
      cursor: listed.truncated ? listed.cursor : null,
    });
  } catch (err) {
    console.error("Browse error", err?.stack || String(err));
    return json({ error: `Could not list objects: ${errText(err)}` }, 500);
  }
}

// ---------------------------------------------------------------------------
// Head — existence check after cancel (does the object actually exist?).
// ---------------------------------------------------------------------------

async function handleHead(env, url) {
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(url.searchParams.get("key") || "", prefix);
  const existing = await env.BUCKET.head(key);
  if (!existing) {
    return json({ exists: false, key });
  }
  return json({
    exists: true,
    key,
    size: existing.size,
    uploaded: existing.uploaded?.toISOString?.() ?? null,
  });
}

// ---------------------------------------------------------------------------
// Single-shot upload, for objects <= PART_SIZE.
// ---------------------------------------------------------------------------

async function handleSingle(request, env, url, identity) {
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(url.searchParams.get("key") || "", prefix);
  const overwrite = url.searchParams.get("overwrite") === "true";

  const collision = await checkCollision(env, key, overwrite);
  if (collision) {
    logEvent({
      op: "upload.single",
      key,
      email: identity.email,
      status: 409,
      overwrite,
    });
    return collision;
  }

  if (!request.body) throw new BadRequest("Request body is required");

  // Stream straight through; never buffer the body (128 MB Worker memory limit).
  const object = await env.BUCKET.put(key, request.body, {
    httpMetadata: httpMetadataFrom(request),
    customMetadata: auditMetadata(identity),
  });

  logEvent({
    op: "upload.single",
    key,
    email: identity.email,
    size: object.size,
    status: 200,
    overwrite,
  });

  return json({ key, etag: object.httpEtag, size: object.size });
}

// ---------------------------------------------------------------------------
// Multipart: create -> part (xN) -> complete, or abort.
// ---------------------------------------------------------------------------

async function handleCreate(request, env, identity) {
  const body = await readJson(request);
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(body.key || "", prefix);

  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0) {
    throw new BadRequest("size must be a non-negative number");
  }

  const partSize = computePartSize(size);
  const partCount = Math.max(1, Math.ceil(size / partSize));

  const overwrite = body.overwrite === true;
  const collision = await checkCollision(env, key, overwrite);
  if (collision) {
    logEvent({
      op: "upload.create",
      key,
      email: identity.email,
      size,
      status: 409,
      overwrite,
    });
    return collision;
  }

  let uploadId;
  try {
    if (hasPresignedConfig(env)) {
      // Use S3 API so parts uploaded via presigned URLs are in the same namespace.
      const meta = auditMetadata(identity);
      const result = await s3CreateMultipartUpload(env, key, {
        contentType: body.contentType || undefined,
        metadata: meta,
      });
      uploadId = result.uploadId;
    } else {
      // Legacy path: R2 Worker binding.
      const upload = await env.BUCKET.createMultipartUpload(key, {
        httpMetadata: body.contentType ? { contentType: body.contentType } : undefined,
        customMetadata: auditMetadata(identity),
      });
      uploadId = upload.uploadId;
    }
  } catch (err) {
    logEvent({
      op: "upload.create",
      key,
      email: identity.email,
      size,
      status: 502,
      error: errText(err),
    });
    throw new BadRequest(`Could not start upload: ${errText(err)}`, 502);
  }

  logEvent({
    op: "upload.create",
    key,
    email: identity.email,
    size,
    status: 200,
    uploadId,
    partCount,
    overwrite,
  });

  return json({ key, uploadId, partSize: partSize, partCount });
}

async function handlePart(request, env, url) {
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(url.searchParams.get("key") || "", prefix);
  const uploadId = requireParam(url, "uploadId");

  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new BadRequest("partNumber must be an integer between 1 and 10000");
  }
  if (!request.body) throw new BadRequest("Request body is required");

  // resumeMultipartUpload performs no validation — the upload may have been
  // completed or aborted concurrently, so every call needs its own guard.
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  try {
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  } catch (err) {
    throw new BadRequest(`Part ${partNumber} failed: ${errText(err)}`, 400);
  }
}

async function handleComplete(request, env, identity) {
  const body = await readJson(request);
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(body.key || "", prefix);

  if (!body.uploadId) throw new BadRequest("uploadId is required");
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    throw new BadRequest("parts must be a non-empty array");
  }

  const parts = body.parts
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || "") }))
    .sort((a, b) => a.partNumber - b.partNumber);

  for (const p of parts) {
    if (!Number.isInteger(p.partNumber) || !p.etag) {
      throw new BadRequest("Each part needs a numeric partNumber and an etag");
    }
  }

  try {
    let etag, size;

    if (hasPresignedConfig(env)) {
      // S3 API complete — matches S3-created upload + S3-uploaded parts.
      const result = await s3CompleteMultipartUpload(env, key, body.uploadId, parts);
      etag = result.etag;
      // S3 CompleteMultipartUpload doesn't return size; read it from HEAD.
      const head = await env.BUCKET.head(key);
      size = head?.size ?? 0;
    } else {
      // Legacy path: R2 Worker binding.
      const upload = env.BUCKET.resumeMultipartUpload(key, body.uploadId);
      const object = await upload.complete(parts);
      etag = object.httpEtag;
      size = object.size;
    }

    logEvent({
      op: "upload.complete",
      key,
      email: identity?.email,
      size,
      status: 200,
      uploadId: body.uploadId,
      parts: parts.length,
    });
    return json({ key, etag, size, parts: parts.length });
  } catch (err) {
    logEvent({
      op: "upload.complete",
      key,
      email: identity?.email,
      status: 400,
      uploadId: body.uploadId,
      error: errText(err),
    });
    throw new BadRequest(`Could not complete upload: ${errText(err)}`, 400);
  }
}

// Discards parts of an upload that was never completed. Cannot affect a stored
// object: R2 only materialises the object on complete().
async function handleAbort(request, env, identity) {
  const body = await readJson(request);
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(body.key || "", prefix);
  if (!body.uploadId) throw new BadRequest("uploadId is required");

  try {
    if (hasPresignedConfig(env)) {
      await s3AbortMultipartUpload(env, key, body.uploadId);
    } else {
      const upload = env.BUCKET.resumeMultipartUpload(key, body.uploadId);
      await upload.abort();
    }
    logEvent({
      op: "upload.abort",
      key,
      email: identity?.email,
      status: 204,
      uploadId: body.uploadId,
    });
  } catch (err) {
    // Already gone or already completed — nothing to clean up either way.
    logEvent({
      op: "upload.abort",
      key,
      email: identity?.email,
      status: 204,
      uploadId: body.uploadId,
      error: errText(err),
    });
    console.warn(`Abort of ${key} (${body.uploadId}) failed: ${errText(err)}`);
  }
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Presigned URL uploads — browser uploads directly to R2's S3 endpoint.
// ---------------------------------------------------------------------------

/** True when the env has the credentials needed for presigned URLs. */
function hasPresignedConfig(env) {
  return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CF_ACCOUNT_ID);
}

function getR2Client(env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });
}

function r2Endpoint(env, key) {
  const bucket = env.R2_BUCKET_NAME || "default";
  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`;
}

/**
 * Sign a PUT URL for a single object upload. Returns { url, requiredHeaders }.
 * The client MUST send `requiredHeaders` with the PUT for the signature to match
 * and for R2 to store the custom metadata.
 */
async function presignPut(env, key, { expiresIn = 3600, contentType, metadata = {} } = {}) {
  const client = getR2Client(env);
  const url = new URL(r2Endpoint(env, key));
  url.searchParams.set("X-Amz-Expires", String(expiresIn));

  const headers = {};
  if (contentType) headers["content-type"] = contentType;
  for (const [k, v] of Object.entries(metadata)) {
    headers[`x-amz-meta-${k}`] = v;
  }

  const signed = await client.sign(
    new Request(url, { method: "PUT", headers }),
    { aws: { signQuery: true } },
  );

  // Extract only the x-amz-meta-* and content-type headers the client must send.
  const requiredHeaders = {};
  for (const [h, v] of signed.headers) {
    const lower = h.toLowerCase();
    if (lower.startsWith("x-amz-meta-") || lower === "content-type") {
      requiredHeaders[h] = v;
    }
  }

  return { url: signed.url, requiredHeaders };
}

/** Sign a PUT URL for a single multipart part. */
async function presignPartPut(env, key, uploadId, partNumber, { expiresIn = 3600 } = {}) {
  const client = getR2Client(env);
  const url = new URL(r2Endpoint(env, key));
  url.searchParams.set("partNumber", String(partNumber));
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));

  const signed = await client.sign(
    new Request(url, { method: "PUT" }),
    { aws: { signQuery: true } },
  );

  return signed.url;
}

/** Compute part size dynamically so any file up to R2's 5 TiB fits. */
function computePartSize(fileSize) {
  return Math.max(MIN_PART_SIZE, Math.ceil(fileSize / MAX_PARTS));
}

// ---- S3 API multipart lifecycle (create / complete / abort) ----
// When parts are uploaded via presigned URLs (S3 endpoint), the create and
// complete calls must also go through the S3 API — the R2 Worker binding
// cannot see parts uploaded via S3, causing "parts not found" on complete.

/** Create a multipart upload via the S3 API. Returns { uploadId }. */
async function s3CreateMultipartUpload(env, key, { contentType, metadata = {} } = {}) {
  const client = getR2Client(env);
  const url = new URL(r2Endpoint(env, key));
  url.searchParams.set("uploads", "");

  const headers = {};
  if (contentType) headers["content-type"] = contentType;
  for (const [k, v] of Object.entries(metadata)) {
    headers[`x-amz-meta-${k}`] = v;
  }

  const res = await client.fetch(url, { method: "POST", headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 CreateMultipartUpload failed (${res.status}): ${text}`);
  }

  const xml = await res.text();
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match) throw new Error("No UploadId in S3 CreateMultipartUpload response");
  return { uploadId: match[1] };
}

/** Complete a multipart upload via the S3 API. Returns { etag, size }. */
async function s3CompleteMultipartUpload(env, key, uploadId, parts) {
  const client = getR2Client(env);
  const url = new URL(r2Endpoint(env, key));
  url.searchParams.set("uploadId", uploadId);

  // Build the XML body R2 expects.
  const partsXml = parts
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join("");
  const body = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

  const res = await client.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 CompleteMultipartUpload failed (${res.status}): ${text}`);
  }

  const xml = await res.text();
  const etagMatch = xml.match(/<ETag>([^<]+)<\/ETag>/);
  // S3 complete doesn't return size — we get it from head after.
  return { etag: etagMatch ? etagMatch[1] : "" };
}

/** Abort a multipart upload via the S3 API. */
async function s3AbortMultipartUpload(env, key, uploadId) {
  const client = getR2Client(env);
  const url = new URL(r2Endpoint(env, key));
  url.searchParams.set("uploadId", uploadId);

  const res = await client.fetch(url, { method: "DELETE" });
  // 204 or 200 = success; 404 = already gone. All are fine.
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`S3 AbortMultipartUpload failed (${res.status}): ${text}`);
  }
}

// ---- Presigned single-object upload ----

async function handlePresignSingle(request, env, identity) {
  if (!hasPresignedConfig(env)) {
    throw new BadRequest("Presigned uploads are not configured on this Worker", 501);
  }

  const body = await readJson(request);
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(body.key || "", prefix);
  const overwrite = body.overwrite === true;

  const collision = await checkCollision(env, key, overwrite);
  if (collision) {
    logEvent({ op: "presign.single", key, email: identity.email, status: 409, overwrite });
    return collision;
  }

  const meta = auditMetadata(identity);
  const { url: presignedUrl, requiredHeaders } = await presignPut(env, key, {
    contentType: body.contentType || undefined,
    expiresIn: 3600,
    metadata: meta,
  });

  logEvent({ op: "presign.single", key, email: identity.email, status: 200 });
  return json({ key, presignedUrl, requiredHeaders });
}

// ---- Batch presigned URLs for multipart parts ----

async function handlePresignParts(request, env, identity) {
  if (!hasPresignedConfig(env)) {
    throw new BadRequest("Presigned uploads are not configured on this Worker", 501);
  }

  const body = await readJson(request);
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(body.key || "", prefix);

  if (!body.uploadId) throw new BadRequest("uploadId is required");
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    throw new BadRequest("parts must be a non-empty array of part numbers");
  }
  if (body.parts.length > 100) {
    throw new BadRequest("Request at most 100 presigned URLs at a time");
  }

  const urls = {};
  for (const partNumber of body.parts) {
    const n = Number(partNumber);
    if (!Number.isInteger(n) || n < 1 || n > 10000) {
      throw new BadRequest(`Invalid partNumber: ${partNumber}`);
    }
    urls[n] = await presignPartPut(env, key, body.uploadId, n, { expiresIn: 3600 });
  }

  logEvent({
    op: "presign.parts",
    key,
    email: identity.email,
    uploadId: body.uploadId,
    count: body.parts.length,
    status: 200,
  });
  return json({ urls });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Never overwrite silently. Returns a 409 Response on collision, else null.
async function checkCollision(env, key, overwrite) {
  if (overwrite) return null;
  const existing = await env.BUCKET.head(key);
  if (!existing) return null;
  return json(
    {
      error: "An object already exists at that key",
      key,
      existing: {
        size: existing.size,
        uploaded: existing.uploaded?.toISOString?.() ?? null,
        uploadedBy: existing.customMetadata?.["uploaded-by"] || null,
      },
    },
    409,
  );
}

function auditMetadata(identity) {
  return {
    "uploaded-by": identity.email,
    "uploaded-at": new Date().toISOString(),
  };
}

function httpMetadataFrom(request) {
  const meta = {};
  const contentType = request.headers.get("Content-Type");
  if (contentType && contentType !== "application/octet-stream") {
    meta.contentType = contentType;
  }
  return meta;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("Body must be valid JSON");
  }
}

function requireParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new BadRequest(`${name} is required`);
  return value;
}

function stripTrailingSlashes(value) {
  return String(value || "").replace(/\/+$/, "");
}

function logEvent(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

function errText(err) {
  return err?.message || String(err);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BadRequest";
    this.status = status;
  }
}
