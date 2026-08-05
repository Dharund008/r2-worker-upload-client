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

import { verifyAccessJwt, AccessError } from "./access.js";
import { resolveKey, normalizePrefix, assertWithinPrefix, KeyError } from "./keys.js";

// 50 MiB. R2 requires >= 5 MiB per non-final part, all non-final parts the same
// size, and <= 10,000 parts — so this caps a single object at 488 GiB. It is also
// under the smallest Cloudflare request-body limit (100 MB on Free/Pro), so parts
// fit through the Worker on any plan.
const PART_SIZE = 50 * 1024 * 1024;

// Objects at or below one part skip multipart entirely.
const SINGLE_PUT_MAX = PART_SIZE;

// R2 list() returns at most 1000 keys per call.
const BROWSE_PAGE_SIZE = 3;

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
            partSize: PART_SIZE,
            singlePutMax: SINGLE_PUT_MAX,
            uploadPrefix: env.UPLOAD_PREFIX || "",
            email: identity.email,
          });

        case "GET /api/browse":
          return await handleBrowse(env, url);

        case "PUT /api/upload/single":
          return await handleSingle(request, env, url, identity);

        case "POST /api/upload/create":
          return await handleCreate(request, env, identity);

        case "PUT /api/upload/part":
          return await handlePart(request, env, url);

        case "POST /api/upload/complete":
          return await handleComplete(request, env);

        case "POST /api/upload/abort":
          return await handleAbort(request, env);

        default:
          return json({ error: `No route for ${request.method} ${url.pathname}` }, 404);
      }
    } catch (err) {
      if (err instanceof KeyError) return json({ error: err.message }, 400);
      if (err instanceof BadRequest) return json({ error: err.message }, err.status);
      console.error("Unhandled error", err?.stack || String(err));
      return json({ error: "Internal error" }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Browse — list folders and files at a given prefix.
// ---------------------------------------------------------------------------

async function handleBrowse(env, url) {
  const prefix = normalizePrefix(env.UPLOAD_PREFIX || "");
  const rawPath = url.searchParams.get("prefix") || "";

  // Build the full R2 prefix. If UPLOAD_PREFIX is set, clamp browsing to
  // that subtree. An empty rawPath means "show the root" (or the confined root).
  let listPrefix;
  if (rawPath === "" || rawPath === "/") {
    listPrefix = prefix; // bucket root or confined root
  } else {
    // Normalise the client-supplied path: strip leading slash, ensure trailing slash.
    const cleaned = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
    listPrefix = cleaned ? `${cleaned}/` : "";

    // If UPLOAD_PREFIX is set, assert the requested path is within it.
    if (prefix && !listPrefix.startsWith(prefix)) {
      listPrefix = `${prefix}${listPrefix}`;
    }
  }

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
// Single-shot upload, for objects <= PART_SIZE.
// ---------------------------------------------------------------------------

async function handleSingle(request, env, url, identity) {
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(url.searchParams.get("key") || "", prefix);
  const overwrite = url.searchParams.get("overwrite") === "true";

  const collision = await checkCollision(env, key, overwrite);
  if (collision) return collision;

  if (!request.body) throw new BadRequest("Request body is required");

  // Stream straight through; never buffer the body (128 MB Worker memory limit).
  const object = await env.BUCKET.put(key, request.body, {
    httpMetadata: httpMetadataFrom(request),
    customMetadata: auditMetadata(identity),
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

  const partCount = Math.max(1, Math.ceil(size / PART_SIZE));
  if (partCount > 10000) {
    throw new BadRequest(
      `File is too large: ${partCount} parts needed, R2 allows 10000 (max ~488 GiB at this part size)`,
    );
  }

  const collision = await checkCollision(env, key, body.overwrite === true);
  if (collision) return collision;

  let upload;
  try {
    upload = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: body.contentType ? { contentType: body.contentType } : undefined,
      customMetadata: auditMetadata(identity),
    });
  } catch (err) {
    throw new BadRequest(`Could not start upload: ${errText(err)}`, 502);
  }

  return json({ key, uploadId: upload.uploadId, partSize: PART_SIZE, partCount });
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

async function handleComplete(request, env) {
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

  const upload = env.BUCKET.resumeMultipartUpload(key, body.uploadId);
  try {
    const object = await upload.complete(parts);
    return json({
      key,
      etag: object.httpEtag,
      size: object.size,
      parts: parts.length,
    });
  } catch (err) {
    throw new BadRequest(`Could not complete upload: ${errText(err)}`, 400);
  }
}

// Discards parts of an upload that was never completed. Cannot affect a stored
// object: R2 only materialises the object on complete().
async function handleAbort(request, env) {
  const body = await readJson(request);
  const prefix = env.UPLOAD_PREFIX || "";
  const key = resolveKey(body.key || "", prefix);
  if (!body.uploadId) throw new BadRequest("uploadId is required");

  const upload = env.BUCKET.resumeMultipartUpload(key, body.uploadId);
  try {
    await upload.abort();
  } catch (err) {
    // Already gone or already completed — nothing to clean up either way.
    console.warn(`Abort of ${key} (${body.uploadId}) failed: ${errText(err)}`);
  }
  return new Response(null, { status: 204 });
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
