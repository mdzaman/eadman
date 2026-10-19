import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, cloudEvent, sha256Hex, uuidv7, type CloudEvent } from "@docops/core";
import type { Queryable } from "./client.ts";

// ---------------------------------------------------------------------------- tenants & routing

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  region: string;
  ai_enabled: boolean;
}

export async function createTenant(tx: Queryable, input: { slug: string; name: string; region?: string }): Promise<TenantRow> {
  const id = uuidv7();
  const { rows } = await tx.query<TenantRow>(
    "INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, $3, $4) RETURNING id, slug, name, region, ai_enabled",
    [id, input.slug, input.name, input.region ?? "us"],
  );
  return rows[0] as TenantRow;
}

export async function getTenant(tx: Queryable, id: string): Promise<TenantRow | null> {
  const { rows } = await tx.query<TenantRow>("SELECT id, slug, name, region, ai_enabled FROM tenants WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function getTenantBySlug(tx: Queryable, slug: string): Promise<TenantRow | null> {
  const { rows } = await tx.query<TenantRow>("SELECT id, slug, name, region, ai_enabled FROM tenants WHERE slug = $1", [slug]);
  return rows[0] ?? null;
}

export type RouteKind = "github_installation" | "gitlab_group" | "jira_cloud" | "jira_dc" | "custom_domain" | "forge_installation";

export async function addTenantRoute(tx: Queryable, kind: RouteKind, externalKey: string, tenantId: string): Promise<void> {
  await tx.query("INSERT INTO tenant_routes (kind, external_key, tenant_id) VALUES ($1, $2, $3) ON CONFLICT (kind, external_key) DO UPDATE SET tenant_id = EXCLUDED.tenant_id", [kind, externalKey, tenantId]);
}

export async function resolveTenantRoute(tx: Queryable, kind: RouteKind, externalKey: string): Promise<string | null> {
  const { rows } = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM tenant_routes WHERE kind = $1 AND external_key = $2", [kind, externalKey]);
  return rows[0]?.tenant_id ?? null;
}

// ---------------------------------------------------------------------------- API tokens

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateTokenSecret(): string {
  const bytes = randomBytes(32);
  let out = "dop_";
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

export function hashToken(secret: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

export interface TokenPrincipal {
  tokenId: string;
  tenantId: string;
  principalType: "user" | "service_account";
  principalId: string;
  scopes: string[];
}

/** Tenant-scoped insert (call inside withTenant). Returns the secret once. */
export async function createApiToken(
  tx: Queryable,
  input: { tenantId: string; principalType: "user" | "service_account"; principalId: string; name: string; scopes: string[]; expiresInDays?: number; secret?: string },
): Promise<{ id: string; secret: string; prefix: string; expiresAt: string | null }> {
  const secret = input.secret ?? generateTokenSecret();
  const id = uuidv7();
  const prefix = secret.slice(0, 8);
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
  await tx.query(
    `INSERT INTO api_tokens (id, tenant_id, principal_type, principal_id, name, token_hash, token_prefix, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9)`,
    [id, input.tenantId, input.principalType, input.principalId, input.name, hashToken(secret), prefix, input.scopes, expiresAt],
  );
  return { id, secret, prefix, expiresAt };
}

/** Pre-tenant lookup through the SECURITY DEFINER function (no cross-tenant SELECT for the app role). */
export async function lookupApiToken(tx: Queryable, secret: string): Promise<TokenPrincipal | null> {
  if (!/^dop_[A-Za-z0-9]{20,}$/.test(secret)) return null;
  const { rows } = await tx.query<{ token_id: string; tenant_id: string; principal_type: "user" | "service_account"; principal_id: string; scopes: string[]; expires_at: Date | null; revoked_at: Date | null }>(
    "SELECT * FROM auth_lookup_api_token($1)",
    [hashToken(secret)],
  );
  const row = rows[0];
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() < Date.now())) return null;
  return { tokenId: row.token_id, tenantId: row.tenant_id, principalType: row.principal_type, principalId: row.principal_id, scopes: row.scopes };
}

export async function ensureServiceAccount(tx: Queryable, tenantId: string, name: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO service_accounts (id, tenant_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [uuidv7(), tenantId, name],
  );
  return rows[0]?.id as string;
}

// ---------------------------------------------------------------------------- audit (hash chain)

export interface AuditInput {
  actor: { type: "user" | "service_account" | "system" | "ai"; id: string; display?: string | null; ip?: string | null; userAgent?: string | null; authMethod?: string | null };
  action: string;
  resource: { type: string; id?: string | null };
  outcome: "success" | "failure" | "denied";
  reason?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditRecord extends AuditInput {
  id: string;
  tenantId: string;
  seq: number;
  occurredAt: string;
  prevHash: string;
  hash: string;
}

export function auditGenesis(tenantId: string): string {
  return sha256Hex(`docops:audit:v1:${tenantId}`);
}

/** hash_n = SHA-256(prev_hash || JCS(event without hashes)) (docs/08-security-compliance.md §4.3). */
export function auditHash(prevHash: string, event: Omit<AuditRecord, "hash" | "prevHash">): string {
  return createHash("sha256").update(Buffer.from(prevHash, "hex")).update(canonicalJson(event)).digest("hex");
}

export async function appendAudit(tx: Queryable, tenantId: string, input: AuditInput): Promise<AuditRecord> {
  // Serialize appends per tenant through the chain head row.
  await tx.query(
    "INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash) VALUES ($1, 0, decode($2, 'hex')) ON CONFLICT (tenant_id) DO NOTHING",
    [tenantId, auditGenesis(tenantId)],
  );
  const { rows } = await tx.query<{ last_seq: string | number; last_hash: string }>(
    "SELECT last_seq, encode(last_hash, 'hex') AS last_hash FROM audit_chain_heads WHERE tenant_id = $1 FOR UPDATE",
    [tenantId],
  );
  const head = rows[0];
  const seq = Number(head?.last_seq ?? 0) + 1;
  const prevHash = head?.last_hash ?? auditGenesis(tenantId);
  // Normalize the IP exactly as Postgres will return it, so the hash verifies after a round trip.
  const ip = input.actor.ip ? ((await tx.query<{ ip: string }>("SELECT host($1::inet) AS ip", [input.actor.ip])).rows[0]?.ip ?? null) : null;
  const event = {
    id: uuidv7(),
    tenantId,
    seq,
    occurredAt: new Date().toISOString(),
    actor: { display: null, userAgent: null, authMethod: null, ...input.actor, ip },
    action: input.action,
    resource: { id: null, ...input.resource },
    outcome: input.outcome,
    reason: input.reason ?? null,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    details: input.details ?? {},
  };
  const hash = auditHash(prevHash, event);
  await tx.query(
    `INSERT INTO audit_events (tenant_id, seq, id, occurred_at, actor_type, actor_id, actor_display, actor_ip, user_agent, auth_method,
       action, resource_type, resource_id, outcome, reason, request_id, trace_id, details, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inet,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,decode($19,'hex'),decode($20,'hex'))`,
    [
      tenantId, seq, event.id, event.occurredAt, event.actor.type, event.actor.id, event.actor.display, event.actor.ip, event.actor.userAgent,
      event.actor.authMethod, event.action, event.resource.type, event.resource.id, event.outcome, event.reason, event.requestId,
      event.traceId, JSON.stringify(event.details), prevHash, hash,
    ],
  );
  await tx.query("UPDATE audit_chain_heads SET last_seq = $2, last_hash = decode($3, 'hex') WHERE tenant_id = $1", [tenantId, seq, hash]);
  return { ...event, prevHash, hash } as AuditRecord;
}

interface AuditRow {
  tenant_id: string;
  seq: string | number;
  id: string;
  occurred_at: Date | string;
  actor_type: AuditInput["actor"]["type"];
  actor_id: string;
  actor_display: string | null;
  actor_ip: string | null;
  user_agent: string | null;
  auth_method: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: AuditInput["outcome"];
  reason: string | null;
  request_id: string | null;
  trace_id: string | null;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

function toRecord(r: AuditRow): AuditRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    occurredAt: new Date(r.occurred_at).toISOString(),
    actor: { type: r.actor_type, id: r.actor_id, display: r.actor_display, ip: r.actor_ip, userAgent: r.user_agent, authMethod: r.auth_method },
    action: r.action,
    resource: { type: r.resource_type, id: r.resource_id },
    outcome: r.outcome,
    reason: r.reason,
    requestId: r.request_id,
    traceId: r.trace_id,
    details: r.details ?? {},
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

export async function listAudit(
  tx: Queryable,
  filters: { action?: string; actorId?: string; resourceType?: string; since?: string; until?: string; afterSeq?: number; limit?: number },
): Promise<AuditRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.action) add("action = ?", filters.action);
  if (filters.actorId) add("actor_id = ?", filters.actorId);
  if (filters.resourceType) add("resource_type = ?", filters.resourceType);
  if (filters.since) add("occurred_at >= ?", filters.since);
  if (filters.until) add("occurred_at < ?", filters.until);
  if (filters.afterSeq) add("seq > ?", filters.afterSeq);
  params.push(Math.min(filters.limit ?? 50, 200));
  const { rows } = await tx.query<AuditRow>(
    `SELECT tenant_id, seq, id, occurred_at, actor_type, actor_id, actor_display, host(actor_ip) AS actor_ip, user_agent, auth_method, action,
            resource_type, resource_id, outcome, reason, request_id, trace_id, details,
            encode(prev_hash, 'hex') AS prev_hash, encode(hash, 'hex') AS hash
     FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toRecord);
}

/** Recompute the chain over consecutive records; returns the first broken seq or null. */
export function verifyAuditChain(records: readonly AuditRecord[]): number | null {
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as AuditRecord;
    const { hash, prevHash, ...event } = r;
    if (i > 0 && (records[i - 1] as AuditRecord).seq === r.seq - 1 && (records[i - 1] as AuditRecord).hash !== prevHash) return r.seq;
    if (r.seq === 1 && prevHash !== auditGenesis(r.tenantId)) return r.seq;
    if (auditHash(prevHash, event) !== hash) return r.seq;
  }
  return null;
}

// ---------------------------------------------------------------------------- outbox, jobs, idempotency

export async function writeOutbox(tx: Queryable, event: CloudEvent, partitionKey: string): Promise<void> {
  await tx.query("INSERT INTO outbox (tenant_id, event_type, partition_key, event) VALUES ($1, $2, $3, $4::jsonb)", [
    event.tenantid,
    event.type,
    partitionKey,
    JSON.stringify(event),
  ]);
}

export function event<T>(tenantId: string, type: string, data: T, subject?: string): CloudEvent<T> {
  return cloudEvent(type, data, { tenantId, subject, source: `docops://cells/${process.env.DOCOPS_CELL ?? "local"}/api` });
}

export interface JobRow {
  id: string;
  tenant_id: string | null;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  traceparent: string | null;
}

export async function enqueueJob(
  tx: Queryable,
  input: { tenantId: string | null; queue: string; payload: Record<string, unknown>; priority?: number; coalesceKey?: string; runAfter?: Date; traceparent?: string },
): Promise<string | null> {
  const id = uuidv7();
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO jobs (id, tenant_id, queue, payload, priority, coalesce_key, run_after, traceparent)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, COALESCE($7::timestamptz, now()), $8)
     ON CONFLICT (queue, coalesce_key) WHERE status = 'queued' AND coalesce_key IS NOT NULL
     DO UPDATE SET payload = EXCLUDED.payload, run_after = EXCLUDED.run_after
     RETURNING id`,
    [id, input.tenantId, input.queue, JSON.stringify(input.payload), input.priority ?? 100, input.coalesceKey ?? null, input.runAfter?.toISOString() ?? null, input.traceparent ?? null],
  );
  return rows[0]?.id ?? null;
}

/** Claim ready jobs with FOR UPDATE SKIP LOCKED (safe with many workers). */
export async function claimJobs(tx: Queryable, queues: readonly string[], workerId: string, limit = 10, leaseSeconds = 300): Promise<JobRow[]> {
  const { rows } = await tx.query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $3, locked_until = now() + make_interval(secs => $4)
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'queued' AND queue = ANY($1::text[]) AND run_after <= now()
       ORDER BY priority, run_after
       LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING id, tenant_id, queue, payload, attempts, max_attempts, traceparent`,
    [queues, limit, workerId, leaseSeconds],
  );
  return rows;
}

export async function completeJob(tx: Queryable, id: string): Promise<void> {
  await tx.query("UPDATE jobs SET status = 'succeeded', finished_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1", [id]);
}

/** Exponential backoff with jitter: 1s, 2s, 4s … capped at 15 min; dead-letter after max attempts. */
export async function failJob(tx: Queryable, job: JobRow, error: string): Promise<"retry" | "dead"> {
  if (job.attempts >= job.max_attempts) {
    await tx.query("UPDATE jobs SET status = 'dead', last_error = $2, finished_at = now(), locked_by = NULL WHERE id = $1", [job.id, error.slice(0, 2000)]);
    return "dead";
  }
  const delayMs = Math.min(900_000, 1000 * 2 ** (job.attempts - 1)) * (0.8 + Math.random() * 0.4);
  await tx.query("UPDATE jobs SET status = 'queued', last_error = $2, run_after = now() + make_interval(secs => $3), locked_by = NULL, locked_until = NULL WHERE id = $1", [
    job.id,
    error.slice(0, 2000),
    delayMs / 1000,
  ]);
  return "retry";
}

/** Requeue jobs whose lease expired (crashed workers). */
export async function reapExpiredJobs(tx: Queryable): Promise<number> {
  const { rows } = await tx.query<{ id: string }>("UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL WHERE status = 'running' AND locked_until < now() RETURNING id");
  return rows.length;
}

/** Event type -> internal queues for the outbox relay (embedded mode). */
export const OUTBOX_ROUTES: Record<string, string[]> = {
  "docops.git.pull_request": ["tracker.link"],
  "docops.git.push": ["content.index"],
  "docops.tracker.issue_updated": ["tracker.mirror"],
  "docops.ticket.links_changed": ["tracker.sync"],
  "docops.deployment.promoted": ["tracker.sync"],
};

/** Public event catalog (api/openapi.yaml `webhooks`): also delivered to subscribers. */
export const PUBLIC_EVENTS = new Set([
  "docops.page.published",
  "docops.build.succeeded",
  "docops.build.failed",
  "docops.preview.ready",
  "docops.deployment.promoted",
  "docops.check.completed",
  "docops.drift.detected",
  "docops.suggestion.created",
  "docops.suggestion.decided",
  "docops.ticket.docs_status_changed",
  "docops.release.readiness_changed",
  "docops.page.stale",
]);

/** Move unpublished outbox rows into the job queue (embedded mode relay). */
export async function relayOutbox(tx: Queryable, limit = 100): Promise<number> {
  const { rows } = await tx.query<{ id: string; tenant_id: string | null; event_type: string; partition_key: string; event: CloudEvent }>(
    "SELECT id, tenant_id, event_type, partition_key, event FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED",
    [limit],
  );
  for (const row of rows) {
    const prefix = Object.keys(OUTBOX_ROUTES).find((k) => row.event_type === k || row.event_type.startsWith(`${k}.`));
    const queues = [...(prefix ? (OUTBOX_ROUTES[prefix] ?? []) : []), ...(PUBLIC_EVENTS.has(row.event_type) ? ["notify.webhooks"] : [])];
    for (const queue of queues) {
      await enqueueJob(tx, { tenantId: row.tenant_id, queue, payload: { event: row.event }, traceparent: row.event.traceparent });
    }
    await tx.query("UPDATE outbox SET published_at = now() WHERE id = $1", [row.id]);
  }
  return rows.length;
}

/** Idempotency ledger: true the first time (consumer, eventId) is seen. */
export async function markProcessed(tx: Queryable, consumer: string, eventId: string): Promise<boolean> {
  const { rows } = await tx.query<{ consumer: string }>(
    "INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING consumer",
    [consumer, eventId],
  );
  return rows.length === 1;
}

/** Record an inbound webhook delivery; returns "duplicate" if the provider delivery id was seen. */
export async function recordDelivery(
  tx: Queryable,
  input: { provider: "github" | "gitlab" | "jira" | "bitbucket" | "azure_devops" | "ci"; deliveryId: string; eventType: string; tenantId: string | null; signatureValid: boolean; status: "accepted" | "rejected"; payloadDigest: string; error?: string },
): Promise<"accepted" | "duplicate" | "rejected"> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO webhook_deliveries (id, provider, delivery_id, event_type, tenant_id, signature_valid, status, payload_digest, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (provider, delivery_id) DO NOTHING RETURNING id`,
    [uuidv7(), input.provider, input.deliveryId, input.eventType, input.tenantId, input.signatureValid, input.status, input.payloadDigest, input.error ?? null],
  );
  if (rows.length === 0) return "duplicate";
  return input.status;
}

// ---------------------------------------------------------------------------- replay cache for signed tokens

/**
 * Record a token ID (a JWT `jti`) until the token expires. False when it is already recorded, which
 * means the token is being used a second time. One table serves every replica.
 */
export async function claimTokenId(tx: Queryable, issuer: string, tokenId: string, expiresAt: Date): Promise<boolean> {
  const { rows } = await tx.query<{ token_id: string }>(
    "INSERT INTO token_replay_cache (issuer, token_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (issuer, token_id) DO NOTHING RETURNING token_id",
    [issuer, tokenId, expiresAt.toISOString()],
  );
  return rows.length === 1;
}

/** Forget the IDs of expired tokens (an expired token is refused before the cache is asked). Returns how many. */
export async function sweepTokenReplayCache(tx: Queryable): Promise<number> {
  const { rows } = await tx.query<{ n: number }>("WITH swept AS (DELETE FROM token_replay_cache WHERE expires_at < now() RETURNING 1) SELECT count(*)::int AS n FROM swept");
  return rows[0]?.n ?? 0;
}
