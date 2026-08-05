// Key validation and prefix confinement.
//
// The target bucket is shared with the bulk rclone migration, so hand-uploads are
// structurally confined under UPLOAD_PREFIX. That makes it impossible for this
// client to overwrite a migrated object even if a key collides.

const MAX_KEY_BYTES = 1024;

// Control characters break header round-tripping and downstream tooling.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Normalise and validate a user-supplied key.
 * Throws KeyError with a human-readable message on rejection.
 */
export function sanitizeKey(raw) {
  if (typeof raw !== "string") throw new KeyError("Key must be a string");

  // Collapse backslashes to forward slashes so Windows-style paths behave.
  let key = raw.replace(/\\/g, "/");

  // Strip leading slashes — keys are always relative.
  key = key.replace(/^\/+/, "");

  // Collapse repeated slashes and drop empty segments.
  const segments = key.split("/").filter((s) => s.length > 0);

  if (segments.length === 0) throw new KeyError("Key is empty");

  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new KeyError("Key must not contain '.' or '..' path segments");
    }
  }

  key = segments.join("/");

  if (CONTROL_CHARS.test(key)) {
    throw new KeyError("Key must not contain control characters");
  }

  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) {
    throw new KeyError(`Key must be at most ${MAX_KEY_BYTES} bytes`);
  }

  return key;
}

/** Normalise a configured prefix to either "" or "something/". */
export function normalizePrefix(prefix) {
  if (!prefix) return "";
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
}

/**
 * Prepend the configured prefix, unless the key already carries it (so a key
 * echoed back from a previous response is idempotent).
 */
export function applyPrefix(key, prefix) {
  const p = normalizePrefix(prefix);
  if (p === "") return key;
  return key.startsWith(p) ? key : `${p}${key}`;
}

/**
 * Defence in depth: assert a fully-resolved key really sits under the prefix.
 * Called immediately before every R2 write.
 */
export function assertWithinPrefix(key, prefix) {
  const p = normalizePrefix(prefix);
  if (p !== "" && !key.startsWith(p)) {
    throw new KeyError(`Key must be under "${p}"`);
  }
  return key;
}

/** Resolve a raw client key into the final R2 key in one step. */
export function resolveKey(raw, prefix) {
  return assertWithinPrefix(applyPrefix(sanitizeKey(raw), prefix), prefix);
}

/**
 * Normalise a client-supplied browse prefix (folder path). Unlike sanitizeKey,
 * an empty string is valid here — it means "bucket/prefix root". Always
 * returns "" or a string ending in "/".
 */
export function sanitizeBrowsePrefix(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new KeyError("Prefix must be a string");

  let key = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = key.split("/").filter((s) => s.length > 0);

  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new KeyError("Folder path must not contain '.' or '..' segments");
    }
    if (CONTROL_CHARS.test(seg)) {
      throw new KeyError("Folder path must not contain control characters");
    }
  }

  if (segments.length === 0) return "";
  return `${segments.join("/")}/`;
}

/**
 * Resolve a client-requested browse prefix against the configured
 * UPLOAD_PREFIX. When UPLOAD_PREFIX is set, browsing is confined under it —
 * same trust boundary as uploads. When UPLOAD_PREFIX is "", the requested
 * prefix (including "") is used as-is: browsing is bucket-wide by design.
 */
export function resolveBrowsePrefix(raw, configuredPrefix) {
  const root = normalizePrefix(configuredPrefix);
  const requested = sanitizeBrowsePrefix(raw);
  const target = requested === "" ? root : requested;

  if (root !== "" && !target.startsWith(root)) {
    throw new KeyError(`Folder path must be under "${root}"`);
  }
  return target;
}

export class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "KeyError";
  }
}
