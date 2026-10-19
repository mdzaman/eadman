import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks } from "@docops/checks";
import { parseConfig } from "@docops/config";
import { buildSnapshot } from "@docops/engine";
import { ACME_ROOT, acmeFile, acmeHeadConfigSchema, acmeHeadOpenApi } from "../../../packages/engine/test/fixtures.ts";
import { createTestEnv } from "./helpers.ts";

const disk = async (p: string) => {
  try {
    return readFileSync(join(ACME_ROOT, p), "utf8");
  } catch {
    return null;
  }
};

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

test("end to end: snapshot → content graph → checks → links → Jira readiness → doc tasks", async () => {
  const env = await createTestEnv();
  const ci = env.tokens.ci;

  const accepted = await env.request("/v1/snapshots", { method: "POST", token: ci, json: await acmeSnapshot() });
  assert.equal(accepted.status, 202);
  const applied = (await accepted.json()) as { spaceId: string; pages: number };
  assert.equal(applied.pages, 5);

  const pages = (await (await env.request(`/v1/spaces/${applied.spaceId}/pages?limit=50`, { token: ci })).json()) as { items: Array<{ id: string; path: string }> };
  assert.equal(pages.items.length, 5);
  const coverage = (await (await env.request(`/v1/spaces/${applied.spaceId}/coverage?kind=api.operation`, { token: ci })).json()) as { totals: { publicEntities: number; percentL2: number } };
  assert.deepEqual([coverage.totals.publicEntities, coverage.totals.percentL2], [5, 100]);

  const ops = (await (await env.request("/v1/entities?kind=api.operation&limit=50", { token: ci })).json()) as { items: Array<{ key: string; documented: boolean; visibility: string }> };
  assert.equal(ops.items.length, 6);
  assert.equal(ops.items.find((o) => o.key.endsWith("/reconcile"))?.visibility, "internal");

  const paymentsPage = pages.items.find((p) => p.path === "guides/payments.md")!;
  const graph = (await (await env.request(`/v1/pages/${paymentsPage.id}/graph`, { token: ci })).json()) as { entities: Array<{ key: string; referenceKind: string; stale: boolean }>; tickets: Array<{ key: string }> };
  assert.ok(graph.entities.some((e) => e.key === "api.operation:payments-api:POST /v1/payments" && e.referenceKind === "explicit"));
  assert.ok(graph.entities.every((e) => !e.stale));
  assert.deepEqual(graph.tickets.map((t) => t.key), ["PAY-101"]);

  // Check run from CI (the drift scenario), then a dismissal that persists by fingerprint.
  const loaded = parseConfig(acmeFile("docops.yaml"));
  const head = await runChecks({
    repoRoot: ACME_ROOT,
    loaded,
    readHead: async (p) => (p === "api/openapi.yaml" ? acmeHeadOpenApi() : p === "config/schema.json" ? acmeHeadConfigSchema() : disk(p)),
    base: { ref: "origin/main", sha: "a".repeat(40), read: disk },
    changedFiles: new Set(["api/openapi.yaml", "config/schema.json"]),
  });
  const checkRun = { repository: { provider: "github", fullName: "acme/payments" }, headSha: "b".repeat(40), baseSha: "a".repeat(40), pullRequestNumber: 7, conclusion: "failure", summary: head.report.summary, findings: head.report.findings };
  const created = await env.request("/v1/check-runs", { method: "POST", token: ci, json: checkRun });
  assert.equal(created.status, 201);
  const run = (await created.json()) as { id: string; findingsCount: number };
  assert.equal(run.findingsCount, head.report.findings.length);
  const detail = (await (await env.request(`/v1/check-runs/${run.id}`, { token: ci })).json()) as { findings: Array<{ id: string; ruleId: string; fingerprint: string }> };
  const staleValue = detail.findings.find((f) => f.ruleId === "drift/stale-value")!;
  assert.equal((await env.request(`/v1/findings/${staleValue.id}/dismiss`, { method: "POST", token: env.tokens.viewer, json: { reason: "false_positive" } })).status, 403);
  const dismissed = await env.request(`/v1/findings/${staleValue.id}/dismiss`, { method: "POST", token: env.tokens.owner, json: { reason: "wont_fix", note: "runbook rewrite tracked in PAY-160" } });
  assert.equal(((await dismissed.json()) as { status: string }).status, "dismissed");
  const rerun = (await (await env.request("/v1/check-runs", { method: "POST", token: ci, json: checkRun })).json()) as { dismissedFingerprints: string[] };
  assert.deepEqual(rerun.dismissedFingerprints, [staleValue.fingerprint]);

  // Ticket docs status (Jira mirror is fetched on demand) and links. Readiness reads need a human
  // role (viewer and up); CI service accounts may create links but not read readiness (RBAC matrix).
  assert.equal((await env.request("/v1/tickets/PAY-101/docs", { token: ci })).status, 403);
  const viewer = env.tokens.viewer;
  const ticketDocs = (await (await env.request("/v1/tickets/PAY-101/docs", { token: viewer })).json()) as { docsStatus: string; ticket: { docsRequired: string; title: string }; pages: Array<{ path: string }> };
  assert.equal(ticketDocs.docsStatus, "merged");
  assert.equal(ticketDocs.ticket.title, "Summary of PAY-101");
  assert.deepEqual(ticketDocs.pages.map((p) => p.path), ["guides/payments.md"]);

  const link = await env.request("/v1/links", { method: "POST", token: ci, json: { ticketKey: "PAY-123", targetType: "page", spaceKey: "payments", pagePath: "guides/refunds.md" } });
  assert.equal(link.status, 201);
  const linkBody = (await link.json()) as { id: string; source: string };
  assert.equal(linkBody.source, "api");
  const links = (await (await env.request("/v1/links?ticketKey=PAY-123", { token: viewer })).json()) as { items: Array<{ id: string; source: string }> };
  const derived = links.items.find((l) => l.source === "frontmatter")!;
  assert.equal((await env.request(`/v1/links/${derived.id}`, { method: "DELETE", token: ci })).status, 409, "Git-derived links are changed in Git, not via the API");
  assert.equal((await env.request(`/v1/links/${linkBody.id}`, { method: "DELETE", token: ci })).status, 204);

  // Release readiness from Jira (FakeJira) + doc tasks, idempotent.
  const readiness = (await (await env.request("/v1/readiness?tracker=jira&project=PAY&fixVersion=2.4.0", { token: viewer })).json()) as { summary: { readyPercent: number; blockers: number; ready: boolean }; items: Array<{ ticketKey: string; docsStatus: string }> };
  assert.deepEqual(readiness.items.map((i) => [i.ticketKey, i.docsStatus]), [
    ["PAY-140", "missing"],
    ["PAY-101", "merged"],
    ["PAY-123", "merged"],
    ["PAY-150", "not_required"],
  ]);
  assert.deepEqual([readiness.summary.readyPercent, readiness.summary.blockers, readiness.summary.ready], [75, 1, false]);
  assert.equal((await env.request("/v1/readiness/doc-tasks", { method: "POST", token: ci, json: { project: "PAY", fixVersion: "2.4.0" } })).status, 403, "CI cannot create doc tasks");
  const tasks = (await (await env.request("/v1/readiness/doc-tasks", { method: "POST", token: env.tokens.owner, json: { project: "PAY", fixVersion: "2.4.0" } })).json()) as { created: Array<{ parentKey: string; key: string }> };
  assert.deepEqual(tasks.created.map((t) => t.parentKey), ["PAY-140"]);
  assert.deepEqual((env.jira.created[0]?.parent as { key: string }).key, "PAY-140");
  const again = (await (await env.request("/v1/readiness/doc-tasks", { method: "POST", token: env.tokens.owner, json: { project: "PAY", fixVersion: "2.4.0" } })).json()) as { created: unknown[]; skipped: Array<{ reason: string }> };
  assert.deepEqual([again.created.length, again.skipped[0]?.reason], [0, "a doc task was already created"]);
});

test("a later snapshot of the default branch marks pages stale", async () => {
  const env = await createTestEnv();
  await env.request("/v1/snapshots", { method: "POST", token: env.tokens.ci, json: await acmeSnapshot() });
  const loaded = parseConfig(acmeFile("docops.yaml"));
  const changed = await runChecks({ repoRoot: ACME_ROOT, loaded, readHead: async (p) => (p === "config/schema.json" ? acmeHeadConfigSchema() : disk(p)) });
  const next = buildSnapshot({
    repository: { provider: "github", fullName: "acme/payments" },
    commitSha: "c".repeat(40),
    ref: "refs/heads/main",
    spaceKey: "payments",
    sources: changed.sources,
    pages: changed.pages,
    entities: changed.headEntities,
    references: changed.headRefs,
  });
  assert.equal(((await (await env.request("/v1/snapshots", { method: "POST", token: env.tokens.ci, json: next })).json()) as { changedEntities: number }).changedEntities, 1);
  const spaces = (await (await env.request("/v1/spaces", { token: env.tokens.ci })).json()) as { items: Array<{ id: string }> };
  const pages = (await (await env.request(`/v1/spaces/${spaces.items[0]!.id}/pages?q=runbook`, { token: env.tokens.ci })).json()) as { items: Array<{ id: string }> };
  const graph = (await (await env.request(`/v1/pages/${pages.items[0]!.id}/graph`, { token: env.tokens.ci })).json()) as { entities: Array<{ key: string; stale: boolean }> };
  assert.equal(graph.entities.find((e) => e.key.endsWith("PAYMENTS_TIMEOUT_MS"))?.stale, true);
});

// ---------------------------------------------------------------------------- CI OIDC token exchange

function rs256Jwt(privateKey: import("node:crypto").KeyObject, kid: string, claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

test("CI OIDC exchange: pinned immutable claims, repo-bound and environment-bound tokens", async () => {
  const env = await createTestEnv();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  env.jwks.keys.push({ ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", kty: "RSA" });
  const issuer = "https://token.actions.githubusercontent.com";
  env.trust.push({
    provider: "github-actions",
    issuer,
    audience: "https://api.docops.example",
    claims: { repository_owner_id: "8429187", repository_id: "702145778" },
    rules: [{ match: { ref: "refs/heads/main" }, grant: ["checks:write", "builds:write", "deployments:write"], environments: ["dev"] }],
  });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: "https://api.docops.example", repository: "acme/payments", repository_id: "702145778", repository_owner_id: "8429187", ref: "refs/heads/main", iat: now, exp: now + 300 };
  const exchange = (jwt: string) =>
    env.request("/v1/auth/oidc-exchange?tenant=acme", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", subject_token: jwt }).toString(),
    });

  const res = await exchange(rs256Jwt(privateKey, "k1", claims));
  assert.equal(res.status, 200);
  const { access_token, expires_in, scope } = (await res.json()) as { access_token: string; expires_in: number; scope: string };
  assert.equal(expires_in, 900);
  assert.equal(scope, "checks:write builds:write deployments:write");

  const run = { headSha: "e".repeat(40), conclusion: "success", summary: {}, findings: [] };
  assert.equal((await env.request("/v1/check-runs", { method: "POST", token: access_token, json: { ...run, repository: { provider: "github", fullName: "acme/payments" } } })).status, 201);
  assert.equal((await env.request("/v1/check-runs", { method: "POST", token: access_token, json: { ...run, repository: { provider: "github", fullName: "acme/other" } } })).status, 403, "token is bound to its repository");

  // Resurrected / renamed repo with a different immutable id, wrong signer, expired token, untrusted ref.
  assert.equal((await exchange(rs256Jwt(privateKey, "k1", { ...claims, repository_id: "1" }))).status, 403);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal((await exchange(rs256Jwt(other.privateKey, "k1", claims))).status, 403);
  assert.equal((await exchange(rs256Jwt(privateKey, "k1", { ...claims, exp: now - 3600 }))).status, 403);
  assert.equal((await exchange(rs256Jwt(privateKey, "k1", { ...claims, ref: "refs/heads/feature" }))).status, 403);
});
