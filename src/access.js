// Cloudflare Access JWT verification.
//
// Enabling Access on the Worker's route gates the browser, but a request sent
// straight to <worker>.workers.dev bypasses it entirely. So the Worker itself
// must verify the Cf-Access-Jwt-Assertion header that Access injects.

import { createRemoteJWKSet, jwtVerify } from "jose";

// createRemoteJWKSet caches the key set internally, so this is not a fetch per
// request. Cached per team domain across invocations in the same isolate.
const jwksCache = new Map();

function getJwks(teamDomain) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Verify the Access JWT on a request.
 *
 * Returns { email, sub } on success. Throws AccessError otherwise.
 * When REQUIRE_ACCESS is not "true", returns a local-dev identity instead —
 * this exists so `wrangler dev` works, and must never be set in production.
 */
export async function verifyAccessJwt(request, env) {
  if (env.REQUIRE_ACCESS !== "true") {
    return { email: "local-dev@example.invalid", sub: "local-dev" };
  }

  const teamDomain = (env.TEAM_DOMAIN || "").replace(/\/+$/, "");
  if (!teamDomain || !env.POLICY_AUD) {
    // Fail closed: misconfiguration must not silently disable auth.
    throw new AccessError(
      "Server misconfigured: TEAM_DOMAIN and POLICY_AUD must be set when REQUIRE_ACCESS is true",
      500,
    );
  }

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    getCookie(request, "CF_Authorization");

  if (!token) {
    throw new AccessError("Missing Cloudflare Access token", 403);
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: teamDomain,
      audience: env.POLICY_AUD,
    });
    return {
      email: payload.email || payload.common_name || payload.sub || "unknown",
      sub: payload.sub || "unknown",
    };
  } catch (err) {
    throw new AccessError(`Invalid Cloudflare Access token: ${err.message}`, 403);
  }
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

export class AccessError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = "AccessError";
    this.status = status;
  }
}
