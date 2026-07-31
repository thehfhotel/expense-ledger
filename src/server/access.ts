// Auth for Expense Ledger. Adapted from income-ledger's src/server/auth.ts
// (same estate pattern — see /Users/nut/income-ledger).
//
// identify(req) resolves the caller to an Identity or null:
//   - development ONLY (NODE_ENV === "development"): DEV_USER env bypass.
//     Any other NODE_ENV value ignores DEV_USER — fails closed.
//   - else: verify the `cf-access-jwt-assertion` header (RS256, JWKS cached
//     1h, iss/aud/exp/nbf).
//
// For requests that arrive over Cloudflare Access (the public hostname),
// Cloudflare has already decided who reaches this process before the
// request lands here, and this check is a second, redundant layer. BUT for
// LAN-path requests — the frontend's docker-compose.yml host-port mapping
// (HOST_PORT:3000) is reachable directly by any device already on the LAN,
// which never touches Cloudflare at all — this check is the ONLY gate.
// identify() only resolves WHO the caller is (for provenance on whatever
// writes the frontend ends up doing), never what they may do; there is no
// authorization decision here to fall back on if the identity check itself
// is weak.
//
// Because of the LAN-path case above, ACCESS_AUD MUST be non-empty in
// production: with it unset, verifyAccessJwt skips the aud check entirely,
// so a valid Cloudflare Access JWT issued for ANY app under the team domain
// (not just this one) would pass identify() here. issuer/signature/expiry
// are still verified either way.
//
// Dormant-when-unset: with no `cf-access-jwt-assertion` header (e.g. a
// direct request that never went through Access) identify() simply returns
// null — callers decide whether that 401s. ACCESS_TEAM_DOMAIN falls back to
// the estate's default team domain regardless of ACCESS_AUD.

export interface Identity {
  email: string;
}

type Json = Record<string, any>;

const TEAM_DOMAIN = () => process.env.ACCESS_TEAM_DOMAIN || "laikaexpress.cloudflareaccess.com";

// ── base64url helpers ──────────────────────────────────────────────────
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(s, "base64url"));
const b64urlJson = (s: string): Json => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// ── Cloudflare Access JWT (RS256) ────────────────────────────────────────
let jwksCache: { at: number; keys: Json[] } | undefined;
async function jwksKeys(): Promise<Json[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(`https://${TEAM_DOMAIN()}/cdn-cgi/access/certs`);
  const data = (await res.json()) as Json;
  jwksCache = { at: Date.now(), keys: (data.keys ?? []) as Json[] };
  return jwksCache.keys;
}

/** Verify a CF Access JWT; returns its payload or null. */
export async function verifyAccessJwt(token: string): Promise<Json | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: Json, payload: Json;
  try {
    header = b64urlJson(h!);
    payload = b64urlJson(p!);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const key = (await jwksKeys()).find((k) => k.kid === header.kid);
  if (!key) return null;
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    fromB64url(s!),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (payload.iss !== `https://${TEAM_DOMAIN()}`) return null;
  const wantAud = (process.env.ACCESS_AUD || "")
    .split(",")
    .map((s2) => s2.trim())
    .filter(Boolean);
  if (wantAud.length) {
    const got = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!got.some((a: string) => wantAud.includes(a))) return null;
  }
  return payload;
}

export async function identify(req: Request): Promise<Identity | null> {
  if (process.env.NODE_ENV === "development" && process.env.DEV_USER) {
    return { email: process.env.DEV_USER.toLowerCase() };
  }

  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;
  const payload = await verifyAccessJwt(jwt);
  if (!payload?.email) return null;
  return { email: String(payload.email).toLowerCase() };
}
