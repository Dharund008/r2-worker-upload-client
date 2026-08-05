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
  begins. An explicit **Upload** button starts the transfer.
- **Multipart for large files** — files over 50 MiB are automatically sliced into parts
  and uploaded with 3-way concurrency, supporting objects up to ~488 GiB.
- **Collision detection** — if a key already exists, the upload is refused with a 409.
  The user can rename or explicitly overwrite.
- **Theme support** — Dark, Light, Grey, and System (follows OS preference). Persisted
  in localStorage.
- **Append-only** — no delete route exists in the Worker. `abort` only discards parts of
  an in-flight, never-completed upload.

## Per-engagement configuration

All customer-specific values live in `wrangler.jsonc`. The application code (`src/*.js`)
is fully generic and reads everything from `env.*` at runtime.

| Setting | Where | Purpose |
|---|---|---|
| `name` | `wrangler.jsonc` top-level | Worker name (e.g. `acme-r2-upload-client`) |
| `bucket_name` | `r2_buckets[0]` | R2 bucket (dev and production) |
| `TEAM_DOMAIN` | `vars` | Cloudflare Access team domain |
| `POLICY_AUD` | `vars` | Access application Audience tag |
| `UPLOAD_PREFIX` | `vars` | Optional: confine uploads under a prefix. `""` = no confinement. |

### Setup

```sh
npm install

# 1. Edit wrangler.jsonc with the customer's bucket names, Access domain, and AUD.

# 2. Create the bucket if it does not exist
npx wrangler r2 bucket create <bucket-name>

# 3. Local development — uses LOCAL R2 storage, never touches the real bucket
npm run dev              # REQUIRE_ACCESS=false, http://localhost:8787

# 4. Deploy
npm run deploy

# 5. Enable Access in the Cloudflare dashboard, paste the team domain and
#    AUD tag into wrangler.jsonc, and redeploy.
npm run deploy
```

Promoting to production:

```sh
npm run deploy:prod
```

To develop against the **real** bucket instead of local storage:

```sh
npm run dev:remote
```

## Upload prefix (optional confinement)

When `UPLOAD_PREFIX` is set (e.g. `"uploads/"`), all uploads are confined under that
prefix and the folder browser starts there. This is useful when the bucket is shared
with other tooling (e.g. a bulk migration) and you want structural separation.

When `UPLOAD_PREFIX` is `""` (empty), uploads can land anywhere in the bucket and the
browser starts at the bucket root. Access-gating remains the trust boundary.

## Why there is no delete

The Worker is deliberately **append-only**. Three independent guarantees:

1. **No route exists.** The Worker has no `DELETE` handler for objects. `DELETE` against
   any path returns 404.
2. **No UI affordance.** The page can browse and upload, but cannot remove objects.
3. **`/api/upload/abort` is not a delete.** It calls `R2MultipartUpload.abort()`, which
   discards the parts of an *in-flight, never-completed* upload.

## How large files work

The browser slices the file and the Worker drives R2 multipart upload:

```
POST /api/upload/create    {key, size, contentType}  -> {uploadId, partSize, partCount}
PUT  /api/upload/part?...                            -> {partNumber, etag}   (xN, 3 in flight)
POST /api/upload/complete  {key, uploadId, parts[]}  -> {key, etag, size}
POST /api/upload/abort     {key, uploadId}           -> 204
```

Part size is **50 MiB**, giving a **488 GiB ceiling** per object (50 MiB × 10,000 parts).

## API routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | Client configuration (part size, prefix, user email) |
| `GET` | `/api/browse?prefix=&cursor=` | List folders and files at a prefix (paginated) |
| `PUT` | `/api/upload/single?key=` | Single-shot upload (≤ 50 MiB) |
| `POST` | `/api/upload/create` | Start multipart upload |
| `PUT` | `/api/upload/part?key=&uploadId=&partNumber=` | Upload one part |
| `POST` | `/api/upload/complete` | Finalise multipart upload |
| `POST` | `/api/upload/abort` | Discard incomplete multipart parts |

## Authentication

The Worker independently verifies the `Cf-Access-Jwt-Assertion` header with `jose`
against `${TEAM_DOMAIN}/cdn-cgi/access/certs`. The verified `email` is written to
each object's `customMetadata` as `uploaded-by`.

If `REQUIRE_ACCESS` is `true` but `TEAM_DOMAIN`/`POLICY_AUD` are unset, every request
returns `500` — the Worker fails closed.

## Layout

```
wrangler.jsonc        Config: R2 binding, asset routing, vars, production env
src/index.js          Routes: browse, upload (single + multipart), config
src/access.js         Access JWT verification
src/keys.js           Key sanitisation and prefix confinement
public/index.html     UI
public/app.js         Browser, queue, upload logic, theme toggle
public/style.css      Themed styles (CSS custom properties)
```

## Limits

| | |
|---|---|
| Max object | 488 GiB (50 MiB × 10,000 parts) |
| Part size | 50 MiB |
| Parts in flight | 3 per file, files upload one at a time |
| Part retries | 3, exponential backoff |
| Max key length | 1024 bytes |
| Incomplete uploads | Reaped by R2 after 7 days |

## Verification

After deploying, verify with:

```sh
# Auth negative test (should return 403)
curl -i -X POST https://<worker>.workers.dev/api/upload/create \
  -H 'Content-Type: application/json' -d '{"key":"x","size":1}'

# Browse the bucket root
curl -i https://<worker>.workers.dev/api/browse?prefix=

# Watch live logs
npm run tail
```
