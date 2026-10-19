import { badRequest, DocOpsError, unauthorized, uuidv7, type Role, type RoleBinding, type TokenScope } from "@docops/core";
import {
  addTenantRoute,
  appendAudit,
  asPlatform,
  claimTokenId,
  ensureServiceAccount,
  getTenant,
  lookupApiToken,
  resolveTenantRoute,
  sweepTokenReplayCache,
  withTenant,
  type Queryable,
  type SqlClient,
} from "@docops/db";
import type { AppDeps, Principal } from "./context.ts";
import {
  FORGE_CLOCK_SKEW_SECONDS,
  FORGE_FIT_ISSUER,
  fetchForgeJwks,
  forgeInstallationKey,
  JwksUnavailableError,
  verifyAccessToken,
  verifyForgeInvocationToken,
  type ForgeInvocation,
} from "./security.ts";

async function bindingsFor(tx: Queryable, principalType: "user" | "service_account", principalId: string): Promise<RoleBinding[]> {
  const { rows } = await tx.query<{ role: Role; scope_type: "org" | "space" | "page"; scope_id: string | null }>(
    `SELECT role, scope_type, scope_id FROM role_bindings
     WHERE (principal_type = $1 AND principal_id = $2::uuid)
        OR ($1 = 'user' AND principal_type = 'group' AND principal_id IN (SELECT group_id FROM group_members WHERE user_id = $2::uuid))`,
    [principalType, principalId],
  );
  return rows.map((r) => ({ role: r.role, scopeType: r.scope_type, scopeId: r.scope_id }));
}

/**
 * Resolve `Authorization: Bearer …` to a principal: an API token (dop_…), a short-lived CI access token,
 * or a Forge Invocation Token from the Jira app. Unusable credentials return null, except a FIT, which
 * is refused with its reason (a thrown 401 problem, or 503 while Atlassian's keys are unreachable).
 */
export async function resolvePrincipal(deps: AppDeps, authorization: string | undefined): Promise<Principal | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return null;
  if (token.startsWith("dop_")) {
    const found = await asPlatform(deps.db, (tx) => lookupApiToken(tx, token));
    if (!found) return null;
    return withTenant(deps.db, found.tenantId, async (tx) => {
      const tenant = await getTenant(tx, found.tenantId);
      await tx.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [found.tokenId]);
      return {
        tenantId: found.tenantId,
        tenantSlug: tenant?.slug ?? "",
        principalType: found.principalType,
        principalId: found.principalId,
        scopes: found.scopes,
        bindings: await bindingsFor(tx, found.principalType, found.principalId),
        authMethod: "api_token",
      };
    });
  }
  if (unverifiedIssuer(token) === FORGE_FIT_ISSUER) return resolveForgePrincipal(deps, token);
  const claims = verifyAccessToken(deps.config.tokenSigningSecret, token);
  if (!claims) return null;
  return withTenant(deps.db, claims.tid, async (tx) => ({
    tenantId: claims.tid,
    tenantSlug: (await getTenant(tx, claims.tid))?.slug ?? "",
    principalType: "service_account",
    principalId: claims.sub,
    scopes: claims.scp,
    bindings: await bindingsFor(tx, "service_account", claims.sub),
    authMethod: "ci_oidc",
    repository: claims.repo,
    environments: claims.env ? claims.env.split(",") : undefined,
  }));
}

/** CI identities are service accounts with the ci_publisher role (org scope). */
export async function ensureCiServiceAccount(db: SqlClient, tenantId: string, name: string): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const id = await ensureServiceAccount(tx, tenantId, name);
    await tx.query(
      `INSERT INTO role_bindings (id, tenant_id, principal_type, principal_id, role, scope_type, scope_id, created_by)
       VALUES ($1, $2, 'service_account', $3, 'ci_publisher', 'org', NULL, 'system') ON CONFLICT DO NOTHING`,
      [uuidv7(), tenantId, id],
    );
    return id;
  });
}

/** Grant a role to a service account (used by bootstrap and tests). */
export async function grantServiceAccountRole(db: SqlClient, tenantId: string, serviceAccountId: string, role: Role, scope: { type: "org" | "space" | "page"; id: string | null } = { type: "org", id: null }): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.query(
      `INSERT INTO role_bindings (id, tenant_id, principal_type, principal_id, role, scope_type, scope_id, created_by)
       VALUES ($1, $2, 'service_account', $3, $4, $5, $6, 'system') ON CONFLICT DO NOTHING`,
      [uuidv7(), tenantId, serviceAccountId, role, scope.type, scope.id],
    ),
  );
}

// ---------------------------------------------------------------------------- Jira Forge app (Forge Invocation Tokens)

/** What the Jira app's credential may do: what its resolvers call (docs/06 §3). The tracker_app role caps it as well. */
const FORGE_SCOPES: readonly TokenScope[] = ["docs:read", "readiness:read", "links:write"];

/** One process deletes expired replay-cache entries at most this often. */
const REPLAY_SWEEP_INTERVAL_MS = 60_000;
let lastReplaySweep = 0;

/** The unverified `iss` of a JWT. It only picks the verifier, which then checks everything. */
function unverifiedIssuer(token: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { iss?: unknown } | null;
    return typeof claims?.iss === "string" ? claims.iss : null;
  } catch {
    return null;
  }
}

/**
 * Verify a Forge Invocation Token and map its installation to a tenant (docs/06 §3, threat T04). Every
 * failure is a 401 problem, except Atlassian's keys being unreachable (503). The token's `jti` goes into
 * the replay cache that all replicas share, so a token is accepted once, by the API and the Jira
 * webhook receiver alike.
 */
export async function authenticateForgeInvocation(deps: AppDeps, token: string): Promise<{ invocation: ForgeInvocation; tenantId: string }> {
  const appId = deps.config.forgeAppId;
  if (!appId) throw unauthorized("Forge Invocation Tokens are not accepted: no Forge app is configured");
  let invocation: ForgeInvocation;
  try {
    invocation = await verifyForgeInvocationToken(token, { appId, jwks: deps.jwks ?? fetchForgeJwks });
  } catch (error) {
    if (error instanceof JwksUnavailableError) throw new DocOpsError("unavailable", "The Forge Invocation Token cannot be verified now: Atlassian's signing keys are unreachable", 503);
    throw unauthorized(`Forge Invocation Token rejected: ${error instanceof Error ? error.message : "invalid token"}`);
  }
  if (Date.now() - lastReplaySweep > REPLAY_SWEEP_INTERVAL_MS) {
    lastReplaySweep = Date.now();
    await asPlatform(deps.db, (tx) => sweepTokenReplayCache(tx));
  }
  const tenantId = await asPlatform(deps.db, async (tx) => {
    const routed = await resolveTenantRoute(tx, "forge_installation", invocation.installationId);
    if (routed === null) return null;
    // Kept for as long as the token could still pass the expiry check, clock skew included.
    const until = new Date((invocation.expiresAt + FORGE_CLOCK_SKEW_SECONDS) * 1000);
    if (!(await claimTokenId(tx, FORGE_FIT_ISSUER, invocation.tokenId, until))) throw unauthorized("Forge Invocation Token rejected: it was already used");
    return routed;
  });
  if (tenantId === null) throw unauthorized(`Unknown Forge installation ${invocation.installationId}: register it for its tenant in DocOps`);
  return { invocation, tenantId };
}

/** A Forge call acts as its installation's service account (forgeServiceAccount), with FORGE_SCOPES. */
async function resolveForgePrincipal(deps: AppDeps, token: string): Promise<Principal> {
  const { invocation, tenantId } = await authenticateForgeInvocation(deps, token);
  return withTenant(deps.db, tenantId, async (tx) => {
    const serviceAccountId = await forgeServiceAccount(tx, tenantId, invocation.installationId);
    return {
      tenantId,
      tenantSlug: (await getTenant(tx, tenantId))?.slug ?? "",
      principalType: "service_account",
      principalId: serviceAccountId,
      scopes: [...FORGE_SCOPES],
      bindings: await bindingsFor(tx, "service_account", serviceAccountId),
      authMethod: "forge_fit",
    };
  });
}

/**
 * The installation's service account, `forge:<installation id>`. The installation's first call creates
 * it with the tracker_app role at org scope (audited as role.granted). Later calls leave its bindings
 * alone, so an administrator can narrow the binding to spaces or remove it, and the app cannot grant
 * the role back to itself.
 */
async function forgeServiceAccount(tx: Queryable, tenantId: string, installationId: string): Promise<string> {
  const name = `forge:${installationId}`;
  const existing = await tx.query<{ id: string }>("SELECT id FROM service_accounts WHERE tenant_id = $1 AND name = $2", [tenantId, name]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = await ensureServiceAccount(tx, tenantId, name);
  const granted = await tx.query<{ id: string }>(
    `INSERT INTO role_bindings (id, tenant_id, principal_type, principal_id, role, scope_type, scope_id, created_by)
     VALUES ($1, $2, 'service_account', $3, 'tracker_app', 'org', NULL, 'system') ON CONFLICT DO NOTHING RETURNING id`,
    [uuidv7(), tenantId, id],
  );
  const bindingId = granted.rows[0]?.id;
  if (bindingId) {
    await appendAudit(tx, tenantId, {
      actor: { type: "system", id: "system", authMethod: "forge_fit" },
      action: "role.granted",
      resource: { type: "role_binding", id: bindingId },
      outcome: "success",
      details: { role: "tracker_app", scopeType: "org", scopeId: null, principalType: "service_account", principalId: id, forgeInstallationId: installationId },
    });
  }
  return id;
}

/** Route a Forge installation to a tenant: its ID as the app's admin page shows it, or its ARI. Returns the route key. */
export async function registerForgeInstallation(db: SqlClient, tenantId: string, installation: string): Promise<string> {
  const key = forgeInstallationKey(installation.trim());
  if (key === null) throw badRequest("A Forge installation ID is a UUID or an ari:cloud:ecosystem::installation/<uuid> ARI");
  await asPlatform(db, (tx) => addTenantRoute(tx, "forge_installation", key, tenantId));
  return key;
}
