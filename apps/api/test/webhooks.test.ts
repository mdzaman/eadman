import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { asPlatform, withTenant } from "@docops/db";
import { signGithubPayload } from "@docops/github";
import { createTestEnv, GITHUB_SECRET, JIRA_SECRET } from "./helpers.ts";

const prPayload = (installationId = 4242) =>
  JSON.stringify({
    action: "opened",
    installation: { id: installationId },
    repository: { full_name: "acme/payments" },
    pull_request: {
      number: 7,
      title: "PAY-123 partial refunds",
      body: "",
      state: "open",
      merged: false,
      head: { ref: "feature/PAY-123", sha: "a".repeat(40) },
      base: { ref: "main" },
      html_url: "https://github.com/acme/payments/pull/7",
      labels: [],
      updated_at: "2026-10-18T10:00:00Z",
    },
  });

const github = (body: string, delivery: string, signature = signGithubPayload(GITHUB_SECRET, body)) => ({
  method: "POST",
  body,
  headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": delivery, "x-hub-signature-256": signature },
});

test("GitHub webhook: rejects bad signatures, accepts valid ones once, writes an outbox event", async () => {
  const env = await createTestEnv();
  const body = prPayload();

  const forged = await env.request("/hooks/github", github(body, "d-1", signGithubPayload("wrong-secret", body)));
  assert.equal(forged.status, 401);

  const ok = await env.request("/hooks/github", github(body, "d-2"));
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { status: "accepted" });

  const replay = await env.request("/hooks/github", github(body, "d-2"));
  assert.deepEqual(await replay.json(), { status: "duplicate" });

  const unknownInstallation = await env.request("/hooks/github", github(prPayload(999), "d-3"));
  assert.deepEqual(await unknownInstallation.json(), { status: "ignored" });

  const outbox = await withTenant(env.deps.db, env.tenantId, async (tx) => (await tx.query<{ event_type: string; event: { id: string; data: { number: number; title: string } } }>("SELECT event_type, event FROM outbox")).rows);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.event_type, "docops.git.pull_request.opened");
  assert.equal(outbox[0]?.event.id, "d-2", "event id = delivery id (idempotent downstream)");
  assert.equal(outbox[0]?.event.data.title, "PAY-123 partial refunds");

  const deliveries = await asPlatform(env.deps.db, async (tx) => (await tx.query<{ delivery_id: string; status: string; signature_valid: boolean }>("SELECT delivery_id, status, signature_valid FROM webhook_deliveries ORDER BY delivery_id")).rows);
  assert.deepEqual(deliveries.map((d) => [d.delivery_id, d.status, d.signature_valid]), [
    ["d-1", "rejected", false],
    ["d-2", "accepted", true],
    ["d-3", "accepted", true],
  ]);
});

test("Jira webhook: HMAC X-Hub-Signature and tenant routing", async () => {
  const env = await createTestEnv();
  const body = JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { id: "10123", key: "PAY-123" } });
  const sig = `sha256=${createHmac("sha256", JIRA_SECRET).update(body).digest("hex")}`;
  const bad = await env.request("/hooks/jira?tenant=acme", { method: "POST", body, headers: { "x-hub-signature": "sha256=00", "x-atlassian-webhook-identifier": "j-1" } });
  assert.equal(bad.status, 401);
  const good = await env.request("/hooks/jira?tenant=acme", { method: "POST", body, headers: { "x-hub-signature": sig, "x-atlassian-webhook-identifier": "j-2" } });
  assert.equal(good.status, 202);
  const events = await withTenant(env.deps.db, env.tenantId, async (tx) => (await tx.query<{ event_type: string }>("SELECT event_type FROM outbox")).rows);
  assert.deepEqual(events.map((e) => e.event_type), ["docops.tracker.issue_updated"]);
});

test("unauthenticated and unknown routes return RFC 9457 problems", async () => {
  const env = await createTestEnv();
  const res = await env.request("/v1/me");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  const problem = (await res.json()) as { type: string; status: number; traceId: string };
  assert.equal(problem.status, 401);
  assert.match(problem.type, /^https:\/\/docs\.docops\.example\/errors\//);
  assert.ok(problem.traceId);
  assert.equal((await env.request("/v1/nope", { token: env.tokens.owner })).status, 404);
  const health = await env.request("/healthz");
  assert.deepEqual(await health.json(), { status: "ok", version: "test", checks: { database: "ok" } });
});
