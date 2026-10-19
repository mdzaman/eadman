import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "hono";
import { badRequest, can, DocOpsError, forbidden, hasScope, sha256Hex, unauthorized, type Permission, type ResourceScope, type RoleBinding, type TokenScope } from "@docops/core";
import { appendAudit, type AuditInput, type Queryable, type SqlClient, withTenant } from "@docops/db";
import type { JiraClient } from "@docops/jira";
import type { BuildSigner, CiTrustPolicy, JwksFetcher } from "./security.ts";

export interface Principal {
  tenantId: string;
  tenantSlug: string;
  principalType: "user" | "service_account";
  principalId: string;
  scopes: string[];
  bindings: RoleBinding[];
  authMethod: "api_token" | "ci_oidc" | "forge_fit";
  /** For CI tokens: the repository the token is bound to. */
  repository?: string | undefined;
  environments?: string[] | undefined;
}

export interface AppConfig {
  publicUrl: string;
  cell: string;
  tokenSigningSecret: string;
  previewSecret: string;
  githubWebhookSecret?: string | undefined;
  jiraWebhookSecret?: string | undefined;
  /** Audience expected in CI OIDC tokens. */
  oidcAudience: string;
  /** ARI of the Jira Forge app (`app.id` in its manifest): the `aud` of its Forge Invocation Tokens. Unset: FITs are refused. */
  forgeAppId?: string | undefined;
  maxBlobBytes: number;
}

export interface AppDeps {
  db: SqlClient;
  blobs: BlobStore;
  signer: BuildSigner;
  config: AppConfig;
  /** Tracker client for a tenant (null when the tenant has no Jira integration). */
  jira?: ((tenantId: string) => JiraClient | null) | undefined;
  /** Signing keys by issuer, for CI OIDC tokens and FITs. Unset: OIDC discovery, and Atlassian's JWKS for FITs. */
  jwks?: JwksFetcher | undefined;
  /** CI trust policies per tenant (from tenant settings in production). */
  trustPolicies?: ((tenantSlug: string) => Promise<CiTrustPolicy[]>) | undefined;
  version: string;
}

export type Env = { Variables: { principal: Principal; requestId: string; deps: AppDeps } };
export type Ctx = Context<Env>;

// ---------------------------------------------------------------------------- authorization

/** Effective permission = token scope (what the credential may do) ∩ role binding (what the principal can do). */
export function requireAccess(c: Ctx, scope: TokenScope, permission: Permission, resource: ResourceScope = {}): Principal {
  const principal = c.get("principal");
  if (!principal) throw unauthorized();
  if (!hasScope(principal.scopes, scope)) throw forbidden(`Token lacks the ${scope} scope`);
  if (!can(principal.bindings, permission, resource)) throw forbidden(`Missing permission ${permission}`);
  return principal;
}

export function actorOf(p: Principal): AuditInput["actor"] {
  return { type: p.principalType, id: `${p.principalType}:${p.principalId}`, authMethod: p.authMethod };
}

export async function inTenant<T>(c: Ctx, fn: (tx: Queryable, p: Principal) => Promise<T>): Promise<T> {
  const principal = c.get("principal");
  if (!principal) throw unauthorized();
  return withTenant(c.get("deps").db, principal.tenantId, (tx) => fn(tx, principal));
}

export async function audit(tx: Queryable, c: Ctx, input: Omit<AuditInput, "actor" | "requestId"> & { actor?: AuditInput["actor"] }): Promise<void> {
  const principal = c.get("principal");
  await appendAudit(tx, principal.tenantId, {
    ...input,
    actor: input.actor ?? { ...actorOf(principal), ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: c.req.header("user-agent") ?? null },
    requestId: c.get("requestId"),
    traceId: c.req.header("traceparent")?.split("-")[1] ?? null,
  });
}

// ---------------------------------------------------------------------------- request helpers

export async function jsonBody<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  try {
    const body = (await c.req.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as T;
  } catch {
    throw badRequest("Request body must be a JSON object");
  }
}

export function str(body: Record<string, unknown>, field: string, options: { required?: boolean; pattern?: RegExp; max?: number } = {}): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") {
    if (options.required) throw badRequest(`${field} is required`, [{ pointer: `/${field}`, message: "is required" }]);
    return undefined;
  }
  if (typeof value !== "string") throw badRequest(`${field} must be a string`, [{ pointer: `/${field}`, message: "must be a string" }]);
  if (options.max && value.length > options.max) throw badRequest(`${field} is too long`, [{ pointer: `/${field}`, message: `must be at most ${options.max} characters` }]);
  if (options.pattern && !options.pattern.test(value)) throw badRequest(`${field} has an invalid format`, [{ pointer: `/${field}`, message: `must match ${options.pattern}` }]);
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw badRequest(`${field} must be one of ${allowed.join(", ")}`, [{ pointer: `/${field}`, message: `must be one of ${allowed.join(", ")}` }]);
}

export function uuidParam(c: Ctx, name: string): string {
  const value = c.req.param(name) ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DocOpsError("not_found", "Resource not found", 404);
  return value;
}

export interface PageParams {
  after: string | null;
  limit: number;
}

export function pageParams(c: Ctx): PageParams {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const cursor = c.req.query("cursor");
  let after: string | null = null;
  if (cursor) {
    try {
      after = Buffer.from(cursor, "base64url").toString();
    } catch {
      throw badRequest("invalid cursor");
    }
    if (!/^[0-9a-f-]{36}$/.test(after)) throw badRequest("invalid cursor");
  }
  return { after, limit };
}

export function nextCursor<T extends { id: string }>(rows: readonly T[], limit: number): string | null {
  return rows.length === limit ? Buffer.from(rows[rows.length - 1]!.id).toString("base64url") : null;
}

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------- blob store (content-addressed, tenant-scoped)

export interface BlobStore {
  put(tenantId: string, digest: string, bytes: Uint8Array): Promise<void>;
  get(tenantId: string, digest: string): Promise<Uint8Array | null>;
  putJson(key: string, value: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
}

/** Filesystem CAS (object storage in production). Digests are verified before anything is stored. */
/**
 * Write to a temporary sibling, then rename over the target: a reader (another replica on a shared
 * volume) never sees a partial file, and a crash mid-write leaves only a stray `.tmp` behind.
 */
async function writeAtomically(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export class FsBlobStore implements BlobStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  private path(tenantId: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest) || !/^[0-9a-f-]{36}$/.test(tenantId)) throw badRequest("invalid digest");
    return join(this.root, "cas", tenantId, digest.slice(0, 2), digest);
  }
  async put(tenantId: string, digest: string, bytes: Uint8Array): Promise<void> {
    if (sha256Hex(bytes) !== digest) throw badRequest("content does not match its sha256 digest");
    await writeAtomically(this.path(tenantId, digest), bytes);
  }
  async get(tenantId: string, digest: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(tenantId, digest)));
    } catch {
      return null;
    }
  }
  async putJson(key: string, value: unknown): Promise<void> {
    await writeAtomically(join(this.root, "json", `${key.replace(/[^\w/.-]/g, "_")}.json`), JSON.stringify(value));
  }
  async getJson<T>(key: string): Promise<T | null> {
    const path = join(this.root, "json", `${key.replace(/[^\w/.-]/g, "_")}.json`);
    try {
      await stat(path);
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return null;
    }
  }
}
