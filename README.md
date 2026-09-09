# R2 Upload Client

A Worker-backed web UI for putting files into a Cloudflare R2 bucket. Built for
one-off uploads, re-uploads of files that failed bulk migrations, and small content
objects — without handing anyone rclone, S3 keys, or dashboard write access to the
bucket.

**Auth:** Cloudflare Access
**Deletion:** not supported — append-only by design

---

## Features

- **Folder browser** — navigate the bucket's folder structure, drill into subfolders,
  create new folders (folders materialise when the first object is uploaded into them).
- **Submit-gated uploads** — dropped/selected files are staged for review before upload
  begins. An explicit **Upload** button starts the transfer after checkbox selection.
- **Presigned direct uploads** — when R2 API credentials are configured, the browser
  uploads directly to R2's S3 endpoint. The Worker only signs URLs and orchestrates
  create/complete lifecycle calls. Falls back to proxied uploads when credentials are
  not set.
- **Dynamic multipart** — files over 50 MiB are automatically sliced into parts with
  dynamic sizing (300 MiB floor, scaling up for very large files) and uploaded with
  4–12 concurrent workers, supporting objects up to ~4.4 TiB.
- **Pause / Resume** — multipart uploads can be paused and resumed. In-flight parts
  finish to avoid wasting transferred bytes; no new parts are started until resumed.
  Presigned URL caches are cleared on resume to avoid expired URLs.
- **Network resilience** — detects `offline`/`online` events. When the network drops,
  active uploads are auto-paused with a persistent banner. When connectivity returns,
  network-paused uploads auto-resume. User-paused uploads are not affected.
- **Cancel confirmation** — cancelling an in-flight upload shows a confirmation modal
  with progress so far. Cancellation is immediate after confirmation (no repeated clicks).
- **Collision detection** — if a key already exists, the upload is refused with a 409.
  The user can rename or overwrite after an explicit confirmation.
- **Public URL or key copy** — after upload, the UI shows and copies either the public
  object URL (`PUBLIC_BASE_URL` + key) or the full R2 key when the bucket is private.
- **Theme support** — Dark, Light, Grey, and System (follows OS preference). Persisted
  in localStorage.
- **Append-only** — no delete route exists in the Worker. `abort` only discards parts of
  an in-flight, never-completed upload. Cancel of an in-flight upload HEADs the key once
  so the UI can say whether anything was actually stored.

## Per-engagement configuration

All customer-specific values live in `wrangler.jsonc`. The application code (`src/*.js`)
is fully generic and reads everything from `env.*` at runtime.

**`wrangler.jsonc` is gitignored** — it holds customer identifiers (name, account ID,
Access AUD tags, bucket names, public domain) that must never be committed. Copy
`wrangler.jsonc.example` to `wrangler.jsonc` and fill in the real values for each
engagement; the example file (with placeholders) is what's tracked in git.

| Setting | Where | Purpose |
|---|---|---|
| `name` | `wrangler.jsonc` top-level | Worker name (e.g. `acme-r2-upload-client`) |
| `bucket_name` | `r2_buckets[0]` | R2 bucket (dev and production) |
| `TEAM_DOMAIN` | `vars` | Cloudflare Access team domain |
| `POLICY_AUD` | `vars` | Access application Audience tag |
| `UPLOAD_PREFIX` | `vars` | Optional: confine uploads under a prefix. `""` = no confinement. |
| `CUSTOMER_NAME` | `vars` | Header brand kicker. `""` hides it. |
| `BUCKET_LABEL` | `vars` | Display name shown in the UI (binding does not expose `bucket_name` at runtime). |
| `PUBLIC_BASE_URL` | `vars` | Optional public origin (`https://cdn.example.com` or `https://pub-xxx.r2.dev`). `""` = private; UI copies the full key instead of a URL. |
| `CF_ACCOUNT_ID` | `vars` | Cloudflare account ID. Required for presigned uploads (builds the S3 endpoint URL). |
| `R2_ACCESS_KEY_ID` | **secret** | R2 S3 API access key. Required for presigned uploads. |
| `R2_SECRET_ACCESS_KEY` | **secret** | R2 S3 API secret key. Required for presigned uploads. |

### Setup

```sh
npm install

# 1. Copy the example config and fill in this engagement's real values
#    (bucket names, Access domain, AUD, CUSTOMER_NAME, BUCKET_LABEL,
#    CF_ACCOUNT_ID, and PUBLIC_BASE_URL if the bucket is public).
#    wrangler.jsonc is gitignored — never commit it.
cp wrangler.jsonc.example wrangler.jsonc

# 2. Create the bucket if it does not exist
npx wrangler r2 bucket create <bucket-name>

# 3. Create an R2 API token for presigned uploads
#    Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API token
#    Permission: "Object Read & Write" scoped to the target bucket
#    Save the Access Key ID and Secret Access Key

# 4. Store the R2 API credentials as Worker secrets
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY

# 5. Local development — uses LOCAL R2 storage, never touches the real bucket.
#    Note: presigned uploads are not available locally (no R2 secrets in local
#    mode); uploads use the legacy proxied path.
npm run dev              # REQUIRE_ACCESS=false, http://localhost:8787

# 6. Deploy
npm run deploy

# 7. Enable Access in the Cloudflare dashboard, paste the team domain and
#    AUD tag into wrangler.jsonc, and redeploy.
npm run deploy
```

Promoting to production:

```sh
# Set secrets for the production environment too
npx wrangler secret put R2_ACCESS_KEY_ID --env production
npx wrangler secret put R2_SECRET_ACCESS_KEY --env production

npm run deploy:prod
```

To develop against the **real** bucket instead of local storage:

```sh
npm run dev:remote
```

## Presigned uploads

When `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `CF_ACCOUNT_ID` are all present,
uploads go directly from the browser to R2's S3-compatible endpoint
(`{CF_ACCOUNT_ID}.r2.cloudflarestorage.com`). The Worker acts only as a control plane:

1. **Signs URLs** — the browser requests presigned PUT URLs from the Worker
2. **Creates/completes uploads** — multipart lifecycle calls (create, complete, abort)
   go through the S3 API via `aws4fetch`
3. **Never proxies bytes** — upload data flows Browser → R2, not Browser → Worker → R2

This removes Worker CPU/memory limits from the upload path and enables much higher
throughput for large files.

**Fallback:** When any credential is missing, `hasPresignedConfig()` returns `false`
and the client uses the legacy proxied path (parts are PUT through the Worker). This
is useful for local development but has Worker size limits for very large files.

## Upload prefix (optional confinement)

When `UPLOAD_PREFIX` is set (e.g. `"uploads/"`), all uploads are confined under that
prefix and the folder browser starts there. This is useful when the bucket is shared
with other tooling (e.g. a bulk migration) and you want structural separation.

When `UPLOAD_PREFIX` is `""` (empty), uploads can land anywhere in the bucket and the
browser starts at the bucket root. Access-gating remains the trust boundary.

Browse paths use the same sanitisation / confinement helpers as upload keys
(`resolveBrowsePrefix` in `src/keys.js`).

## Public URL vs key

Public access on R2 is bucket-level (custom domain or `r2.dev`), not per-object.
Set `PUBLIC_BASE_URL` when objects are publicly reachable; leave it empty for private
buckets. The existing `GET /api/config` returns `publicBaseUrl` once at page load — no
extra per-object API calls. After a successful upload the UI shows and copies:

- **Copy URL** → `{PUBLIC_BASE_URL}/{key}` when configured
- **Copy key** → the full R2 object key when `PUBLIC_BASE_URL` is empty

## Why there is no delete

The Worker is deliberately **append-only**. Three independent guarantees:

1. **No route exists.** The Worker has no `DELETE` handler for objects. `DELETE` against
   any path returns 404.
2. **No UI affordance.** The page can browse and upload, but cannot remove objects.
3. **`/api/upload/abort` is not a delete.** It calls `R2MultipartUpload.abort()`, which
   discards the parts of an *in-flight, never-completed* upload.

## How large files work

### Presigned path (default when R2 credentials are set)

The browser slices the file locally. The Worker signs URLs; data flows directly to R2:

```
POST /api/upload/create          {key, size, contentType}  → {uploadId, partSize, partCount}
POST /api/upload/presign-parts   {key, uploadId, parts[]}  → {urls: {partNumber: url}}
PUT  <presigned R2 URL>                                    → 200 + ETag  (×N, 4–12 in flight)
POST /api/upload/complete        {key, uploadId, parts[]}  → {key, etag, size}
POST /api/upload/abort           {key, uploadId}           → 204
```

Presigned URLs are fetched in batches of 100. URLs expire in 1 hour; the cache is
cleared on resume after a pause.

### Legacy proxied path (fallback without R2 credentials)

The browser slices the file and the Worker proxies each part to R2:

```
POST /api/upload/create    {key, size, contentType}  → {uploadId, partSize, partCount}
PUT  /api/upload/part?...                            → {partNumber, etag}  (×N, 3 in flight)
POST /api/upload/complete  {key, uploadId, parts[]}  → {key, etag, size}
POST /api/upload/abort     {key, uploadId}           → 204
```

### Single-file uploads

Files at or below 50 MiB use a single PUT (presigned or proxied) via XHR so the UI can
show byte-level upload progress. When presigned, a single `POST /api/upload/presign-single`
returns the signed URL.

### Dynamic part sizing

Part size is computed as `max(300 MiB, ceil(fileSize / 9500))`:

| File size | Part size | Parts | Concurrency |
|---|---|---|---|
| 1 GiB | 300 MiB | 4 | 10 |
| 7 GiB | 300 MiB | 24 | 10 |
| 100 GiB | 300 MiB | 342 | 10 |
| 500 GiB | 300 MiB | 1,710 | 10 |
| 1 TiB | 300 MiB | 3,496 | 10 |
| 2.8+ TiB | 315+ MiB | 9,500 | 6+ |

Concurrency scales with part size:

| Part size | Concurrent workers |
|---|---|
| ≤ 50 MiB | 12 |
| ≤ 300 MiB | 10 |
| ≤ 512 MiB | 8 |
| ≤ 1 GiB | 6 |
| > 1 GiB | 4 |

## API routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | Client configuration (part size, prefix, chrome, public base URL, user email, `presignedUploads` flag) |
| `GET` | `/api/browse?prefix=&cursor=` | List folders and files at a prefix (paginated) |
| `GET` | `/api/head?key=` | Existence check after cancel (`exists`, size, uploaded) |
| `PUT` | `/api/upload/single?key=` | Single-shot proxied upload (≤ 50 MiB) |
| `POST` | `/api/upload/presign-single` | Get a presigned PUT URL for a single-shot upload |
| `POST` | `/api/upload/create` | Start multipart upload |
| `PUT` | `/api/upload/part?key=&uploadId=&partNumber=` | Upload one part (legacy proxied path) |
| `POST` | `/api/upload/presign-parts` | Get presigned PUT URLs for a batch of parts (up to 100) |
| `POST` | `/api/upload/complete` | Finalise multipart upload |
| `POST` | `/api/upload/abort` | Discard incomplete multipart parts |

`GET /api/head` is used only after an **in-flight** cancel. Queued/never-started cancels
do not call it. Folder search filters the already-loaded folder client-side and does not
issue extra Worker requests.

## Authentication

The Worker independently verifies the `Cf-Access-Jwt-Assertion` header with `jose`
against `${TEAM_DOMAIN}/cdn-cgi/access/certs`. The verified `email` is written to
each object's `customMetadata` as `uploaded-by`.

If `REQUIRE_ACCESS` is `true` but `TEAM_DOMAIN`/`POLICY_AUD` are unset, every request
returns `500` — the Worker fails closed.

## Observability

Write paths (`upload.single`, `upload.create`, `upload.complete`, `upload.abort`,
`presign.single`, `presign.parts`) and unhandled errors emit a single-line JSON log
(`op`, `key`, `email`, `size`, `status`, …). Successful browse listings and individual
multipart parts are not logged, to keep volume and cost down. `observability.enabled`
remains on in `wrangler.jsonc`.

## Layout

```
wrangler.jsonc        Config: R2 binding, asset routing, vars, production env
src/index.js          Routes: browse, head, upload (single + multipart), presign
src/access.js         Access JWT verification
src/keys.js           Key sanitisation and prefix confinement
public/index.html     UI
public/app.js         Browser, queue, upload logic, pause/resume, theme toggle
public/style.css      Themed styles (CSS custom properties)
```

## Limits

| | |
|---|---|
| Max object | ~4.4 TiB (300 MiB × 9,500 parts; scales dynamically for larger files) |
| Part size | 300 MiB floor, scales up for files > 2.78 TiB |
| Workers in flight | 4–12 per file (based on part size), files upload one at a time |
| Part retries | 3, exponential backoff (waits for network on offline) |
| Max key length | 1024 bytes |
| Presigned URL expiry | 1 hour (cache cleared on resume) |
| Presign batch size | 100 URLs per request |
| Multipart upload expiry | 7 days (R2 reaps incomplete uploads) |
| Pause duration | No practical limit (R2 upload valid for 7 days) |

## Verification

After deploying, verify with:

```sh
# Auth negative test (should return 403)
curl -i -X POST https://<worker>.workers.dev/api/upload/create \
  -H 'Content-Type: application/json' -d '{"key":"x","size":1}'

# Browse the bucket root
curl -i https://<worker>.workers.dev/api/browse?prefix=

# Config (chrome + public base URL + presignedUploads flag)
curl -i https://<worker>.workers.dev/api/config

# Watch live logs
npm run tail
```
