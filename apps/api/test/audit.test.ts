import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv } from "./helpers.ts";

test("mutations are audited; the auditor reads a verified hash chain; tampering is detected", async () => {
  const env = await createTestEnv();
  await env.request("/v1/repositories", { method: "POST", token: env.tokens.owner, json: { provider: "github", fullName: "acme/payments" } });
  await env.request("/v1/api-tokens", { method: "POST", token: env.tokens.owner, json: { name: "release-bot", scopes: ["checks:write"] } });

  const forbidden = await env.request("/v1/audit-events", { token: env.tokens.ci });
  assert.equal(forbidden.status, 403, "CI tokens cannot read the audit log");

  const res = await env.request("/v1/audit-events", { token: env.tokens.auditor });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ action: string; seq: number; actor: { type: string; authMethod: string } }>; chain: { verified: boolean; firstBrokenSeq: number | null } };
  assert.deepEqual(body.items.map((e) => [e.seq, e.action]), [
    [1, "repository.connected"],
    [2, "token.created"],
  ]);
  assert.equal(body.items[0]?.actor.authMethod, "api_token");
  assert.deepEqual(body.chain, { verified: true, firstBrokenSeq: null });

  // A database administrator bypassing the append-only trigger is still caught by the hash chain.
  await env.deps.db.exec("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_mutation");
  await env.deps.db.exec("UPDATE audit_events SET action = 'repository.disconnected' WHERE seq = 1");
  const after = (await (await env.request("/v1/audit-events", { token: env.tokens.auditor })).json()) as { chain: { verified: boolean; firstBrokenSeq: number | null } };
  assert.deepEqual(after.chain, { verified: false, firstBrokenSeq: 1 });
});
