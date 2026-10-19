import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Hex } from "@docops/core";

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

// ---------------------------------------------------------------------------- short-lived access tokens (HS256)

export interface AccessClaims {
  iss: string;
  sub: string; // service account id
  tid: string; // tenant id
  scp: string[];
  repo?: string | undefined; // repository the token is bound to (CI tokens)
  env?: string | undefined; // deployment environments allowed
  exp: number;
  iat: number;
}

export function issueAccessToken(secret: string, claims: Omit<AccessClaims, "iat" | "exp" | "iss">, ttlSeconds = 900): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ ...claims, iss: "docops", iat: now, exp: now + ttlSeconds }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyAccessToken(secret: string, token: string): AccessClaims | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const head = JSON.parse(fromB64url(header).toString()) as { alg?: string };
    if (head.alg !== "HS256") return null;
    const claims = JSON.parse(fromB64url(payload).toString()) as AccessClaims;
    if (claims.iss !== "docops" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- CI OIDC (RS256 / ES256 against a JWKS)

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  [k: string]: unknown;
}
/** An issuer's signing keys. `refresh` is set when a token names a key the last answer lacked (a rotation). */
export type JwksFetcher = (issuer: string, request?: { refresh?: boolean }) => Promise<{ keys: Jwk[] }>;

/** Default fetcher: OIDC discovery → jwks_uri. Issuers are allowlisted by trust policies before this runs. */
export const fetchJwks: JwksFetcher = async (issuer) => {
  const discovery = (await (await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
  return (await (await fetch(discovery.jwks_uri)).json()) as { keys: Jwk[] };
};

/** The issuer's signing keys could not be fetched, so the token was neither accepted nor rejected. */
export class JwksUnavailableError extends Error {
  constructor(issuer: string, cause: unknown) {
    super(`signing keys of ${issuer} are unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "JwksUnavailableError";
  }
}

/**
 * Cache a fetcher's answer per issuer for `ttlSeconds`. Concurrent misses share one request, and a failed
 * request is not kept. `refresh` refetches at most every `minRefreshSeconds`, so tokens that name made-up
 * key IDs cannot turn every request into a fetch.
 */
export function cachedJwks(fetcher: JwksFetcher, options: { ttlSeconds?: number; minRefreshSeconds?: number; now?: () => number } = {}): JwksFetcher {
  const ttl = (options.ttlSeconds ?? 600) * 1000;
  const minRefresh = (options.minRefreshSeconds ?? 30) * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { keys: Promise<{ keys: Jwk[] }>; fetchedAt: number }>();
  return (issuer, request) => {
    const cached = cache.get(issuer);
    const age = cached ? now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
    if (cached && age < ttl && !(request?.refresh === true && age >= minRefresh)) return cached.keys;
    const entry = { keys: fetcher(issuer), fetchedAt: now() };
    cache.set(issuer, entry);
    entry.keys.catch(() => {
      if (cache.get(issuer) === entry) cache.delete(issuer);
    });
    return entry.keys;
  };
}

export interface VerifiedJwt {
  header: { alg: string; kid?: string };
  claims: Record<string, unknown>;
}

export async function verifyOidcToken(
  token: string,
  options: { issuer: string; audience: string; jwks: JwksFetcher; clockSkewSeconds?: number; algorithms?: readonly string[] },
): Promise<VerifiedJwt> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed token");
  const header = JSON.parse(fromB64url(h).toString()) as { alg: string; kid?: string };
  if (!(options.algorithms ?? ["RS256", "ES256"]).includes(header.alg)) throw new Error(`unsupported alg ${header.alg}`);
  const claims = JSON.parse(fromB64url(p).toString()) as Record<string, unknown>;
  if (claims.iss !== options.issuer) throw new Error("issuer mismatch");
  const findKey = async (refresh: boolean): Promise<Jwk | undefined> => {
    let keys: Jwk[];
    try {
      keys = (await options.jwks(options.issuer, { refresh })).keys;
      if (!Array.isArray(keys)) throw new Error("the key set has no keys");
    } catch (error) {
      throw new JwksUnavailableError(options.issuer, error);
    }
    return keys.find((k) => (header.kid ? k.kid === header.kid : true));
  };
  // A key ID the set lacks may be a rotation: ask again, which lets a caching fetcher go back to the issuer.
  const jwk = (await findKey(false)) ?? (header.kid ? await findKey(true) : undefined);
  if (!jwk) throw new Error("signing key not found");
  if (jwk.kty !== (header.alg === "ES256" ? "EC" : "RSA")) throw new Error(`signing key type ${jwk.kty} does not match alg ${header.alg}`);
  const key = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, fromB64url(s));
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  const aud = claims.aud;
  if (!(Array.isArray(aud) ? aud.includes(options.audience) : aud === options.audience)) throw new Error("audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new Error("token expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new Error("token not yet valid");
  return { header, claims };
}

/** Trust policy (docs/04-api-design.md §2): pinned immutable claims + per-rule grants. */
export interface CiTrustPolicy {
  provider: string;
  issuer: string;
  audience: string;
  claims: Record<string, string>;
  rules: Array<{ match: Record<string, string>; grant: string[]; environments?: string[] }>;
}

export function evaluateTrustPolicies(policies: readonly CiTrustPolicy[], issuer: string, claims: Record<string, unknown>): { scopes: string[]; environments: string[]; repository: string | undefined } | null {
  for (const policy of policies) {
    if (policy.issuer !== issuer) continue;
    if (!Object.entries(policy.claims).every(([k, v]) => String(claims[k] ?? "") === v)) continue;
    const scopes = new Set<string>();
    const environments = new Set<string>();
    for (const rule of policy.rules) {
      if (!Object.entries(rule.match).every(([k, v]) => String(claims[k] ?? "") === v)) continue;
      rule.grant.forEach((g) => scopes.add(g));
      (rule.environments ?? []).forEach((e) => environments.add(e));
    }
    if (scopes.size > 0) return { scopes: [...scopes], environments: [...environments], repository: typeof claims.repository === "string" ? claims.repository : undefined };
  }
  return null;
}

// ---------------------------------------------------------------------------- Forge Invocation Tokens (RS256 against Atlassian's JWKS)
//
// Claim names and values follow Atlassian's Forge Remote documentation (checked 2026-10-19):
// developer.atlassian.com/platform/forge/remote/essentials/ and .../forge-remote-invocation-contract.

/** `iss` of every Forge Invocation Token (FIT). */
export const FORGE_FIT_ISSUER = "forge/invocation-token";
/** Atlassian's FIT signing keys (RSA, `alg` RS256, one `kid` each). Isolated Cloud tokens use other hosts and are not accepted. */
export const FORGE_JWKS_URL = "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json";
/** A FIT lives for seconds (Atlassian's example expires 25 s after `iat`), so the clock skew allowed is small too. */
export const FORGE_CLOCK_SKEW_SECONDS = 30;

/** The default FIT key source: Atlassian's JWKS, cached (the issuer is not a URL, so there is no discovery). */
export const fetchForgeJwks: JwksFetcher = cachedJwks(async () => {
  const response = await fetch(FORGE_JWKS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${FORGE_JWKS_URL} answered HTTP ${response.status}`);
  return (await response.json()) as { keys: Jwk[] };
});

const INSTALLATION_ARI_PREFIX = "ari:cloud:ecosystem::installation/";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `tenant_routes` key (kind `forge_installation`) of a Forge installation: its UUID, in lower case.
 * A FIT carries the installation ARI (`app.installationId`, `ari:cloud:ecosystem::installation/<uuid>`),
 * while the app's admin page shows the bare UUID (`getAppContext().installationAri.installationId`), so
 * both forms are accepted. Anything else is null.
 */
export function forgeInstallationKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.startsWith(INSTALLATION_ARI_PREFIX) ? value.slice(INSTALLATION_ARI_PREFIX.length) : value;
  return UUID_PATTERN.test(id) ? id.toLowerCase() : null;
}

/** What DocOps uses from a verified FIT. */
export interface ForgeInvocation {
  /** `app.installationId`, as a `tenant_routes` key (forgeInstallationKey). */
  installationId: string;
  /** `jti`: the replay-cache key, and the delivery ID of trigger calls (docs/04 §5). */
  tokenId: string;
  /** `exp`, in seconds since the epoch. */
  expiresAt: number;
}

/**
 * Verify a FIT (docs/06 §3, threat T04): an RS256 signature by a key in Atlassian's JWKS,
 * `iss = forge/invocation-token`, `aud` = the app ARI, `exp` (and `nbf`) with FORGE_CLOCK_SKEW_SECONDS
 * of skew, a `jti` and an installation. The replay cache and the installation → tenant mapping need
 * the database, so the caller checks them (authenticateForgeInvocation in auth.ts).
 */
export async function verifyForgeInvocationToken(token: string, options: { appId: string; jwks: JwksFetcher; clockSkewSeconds?: number }): Promise<ForgeInvocation> {
  const { claims } = await verifyOidcToken(token, {
    issuer: FORGE_FIT_ISSUER,
    audience: options.appId,
    jwks: options.jwks,
    algorithms: ["RS256"],
    clockSkewSeconds: options.clockSkewSeconds ?? FORGE_CLOCK_SKEW_SECONDS,
  });
  const app = (claims.app ?? {}) as { installationId?: unknown };
  const installationId = forgeInstallationKey(app.installationId);
  if (!installationId) throw new Error("app.installationId is missing or malformed");
  if (typeof claims.jti !== "string" || claims.jti === "" || claims.jti.length > 256) throw new Error("jti is missing or malformed");
  return { installationId, tokenId: claims.jti, expiresAt: claims.exp as number };
}

// ---------------------------------------------------------------------------- build signing (Ed25519) and preview links

export class BuildSigner {
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: string;

  constructor(privateKeyPem?: string) {
    if (privateKeyPem) {
      this.privateKey = createPrivateKey(privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync("ed25519");
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    this.keyId = sha256Hex(this.publicKey.export({ type: "spki", format: "der" })).slice(0, 16);
  }

  /** Sign the manifest digest; the signature binds build identity to content. */
  sign(manifestDigest: string): string {
    return `ed25519:${this.keyId}:${sign(null, Buffer.from(manifestDigest), this.privateKey).toString("base64url")}`;
  }

  verify(manifestDigest: string, signature: string | null): boolean {
    const [alg, kid, sig] = (signature ?? "").split(":");
    if (alg !== "ed25519" || kid !== this.keyId || !sig) return false;
    return verify(null, Buffer.from(manifestDigest), this.publicKey, fromB64url(sig));
  }
}

/** Canonical manifest digest: sha256(JCS(files sorted by path)). */
export function manifestDigest(files: ReadonlyArray<{ path: string; digest: string; size: number; contentType: string }>): string {
  return sha256Hex(canonicalJson([...files].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, digest, size, contentType }) => ({ path, digest, size, contentType }))));
}

/** Unguessable, expiring preview link token bound to tenant/space/environment (threat T15). */
export function previewToken(secret: string, scope: string, ttlSeconds = 30 * 86_400): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${exp}.${createHmac("sha256", secret).update(`${scope}|${exp}`).digest("base64url")}`;
}

export function verifyPreviewToken(secret: string, scope: string, token: string | undefined): boolean {
  const [expText, mac] = (token ?? "").split(".");
  const exp = Number(expText);
  if (!mac || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${scope}|${exp}`).digest("base64url"));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
