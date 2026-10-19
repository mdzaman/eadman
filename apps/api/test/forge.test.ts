import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { runChecks } from "@docops/checks";
import { parseConfig } from "@docops/config";
import { can, DocOpsError, type Permission, type RoleBinding } from "@docops/core";
import { asPlatform, claimTokenId, createApiToken, ensureServiceAccount, sweepTokenReplayCache, withTenant } from "@docops/db";
import { buildSnapshot } from "@docops/engine";
import { ACME_ROOT, acmeFile } from "../../../packages/engine/test/fixtures.ts";
import { grantServiceAccountRole, registerForgeInstallation } from "../src/auth.ts";
import { cachedJwks, FORGE_FIT_ISSUER, forgeInstallationKey, verifyForgeInvocationToken, type Jwk } from "../src/security.ts";
import { createTestEnv, type TestEnv } from "./helpers.ts";

// Forge Invocation Tokens (docs/06 §3, threat T04 in docs/08). The claims below follow the example in
// Atlassian's Forge Remote documentation (developer.atlassian.com/platform/forge/remote/essentials/):
// `app.installationId` is an installation ARI, `aud` and `app.id` are the app ARI, `exp` is 25 s after `iat`.

const APP_ID = "ari:cloud:ecosystem::app/8db33809-1f32-48bb-8c52-5877dab48107";
const INSTALLATION = "0a3a7799-53ae-4a5b-9e7e-03338980abb5";
const KID = "forge/invocation-token/wf-0f8e2f4c-test";

type Claims = Record<string, unknown>;

function jwt(privateKey: KeyObject, header: Claims, claims: Claims): string {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Claims;
const jwkOf = (publicKey: KeyObject, kid: string): Jwk => ({ ...(publicKey.export({ format: "jwk" }) as Claims), kid, kty: "RSA", alg: "RS256", use: "sig" });

function appClaim(overrides: Claims = {}): Claims {
  return {
    installationId: `ari:cloud:ecosystem::installation/${INSTALLATION}`,
    apiBaseUrl: "https://api.atlassian.com/ex/jira/d0d52620-3203-4cfa-8db5-f2587155f0dd",
    id: APP_ID,
    appVersion: "1.4.0",
    environment: { type: "PRODUCTION", id: "ari:cloud:ecosystem::environment/1c2a7f0e-8d77-4e4b-9a0b-3b2f8c1d9e55" },
    module: { type: "jira:issuePanel", key: "docops-docs-panel" },
    ...overrides,
  };
}

function fitClaims(overrides: Claims = {}): Claims {
  const now = Math.floor(Date.now() / 1000);
  return {
    app: appClaim(),
    context: { cloudId: "d0d52620-3203-4cfa-8db5-f2587155f0dd" },
    principal: "655362:312d3308-8954-42b0-aa38-771a10c88656",
    aud: APP_ID,
    iss: FORGE_FIT_ISSUER,
    iat: now,
    nbf: now,
    exp: now + 25,
    jti: randomBytes(16).toString("hex"),
    ...overrides,
  };
}

interface ForgeEnv extends TestEnv {
  /** A FIT signed with the key in the test JWKS: a fresh `jti` each call, claims overridable. */
  fit: (overrides?: Claims, options?: { key?: KeyObject; kid?: string; alg?: string }) => string;
}

/** DocOps trusting the Jira app APP_ID, with INSTALLATION registered to tenant acme. */
async function forgeEnv(): Promise<ForgeEnv> {
  const env = await createTestEnv();
  env.deps.config.forgeAppId = APP_ID;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  env.jwks.keys.push(jwkOf(publicKey, KID));
  // Registered as an administrator copies it from the app's admin page: the bare UUID.
  await registerForgeInstallation(env.deps.db, env.tenantId, INSTALLATION);
  const fit: ForgeEnv["fit"] = (overrides = {}, options = {}) => jwt(options.key ?? privateKey, { alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? KID }, fitClaims(overrides));
  return { ...env, fit };
}

async function problemOf(res: Response): Promise<{ status: number; title: string; type: string; contentType: string | null }> {
  return { ...((await res.json()) as { status: number; title: string; type: string }), contentType: res.headers.get("content-type") };
}

async function acmeSnapshot() {
  const loaded = parseConfig(acmeFile("docops.yaml"));
  const r = await runChecks({ repoRoot: ACME_ROOT, loaded });
  return buildSnapshot({
    repository: { provider: "github", fullName: "acme/payments" },
    commitSha: "a".repeat(40),
    ref: "refs/heads/main",
    committedAt: "2026-10-01T00:00:00.000Z",
    spaceKey: "payments",
    spaceName: "Acme Payments",
    docsRoot: "docs",
    configDigest: loaded.digest,
    sources: r.sources,
    pages: r.pages,
    entities: r.headEntities,
    references: r.headRefs,
  });
}

test("Forge FIT: a valid token acts as the installation's service account, with the tracker_app role", async () => {
  const env = await forgeEnv();
  const res = await env.request("/v1/me", { token: env.fit() });
  assert.equal(res.status, 200);
  const me = (await res.json()) as { principalType: string; principalId: string; tenant: { slug: string }; scopes: string[]; roles: unknown[] };
  assert.equal(me.principalType, "service_account");
  assert.equal(me.tenant.slug, "acme");
  assert.deepEqual(me.scopes, ["docs:read", "readiness:read", "links:write"]);
  assert.deepEqual(me.roles, [{ role: "tracker_app", scopeType: "org", scopeId: null }]);

  // A later token of the same installation: the same account, granted once and audited once.
  const again = (await (await env.request("/v1/me", { token: env.fit() })).json()) as { principalId: string };
  assert.equal(again.principalId, me.principalId);
  await withTenant(env.deps.db, env.tenantId, async (tx) => {
    const account = (await tx.query<{ name: string }>("SELECT name FROM service_accounts WHERE id = $1", [me.principalId])).rows[0];
    assert.equal(account?.name, `forge:${INSTALLATION}`);
    const grants = (await tx.query<{ actor_type: string; auth_method: string; details: { role: string; principalId: string } }>("SELECT actor_type, auth_method, details FROM audit_events WHERE action = 'role.granted'")).rows;
    assert.deepEqual(
      grants.map((g) => [g.actor_type, g.auth_method, g.details.role, g.details.principalId]),
      [["system", "forge_fit", "tracker_app", me.principalId]],
    );
  });
});

test("Forge FIT: the operations the Jira app's resolvers call all work, and are attributed to the app", async () => {
  const env = await forgeEnv();
  const applied = (await (await env.request("/v1/snapshots", { method: "POST", token: env.tokens.ci, json: await acmeSnapshot() })).json()) as { spaceId: string };

  // searchPages and checkConnection: listPages in the space configured on the admin page.
  const pages = await env.request(`/v1/spaces/${applied.spaceId}/pages?q=refund&limit=20`, { token: env.fit() });
  assert.equal(pages.status, 200);
  const refunds = ((await pages.json()) as { items: Array<{ id: string; path: string }> }).items.find((p) => p.path === "guides/refunds.md");
  assert.ok(refunds, "the refunds page is found");

  // Issue panel and glance: getTicketDocs.
  const docs = await env.request("/v1/tickets/PAY-101/docs?tracker=jira", { token: env.fit() });
  assert.equal(docs.status, 200);
  assert.equal(((await docs.json()) as { docsStatus: string }).docsStatus, "merged");

  // "Link documentation": createLink with the body linkPage sends; a Forge link is a tracker-panel link.
  const link = await env.request("/v1/links", { method: "POST", token: env.fit(), headers: { "idempotency-key": "click-1" }, json: { ticketKey: "PAY-123", tracker: "jira", targetType: "page", targetId: refunds.id } });
  assert.equal(link.status, 201);
  assert.equal(((await link.json()) as { source: string }).source, "tracker_panel");

  // Project page: getReadiness, then createDocTasks for the Missing ticket.
  const readiness = await env.request("/v1/readiness?tracker=jira&project=PAY&fixVersion=2.4.0", { token: env.fit() });
  assert.equal(readiness.status, 200);
  const missing = ((await readiness.json()) as { items: Array<{ ticketKey: string; docsStatus: string }> }).items.filter((i) => i.docsStatus === "missing").map((i) => i.ticketKey);
  assert.deepEqual(missing, ["PAY-140"]);
  const tasks = await env.request("/v1/readiness/doc-tasks", { method: "POST", token: env.fit(), headers: { "idempotency-key": "click-2" }, json: { project: "PAY", fixVersion: "2.4.0", ticketKeys: missing } });
  assert.equal(tasks.status, 200);
  assert.deepEqual(((await tasks.json()) as { created: Array<{ parentKey: string }> }).created.map((t) => t.parentKey), ["PAY-140"]);

  const audited = await withTenant(env.deps.db, env.tenantId, async (tx) =>
    (await tx.query<{ action: string; actor_id: string; auth_method: string }>("SELECT action, actor_id, auth_method FROM audit_events WHERE action IN ('link.created', 'readiness.doc_tasks_created') ORDER BY seq")).rows,
  );
  assert.deepEqual(audited.map((a) => [a.action, a.auth_method]), [
    ["link.created", "forge_fit"],
    ["readiness.doc_tasks_created", "forge_fit"],
  ]);
  assert.ok(audited.every((a) => a.actor_id.startsWith("service_account:")));
});

test("Forge FIT: the app's scopes and the tracker_app role both stop everything else (it cannot publish)", async () => {
  const env = await forgeEnv();
  const id = "0192f1c0-0000-7000-8000-000000000001";
  const attempts: Array<[string, string, unknown?]> = [
    ["POST", "/v1/builds", { kind: "preview", spaceKey: "payments" }],
    ["PUT", `/v1/blobs/${"a".repeat(64)}`],
    ["POST", `/v1/builds/${id}/finalize`],
    ["POST", "/v1/deployments", { environment: "prod", buildId: id }],
    ["POST", "/v1/snapshots", { commitSha: "a".repeat(40), spaceKey: "payments", pages: [], entities: [] }],
    ["POST", "/v1/check-runs", {}],
    ["POST", `/v1/findings/${id}/dismiss`, { reason: "wont_fix" }],
    ["POST", `/v1/suggestions/${id}/accept`, {}],
    ["GET", "/v1/audit-events"],
    ["GET", "/v1/role-bindings"],
    ["POST", "/v1/role-bindings", { scopeType: "org", role: "org_owner", principalType: "service_account", principalId: id }],
    ["POST", "/v1/api-tokens", { name: "escalate", scopes: ["admin"] }],
    ["POST", "/v1/repositories", { provider: "github", fullName: "acme/payments" }],
  ];
  for (const [method, path, json] of attempts) {
    const res = await env.request(path, { method, token: env.fit(), json });
    assert.equal(res.status, 403, `${method} ${path}`);
  }

  // The role on its own, whatever a credential's scopes: an admin-scoped token for a tracker_app account
  // still cannot publish, and the role has nothing beyond what the resolvers need.
  const sa = await withTenant(env.deps.db, env.tenantId, (tx) => ensureServiceAccount(tx, env.tenantId, "tracker-app-admin-scoped"));
  await grantServiceAccountRole(env.deps.db, env.tenantId, sa, "tracker_app");
  const adminScoped = (await withTenant(env.deps.db, env.tenantId, (tx) => createApiToken(tx, { tenantId: env.tenantId, principalType: "service_account", principalId: sa, name: "x", scopes: ["admin"] }))).secret;
  const publish = await env.request("/v1/builds", { method: "POST", token: adminScoped, json: { kind: "preview", spaceKey: "payments" } });
  assert.equal(publish.status, 403);
  assert.equal((await problemOf(publish)).title, "Missing permission preview.publish");
  const tracker: RoleBinding[] = [{ role: "tracker_app", scopeType: "org", scopeId: null }];
  const allowed = (["page.read", "link.manage", "readiness.read", "readiness.doc_tasks"] as Permission[]).filter((p) => can(tracker, p, { ownedByPrincipal: true }));
  assert.deepEqual(allowed, ["page.read", "link.manage", "readiness.read", "readiness.doc_tasks"]);
  for (const permission of ["preview.publish", "deployment.promote.nonprod", "deployment.promote.prod", "checks.write", "finding.dismiss", "gate.waive", "page.propose", "suggestion.decide", "audit.read", "token.manage", "integration.manage"] as Permission[]) {
    assert.equal(can(tracker, permission, { ownedByPrincipal: true }), false, permission);
  }
});

test("Forge FIT: wrong iss, wrong aud, expired, replayed jti and bad signatures get a 401 problem", async () => {
  const env = await forgeEnv();
  const now = Math.floor(Date.now() / 1000);
  const rejected = async (token: string, title: RegExp, why: string) => {
    const res = await env.request("/v1/me", { token });
    const problem = await problemOf(res);
    assert.equal(res.status, 401, why);
    assert.equal(problem.contentType, "application/problem+json", why);
    assert.match(problem.title, title, why);
  };

  // Wrong issuer: not a FIT, so not taken for one (and the FIT verifier refuses it too).
  const otherIssuer = env.fit({ iss: "forge/other-token" });
  await rejected(otherIssuer, /^Authentication required$/, "wrong iss");
  await assert.rejects(verifyForgeInvocationToken(otherIssuer, { appId: APP_ID, jwks: async () => env.jwks }), /issuer mismatch/);

  await rejected(env.fit({ aud: "ari:cloud:ecosystem::app/00000000-0000-4000-8000-000000000000" }), /audience mismatch/, "another app's token");
  await rejected(env.fit({ iat: now - 120, nbf: now - 120, exp: now - 31 }), /token expired/, "expired beyond the clock skew");
  await rejected(env.fit({ nbf: now + 120, exp: now + 150 }), /not yet valid/, "not valid yet");

  const once = env.fit();
  assert.equal((await env.request("/v1/me", { token: once })).status, 200);
  await rejected(once, /already used/, "replayed jti");

  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await rejected(env.fit({}, { key: other.privateKey }), /bad signature/, "signed with a key that is not Atlassian's");
  const [header, , signature] = env.fit().split(".");
  await rejected(`${header}.${b64(fitClaims({ app: appClaim({ installationId: "ari:cloud:ecosystem::installation/11111111-2222-4333-8444-555555555555" }) }))}.${signature}`, /bad signature/, "claims changed after signing");
  await rejected(env.fit({}, { kid: "forge/invocation-token/wf-unknown" }), /signing key not found/, "unknown key id");
  await rejected(`${b64({ alg: "none", typ: "JWT" })}.${b64(fitClaims())}.`, /malformed token/, "unsigned (no signature part)");
  await rejected(`${b64({ alg: "none", typ: "JWT" })}.${b64(fitClaims())}.e30`, /unsupported alg none/, "alg none");
  await rejected(env.fit({}, { alg: "ES256" }), /unsupported alg ES256/, "FITs are RS256 only");
  await rejected(env.fit({ jti: undefined }), /jti is missing/, "no jti");
  await rejected(env.fit({ app: appClaim({ installationId: "not-an-installation" }) }), /app.installationId is missing or malformed/, "malformed installation");

  // Within the clock skew (30 s) a just-expired token still passes.
  assert.equal((await env.request("/v1/me", { token: env.fit({ iat: now - 50, nbf: now - 50, exp: now - 10 }) })).status, 200);
});

test("Forge FIT: an installation that is not registered gets a 401 problem, and nothing is created for it", async () => {
  const env = await forgeEnv();
  const stranger = "11111111-2222-4333-8444-555555555555";
  const res = await env.request("/v1/me", { token: env.fit({ app: appClaim({ installationId: `ari:cloud:ecosystem::installation/${stranger}` }) }) });
  assert.equal(res.status, 401);
  const problem = await problemOf(res);
  assert.equal(problem.contentType, "application/problem+json");
  assert.equal(problem.status, 401);
  assert.match(problem.type, /^https:\/\/docs\.docops\.example\/errors\//);
  assert.equal(problem.title, `Unknown Forge installation ${stranger}: register it for its tenant in DocOps`);
  const accounts = await withTenant(env.deps.db, env.tenantId, async (tx) => (await tx.query("SELECT 1 FROM service_accounts WHERE name LIKE 'forge:%'")).rows);
  assert.equal(accounts.length, 0);
});

test("Forge FIT: refused without DOCOPS_FORGE_APP_ID, and a 503 while Atlassian's keys are unreachable", async () => {
  const env = await forgeEnv();
  env.deps.config.forgeAppId = undefined;
  const unconfigured = await env.request("/v1/me", { token: env.fit() });
  assert.equal(unconfigured.status, 401);
  assert.match((await problemOf(unconfigured)).title, /no Forge app is configured/);

  env.deps.config.forgeAppId = APP_ID;
  env.deps.jwks = async () => {
    throw new Error("connect ETIMEDOUT forge.cdn.prod.atlassian-dev.net");
  };
  const token = env.fit();
  const down = await env.request("/v1/me", { token });
  assert.equal(down.status, 503, "not a rejection: the token was not judged");
  assert.equal((await problemOf(down)).contentType, "application/problem+json");
  // The token was not used up, so it still works once the keys are back.
  env.deps.jwks = async () => env.jwks;
  assert.equal((await env.request("/v1/me", { token })).status, 200);
});

test("Forge trigger: /hooks/jira takes a FIT instead of the HMAC and routes the event by installation", async () => {
  const env = await forgeEnv();
  const body = JSON.stringify({ eventType: "avi:jira:updated:issue", atlassianId: "655362:312d3308-8954-42b0-aa38-771a10c88656", issue: { id: "10123", key: "PAY-123", fields: { summary: "Partial refunds" } } });
  const trigger = (token: string) => env.request("/hooks/jira", { method: "POST", token, body, headers: { "content-type": "application/json", "x-forge-oauth-system": "app-system-token" } });
  const token = env.fit({ app: appClaim({ module: { type: "core:endpoint", key: "docops-events" } }) });
  const accepted = await trigger(token);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { status: "accepted" });

  const jti = payloadOf(token).jti as string;
  const outbox = await withTenant(env.deps.db, env.tenantId, async (tx) => (await tx.query<{ event_type: string; event: { id: string; data: { key: string } } }>("SELECT event_type, event FROM outbox")).rows);
  assert.deepEqual(outbox.map((o) => [o.event_type, o.event.id, o.event.data.key]), [["docops.tracker.issue_updated", jti, "PAY-123"]]);
  const deliveries = await asPlatform(env.deps.db, async (tx) => (await tx.query<{ delivery_id: string; tenant_id: string; event_type: string }>("SELECT delivery_id, tenant_id, event_type FROM webhook_deliveries WHERE provider = 'jira'")).rows);
  assert.deepEqual(deliveries, [{ delivery_id: jti, tenant_id: env.tenantId, event_type: "avi:jira:updated:issue" }]);

  // A replay, an unregistered installation and a forged token are refused; a Bearer token is never judged by the HMAC.
  assert.equal((await trigger(token)).status, 401, "replayed");
  assert.equal((await trigger(env.fit({ app: appClaim({ installationId: "11111111-2222-4333-8444-555555555555" }) }))).status, 401, "unknown installation");
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal((await trigger(env.fit({}, { key: other.privateKey }))).status, 401, "bad signature");
  assert.equal((await env.request("/hooks/jira?tenant=acme", { method: "POST", token: "not-a-fit", body })).status, 401, "a Bearer token that is not a FIT");
  const events = await withTenant(env.deps.db, env.tenantId, async (tx) => (await tx.query("SELECT 1 FROM outbox")).rows);
  assert.equal(events.length, 1);
});

test("Forge installation IDs: the token's ARI and the admin page's UUID are the same route key", async () => {
  assert.equal(forgeInstallationKey(`ari:cloud:ecosystem::installation/${INSTALLATION}`), INSTALLATION);
  assert.equal(forgeInstallationKey(INSTALLATION.toUpperCase()), INSTALLATION);
  for (const bad of ["", `ari:cloud:ecosystem::app/${INSTALLATION}`, "ari:cloud:ecosystem::installation/not-a-uuid", `${INSTALLATION}/1`, 42, null, undefined]) {
    assert.equal(forgeInstallationKey(bad), null, String(bad));
  }
  const env = await createTestEnv();
  assert.equal(await registerForgeInstallation(env.deps.db, env.tenantId, ` ari:cloud:ecosystem::installation/${INSTALLATION.toUpperCase()}\n`), INSTALLATION);
  await assert.rejects(registerForgeInstallation(env.deps.db, env.tenantId, "acme.atlassian.net"), (error) => error instanceof DocOpsError && error.status === 400);
});

test("Forge JWKS: cached, refetched for an unknown key at most every 30 s (key rotation), failures not kept", async () => {
  let clock = 1_000_000;
  let fetches = 0;
  const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let published: Jwk[] = [jwkOf(first.publicKey, "k-1")];
  const jwks = cachedJwks(
    async () => {
      fetches += 1;
      return { keys: published };
    },
    { now: () => clock },
  );
  const signed = (key: KeyObject, kid: string) => jwt(key, { alg: "RS256", typ: "JWT", kid }, fitClaims());
  const verify = (token: string) => verifyForgeInvocationToken(token, { appId: APP_ID, jwks });

  await Promise.all([verify(signed(first.privateKey, "k-1")), verify(signed(first.privateKey, "k-1"))]);
  assert.equal(fetches, 1, "concurrent first uses share one fetch");

  // Atlassian rotates to a new key. Shortly after a fetch the cache is trusted; then one refetch finds the key.
  published = [...published, jwkOf(rotated.publicKey, "k-2")];
  clock += 10_000;
  await assert.rejects(verify(signed(rotated.privateKey, "k-2")), /signing key not found/);
  assert.equal(fetches, 1, "no refetch within 30 s of the last one");
  clock += 25_000;
  assert.equal((await verify(signed(rotated.privateKey, "k-2"))).installationId, INSTALLATION);
  assert.equal(fetches, 2);
  await verify(signed(first.privateKey, "k-1"));
  assert.equal(fetches, 2, "known keys come from the cache");
  clock += 601_000;
  await verify(signed(first.privateKey, "k-1"));
  assert.equal(fetches, 3, "the set is fetched again after 10 minutes");

  let attempts = 0;
  const failing = cachedJwks(async () => {
    attempts += 1;
    throw new Error("HTTP 503");
  });
  await assert.rejects(failing("forge/invocation-token"), /HTTP 503/);
  await assert.rejects(failing("forge/invocation-token"), /HTTP 503/);
  assert.equal(attempts, 2, "a failed fetch is not cached");
});

test("token replay cache: a token ID is accepted once until it expires, and expired IDs are swept", async () => {
  const env = await createTestEnv();
  await asPlatform(env.deps.db, async (tx) => {
    assert.equal(await claimTokenId(tx, FORGE_FIT_ISSUER, "jti-old", new Date(Date.now() - 60_000)), true);
    assert.equal(await claimTokenId(tx, FORGE_FIT_ISSUER, "jti-live", new Date(Date.now() + 60_000)), true);
    assert.equal(await claimTokenId(tx, FORGE_FIT_ISSUER, "jti-live", new Date(Date.now() + 60_000)), false);
    assert.equal(await claimTokenId(tx, "https://token.actions.githubusercontent.com", "jti-live", new Date(Date.now() + 60_000)), true, "keyed by issuer");
    assert.equal(await sweepTokenReplayCache(tx), 1);
    const left = (await tx.query<{ token_id: string }>("SELECT token_id FROM token_replay_cache WHERE issuer = $1", [FORGE_FIT_ISSUER])).rows;
    assert.deepEqual(left.map((r) => r.token_id), ["jti-live"]);
  });
});
