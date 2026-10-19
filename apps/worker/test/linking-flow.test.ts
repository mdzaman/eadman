import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { runChecks } from "@docops/checks";
import { parseConfig } from "@docops/config";
import { uuidv7 } from "@docops/core";
import { withTenant } from "@docops/db";
import { buildSnapshot } from "@docops/engine";
import { GitHubClient, signGithubPayload } from "@docops/github";
import { ACME_ROOT, acmeFile } from "../../../packages/engine/test/fixtures.ts";
import { createTestEnv, GITHUB_SECRET, JIRA_SECRET } from "../../api/test/helpers.ts";
import { signStandardWebhook, Worker } from "../src/index.ts";

/** A fake GitHub REST API: PR state and changed files (the worker confirms state before acting). */
function fakeGitHub(state: { merged: boolean }) {
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/pulls/7")) return Response.json({ state: state.merged ? "closed" : "open", merged: state.merged, merge_commit_sha: state.merged ? "f".repeat(40) : null, head: { sha: "b".repeat(40) } });
    if (u.includes("/pulls/7/files")) return Response.json([{ filename: "docs/guides/refunds.md", status: "modified" }, { filename: "api/openapi.yaml", status: "modified" }]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return new GitHubClient({ token: "installation-token", fetch: impl });
}

const prWebhook = (action: string, merged: boolean, delivery: string) => {
  const body = JSON.stringify({
    action,
    installation: { id: 4242 },
    repository: { full_name: "acme/payments" },
    pull_request: {
      number: 7,
      title: "PAY-123 Document partial refunds",
      body: "Closes the docs gap for partial refunds.",
      state: merged ? "closed" : "open",
      merged,
      merged_at: merged ? "2026-10-18T12:00:00Z" : null,
      head: { ref: "feature/PAY-123-partial-refunds", sha: "b".repeat(40) },
      base: { ref: "main" },
      html_url: "https://github.com/acme/payments/pull/7",
      labels: [],
      updated_at: merged ? "2026-10-18T12:00:00Z" : "2026-10-18T10:00:00Z",
    },
  });
  return { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": delivery, "x-hub-signature-256": signGithubPayload(GITHUB_SECRET, body) } };
};

test("Jira linking flow: PR webhook → links → docs status pushed to Jira → merge → publish", async () => {
  const env = await createTestEnv();
  const loaded = parseConfig(acmeFile("docops.yaml"));
  const r = await runChecks({ repoRoot: ACME_ROOT, loaded });
  const snapshot = buildSnapshot({ repository: { provider: "github", fullName: "acme/payments" }, commitSha: "a".repeat(40), ref: "refs/heads/main", committedAt: "2026-10-01T00:00:00.000Z", spaceKey: "payments", docsRoot: "docs", sources: r.sources, pages: r.pages, entities: r.headEntities, references: r.headRefs });
  assert.equal((await env.request("/v1/snapshots", { method: "POST", token: env.tokens.ci, json: snapshot })).status, 202);

  const gh = { merged: false };
  const deliveries: Array<{ headers: Headers; body: string }> = [];
  const worker = new Worker({
    db: env.deps.db,
    publicUrl: "http://docops.test",
    jira: () => env.jira,
    github: () => fakeGitHub(gh),
    linkPolicy: () => ({ linkFrom: ["pr_title", "branch_name"], projects: ["PAY"], docsRequired: { issueTypes: ["Story", "Bug"] }, statusFieldKey: "docs-status" }),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      deliveries.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    log: () => {},
  });

  // Outbound webhook subscription for status changes (Standard Webhooks signing).
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  await withTenant(env.deps.db, env.tenantId, (tx) =>
    tx.query("INSERT INTO webhook_subscriptions (id, tenant_id, url, event_types, secret_ciphertext, created_by) VALUES ($1,$2,$3,$4::text[],$5,'test')", [
      uuidv7(), env.tenantId, "https://hooks.acme.example/docops", ["docops.ticket.docs_status_changed"], Buffer.from(secret),
    ]),
  );

  // 1. PR opened: links from title + branch, PR touches docs → In review.
  assert.equal((await env.request("/hooks/github", prWebhook("opened", false, "d-1"))).status, 202);
  const first = await worker.runOnce();
  assert.equal(first.failed, 0);
  let property = env.jira.properties.get("PAY-123/docops.docs") as { status: string; required: string; pullRequests: Array<{ number: number; state: string }> };
  assert.equal(property.status, "in_review");
  assert.equal(property.required, "yes");
  assert.deepEqual(property.pullRequests, [{ repo: "acme/payments", number: 7, state: "open" }]);
  assert.equal(env.jira.fieldValues.get("docs-status/10123"), "In review");
  const links = await withTenant(env.deps.db, env.tenantId, async (tx) => (await tx.query<{ source: string }>("SELECT l.source FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE t.key = 'PAY-123' AND l.target_type = 'pull_request' ORDER BY source")).rows.map((x) => x.source));
  assert.deepEqual(links, ["branch_name", "pr_title"], "provenance of each link is recorded");

  // 2. PR merged (state confirmed against the GitHub API) → Merged.
  gh.merged = true;
  await env.request("/hooks/github", prWebhook("closed", true, "d-2"));
  await worker.runOnce();
  property = env.jira.properties.get("PAY-123/docops.docs") as typeof property;
  assert.equal(property.status, "merged");
  assert.equal(env.jira.fieldValues.get("docs-status/10123"), "Merged");

  // 3. Promote a build to prod → Published, with a remote link to the live page.
  const html = "<!doctype html><html lang=en><title>Refunds</title></html>";
  const digest = createHash("sha256").update(html).digest("hex");
  const build = (await (await env.request("/v1/builds", { method: "POST", token: env.tokens.ci, json: { spaceKey: "payments", commitSha: "f".repeat(40), kind: "release", audience: "public", manifest: { files: [{ path: "guides/refunds/index.html", digest, size: html.length, contentType: "text/html" }] } } })).json()) as { build: { id: string } };
  await env.request(`/v1/blobs/${digest}`, { method: "PUT", token: env.tokens.ci, body: html, headers: { "content-type": "text/html" } });
  await env.request(`/v1/builds/${build.build.id}/finalize`, { method: "POST", token: env.tokens.ci });
  assert.equal((await env.request("/v1/deployments", { method: "POST", token: env.tokens.ci, json: { buildId: build.build.id, environment: "prod" } })).status, 201);
  await worker.runOnce();
  property = env.jira.properties.get("PAY-123/docops.docs") as typeof property;
  assert.equal(property.status, "published");
  const remote = env.jira.remoteLinks.get("PAY-123") ?? [];
  assert.ok(remote.some((l) => l.globalId.startsWith("docops:page:") && l.url === "http://docops.test/sites/acme/payments/prod/guides/refunds/"));
  assert.ok(remote.some((l) => l.globalId === "docops:pr:github:acme/payments#7" && l.resolved === true));

  // 4. Redelivery and re-runs are idempotent: no duplicate links, no extra work.
  const before = env.jira.calls.length;
  assert.deepEqual(await (await env.request("/hooks/github", prWebhook("closed", true, "d-2"))).json(), { status: "duplicate" });
  assert.deepEqual(await worker.runOnce(), { relayed: 0, processed: 0, failed: 0 });
  assert.equal(env.jira.calls.length, before);

  // 5. Jira-side change arrives by webhook → mirror updated → status recomputed and pushed.
  env.jira.issues.set("PAY-140", { ...env.jira.issues.get("PAY-140")!, fields: { ...env.jira.issues.get("PAY-140")!.fields, summary: "Webhook retries (renamed)", updated: "2026-10-18T13:00:00.000Z" } });
  const jiraBody = JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { id: "10140", key: "PAY-140" } });
  await env.request("/hooks/jira?tenant=acme", { method: "POST", body: jiraBody, headers: { "x-hub-signature": `sha256=${createHmac("sha256", JIRA_SECRET).update(jiraBody).digest("hex")}`, "x-atlassian-webhook-identifier": "j-1" } });
  await worker.runOnce();
  assert.equal((env.jira.properties.get("PAY-140/docops.docs") as { status: string }).status, "missing");

  // 6. Status changes were delivered to the subscriber with verifiable Standard Webhooks signatures.
  const statusEvents = deliveries.map((d) => JSON.parse(d.body) as { type: string; data: { ticketKey: string; current: string } });
  assert.deepEqual(statusEvents.filter((e) => e.data.ticketKey === "PAY-123").map((e) => e.data.current), ["in_review", "merged", "published"]);
  for (const d of deliveries) {
    const id = d.headers.get("webhook-id")!;
    const ts = Number(d.headers.get("webhook-timestamp"));
    assert.equal(d.headers.get("webhook-signature"), signStandardWebhook(secret, id, ts, d.body));
  }
});
