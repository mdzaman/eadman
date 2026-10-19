import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks } from "@docops/checks";
import { parseConfig } from "@docops/config";
import { buildSnapshot } from "@docops/engine";
import { ACME_ROOT, acmeFile, acmeHeadConfigSchema, acmeHeadOpenApi } from "../../engine/test/fixtures.ts";
import {
  appendAudit,
  applySnapshot,
  asPlatform,
  claimJobs,
  completeJob,
  coverageForSpace,
  createBuild,
  createLink,
  createPgliteClient,
  createTenant,
  dismissFinding,
  enqueueJob,
  failJob,
  finalizeBuild,
  getTicketByKey,
  listAudit,
  listFindings,
  markProcessed,
  migrate,
  promoteBuild,
  readinessForFixVersion,
  recordBlob,
  recordCheckRun,
  recordDelivery,
  stalePageIds,
  ticketDocsView,
  upsertPullRequest,
  upsertRepository,
  upsertTicket,
  verifyAuditChain,
  withTenant,
  writeOutbox,
  event,
  relayOutbox,
  listPages,
} from "../src/index.ts";

const disk = async (p: string) => {
  try {
    return readFileSync(join(ACME_ROOT, p), "utf8");
  } catch {
    return null;
  }
};

async function snapshotFor(read: (p: string) => Promise<string | null>, commitSha: string) {
  const loaded = parseConfig(acmeFile("docops.yaml"));
  const result = await runChecks({ repoRoot: ACME_ROOT, loaded, readHead: read });
  return buildSnapshot({
    repository: { provider: "github", fullName: "acme/payments" },
    commitSha,
    committedAt: new Date().toISOString(),
    ref: "refs/heads/main",
    spaceKey: loaded.config.project.id,
    spaceName: loaded.config.project.name,
    docsRoot: "docs",
    configDigest: loaded.digest,
    sources: result.sources,
    pages: result.pages,
    entities: result.headEntities,
    references: result.headRefs,
  });
}

async function setup() {
  const db = await createPgliteClient();
  await migrate(db);
  const tenant = await asPlatform(db, (tx) => createTenant(tx, { slug: "acme", name: "Acme" }));
  const repo = await withTenant(db, tenant.id, (tx) => upsertRepository(tx, tenant.id, { provider: "github", fullName: "acme/payments" }));
  return { db, tenant, repo };
}

test("snapshots build the content graph; a later snapshot makes pages stale", async () => {
  const { db, tenant, repo } = await setup();
  const base = await snapshotFor(disk, "a".repeat(40));
  const applied = await withTenant(db, tenant.id, (tx) => applySnapshot(tx, tenant.id, repo.id, base, { jiraSite: "acme.atlassian.net" }));
  assert.equal(applied.pages, 5);
  assert.ok(applied.references > 10);

  const coverage = await withTenant(db, tenant.id, (tx) => coverageForSpace(tx, applied.spaceId, "api.operation"));
  assert.deepEqual(coverage, [{ kind: "api.operation", public_entities: 5, documented_l1: 5, documented_l2: 5 }]);

  // Head changes the API and config but not the docs: referencing pages become stale.
  const head = await snapshotFor(async (p) => (p === "api/openapi.yaml" ? acmeHeadOpenApi() : p === "config/schema.json" ? acmeHeadConfigSchema() : disk(p)), "b".repeat(40));
  const second = await withTenant(db, tenant.id, (tx) => applySnapshot(tx, tenant.id, repo.id, head));
  assert.ok(second.changedEntities >= 2);
  const pages = await withTenant(db, tenant.id, (tx) => listPages(tx, applied.spaceId, { limit: 50 }));
  const stale = await withTenant(db, tenant.id, (tx) => stalePageIds(tx, pages.map((p) => p.id)));
  const stalePaths = pages.filter((p) => stale.has(p.id)).map((p) => p.path).sort();
  assert.deepEqual(stalePaths, ["guides/payments.md", "runbooks/payments-outage.md"]);
  await db.close();
});

test("ticket docs status and release readiness from links, PRs and pages", async () => {
  const { db, tenant, repo } = await setup();
  const snapshot = await snapshotFor(disk, "a".repeat(40));
  await withTenant(db, tenant.id, (tx) => applySnapshot(tx, tenant.id, repo.id, snapshot, { jiraSite: "acme.atlassian.net" }));
  const mirror = (key: string, docsRequired: "yes" | "no") => ({
    tracker: "jira" as const,
    site: "acme.atlassian.net",
    externalId: key,
    key,
    projectKey: "PAY",
    title: `Ticket ${key}`,
    issueType: "Story",
    status: "In Progress",
    statusCategory: "in_progress" as const,
    docsRequired,
    fixVersions: ["2.4.0"],
    parentKey: null,
    assignee: null,
    url: `https://acme.atlassian.net/browse/${key}`,
    sourceUpdatedAt: new Date().toISOString(),
  });
  await withTenant(db, tenant.id, async (tx) => {
    await upsertTicket(tx, tenant.id, mirror("PAY-101", "yes")); // frontmatter link on guides/payments.md
    await upsertTicket(tx, tenant.id, mirror("PAY-140", "yes")); // nothing linked
    await upsertTicket(tx, tenant.id, mirror("PAY-150", "no"));
    const t = await upsertTicket(tx, tenant.id, mirror("PAY-160", "yes"));
    const pr = await upsertPullRequest(tx, tenant.id, {
      repositoryId: repo.id,
      number: 482,
      title: "PAY-160 document webhooks",
      state: "open",
      url: "https://github.com/acme/payments/pull/482",
      touchesDocs: true,
      sourceUpdatedAt: new Date().toISOString(),
    });
    await createLink(tx, tenant.id, { ticketId: t.id, targetType: "pull_request", targetId: pr, source: "pr_title", createdBy: "webhook" });
  });
  const view = await withTenant(db, tenant.id, async (tx) => ticketDocsView(tx, (await getTicketByKey(tx, "PAY-101"))!));
  assert.equal(view.status, "merged");
  assert.deepEqual(view.pages.map((p) => p.path), ["guides/payments.md"]);
  const readiness = await withTenant(db, tenant.id, (tx) => readinessForFixVersion(tx, "PAY", "2.4.0"));
  assert.deepEqual(readiness.items.map((i) => [i.view.ticket.key, i.docsStatus]), [
    ["PAY-140", "missing"],
    ["PAY-160", "in_review"],
    ["PAY-101", "merged"],
    ["PAY-150", "not_required"],
  ]);
  assert.equal(readiness.summary.readyPercent, 50);
  assert.equal(readiness.summary.blockers, 1);
  await db.close();
});

test("check runs, dismissals by fingerprint, CAS builds and promotions", async () => {
  const { db, tenant, repo } = await setup();
  const finding = { ruleId: "drift/stale-value", category: "drift", severity: "error" as const, origin: "deterministic" as const, message: "m", file: "docs/a.md", line: 3, evidence: {}, fingerprint: "fp-1" };
  const run = await withTenant(db, tenant.id, (tx) => recordCheckRun(tx, tenant.id, { repositoryId: repo.id, headSha: "c".repeat(40), conclusion: "failure", summary: {}, findings: [finding] }));
  const [stored] = await withTenant(db, tenant.id, (tx) => listFindings(tx, { checkRunId: run.id, limit: 10 }));
  assert.equal(stored?.state, "open");
  await withTenant(db, tenant.id, (tx) => dismissFinding(tx, stored!.id, { reason: "false_positive", actor: "user:rita" }));
  const rerun = await withTenant(db, tenant.id, (tx) => recordCheckRun(tx, tenant.id, { repositoryId: repo.id, headSha: "d".repeat(40), conclusion: "failure", summary: {}, findings: [finding] }));
  assert.deepEqual(rerun.dismissed, ["fp-1"], "dismissals persist across runs by fingerprint");

  const snapshot = await snapshotFor(disk, "a".repeat(40));
  const { spaceId } = await withTenant(db, tenant.id, (tx) => applySnapshot(tx, tenant.id, repo.id, snapshot));
  const files = [
    { path: "index.html", digest: "1".repeat(64), size: 10, contentType: "text/html" },
    { path: "a/index.html", digest: "2".repeat(64), size: 20, contentType: "text/html" },
  ];
  await withTenant(db, tenant.id, (tx) => recordBlob(tx, tenant.id, "1".repeat(64), 10, "text/html"));
  const created = await withTenant(db, tenant.id, (tx) =>
    createBuild(tx, tenant.id, { spaceId, versionName: "latest", audience: "public", commitSha: "a".repeat(40), kind: "branch", files, createdBy: "ci", manifestDigest: "f".repeat(64) }),
  );
  assert.deepEqual(created.missing, ["2".repeat(64)], "only unknown digests must be uploaded");
  const ready = await withTenant(db, tenant.id, (tx) => finalizeBuild(tx, created.build.id, { signature: "sig", previewUrl: null }));
  const first = await withTenant(db, tenant.id, (tx) => promoteBuild(tx, tenant.id, ready!, { environment: "prod", promotedBy: "ci", url: null }));
  const second = await withTenant(db, tenant.id, (tx) => promoteBuild(tx, tenant.id, ready!, { environment: "prod", promotedBy: "ci", url: null }));
  const statuses = await withTenant(db, tenant.id, async (tx) => (await tx.query<{ id: string; status: string }>("SELECT id, status FROM deployments ORDER BY promoted_at, id")).rows);
  assert.deepEqual(statuses.map((s) => [s.id, s.status]), [[first.id, "superseded"], [second.id, "active"]]);
  await db.close();
});

test("job queue: claim with SKIP LOCKED, retry with backoff, dead-letter; outbox relay; idempotency", async () => {
  const { db, tenant } = await setup();
  await asPlatform(db, (tx) => enqueueJob(tx, { tenantId: tenant.id, queue: "tracker.sync", payload: { key: "PAY-1" }, coalesceKey: "PAY-1" }));
  await asPlatform(db, (tx) => enqueueJob(tx, { tenantId: tenant.id, queue: "tracker.sync", payload: { key: "PAY-1", v: 2 }, coalesceKey: "PAY-1" }));
  const claimed = await asPlatform(db, (tx) => claimJobs(tx, ["tracker.sync"], "w1"));
  assert.equal(claimed.length, 1, "coalesced");
  assert.deepEqual(claimed[0]?.payload, { key: "PAY-1", v: 2 });
  assert.equal((await asPlatform(db, (tx) => claimJobs(tx, ["tracker.sync"], "w2"))).length, 0, "claimed jobs are invisible to others");
  const job = claimed[0]!;
  assert.equal(await asPlatform(db, (tx) => failJob(tx, job, "boom")), "retry");
  assert.equal(await asPlatform(db, (tx) => failJob(tx, { ...job, attempts: 10 }, "boom")), "dead");
  await asPlatform(db, (tx) => completeJob(tx, job.id));

  await withTenant(db, tenant.id, (tx) => writeOutbox(tx, event(tenant.id, "docops.ticket.links_changed", { key: "PAY-1" }), `${tenant.id}:PAY-1`));
  assert.equal(await asPlatform(db, (tx) => relayOutbox(tx)), 1);
  const relayed = await asPlatform(db, (tx) => claimJobs(tx, ["tracker.sync"], "w3"));
  assert.equal((relayed[0]?.payload.event as { type: string }).type, "docops.ticket.links_changed");

  assert.equal(await asPlatform(db, (tx) => markProcessed(tx, "tracker.sync", "evt-1")), true);
  assert.equal(await asPlatform(db, (tx) => markProcessed(tx, "tracker.sync", "evt-1")), false);
  const delivery = { provider: "github" as const, deliveryId: "d-1", eventType: "pull_request", tenantId: tenant.id, signatureValid: true, status: "accepted" as const, payloadDigest: "x" };
  assert.equal(await asPlatform(db, (tx) => recordDelivery(tx, delivery)), "accepted");
  assert.equal(await asPlatform(db, (tx) => recordDelivery(tx, delivery)), "duplicate");
  await db.close();
});

test("audit hash chain verifies and detects tampering", async () => {
  const { db, tenant } = await setup();
  for (let i = 0; i < 3; i++) {
    await withTenant(db, tenant.id, (tx) =>
      appendAudit(tx, tenant.id, { actor: { type: "user", id: `u${i}`, ip: "203.0.113.7" }, action: "deployment.promoted", resource: { type: "build", id: `b${i}` }, outcome: "success", details: { env: "prod", n: i } }),
    );
  }
  const records = await withTenant(db, tenant.id, (tx) => listAudit(tx, { limit: 10 }));
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3]);
  assert.equal(verifyAuditChain(records), null);
  const tampered = records.map((r) => (r.seq === 2 ? { ...r, details: { env: "dev", n: 1 } } : r));
  assert.equal(verifyAuditChain(tampered), 2);
  await db.close();
});
