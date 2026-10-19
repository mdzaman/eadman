import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAudit, asPlatform, createApiToken, createPgliteClient, createTenant, ensureServiceAccount, lookupApiToken, migrate, withTenant } from "../src/index.ts";

async function setup() {
  const db = await createPgliteClient();
  await migrate(db);
  const [acme, globex] = await asPlatform(db, async (tx) => [await createTenant(tx, { slug: "acme", name: "Acme" }), await createTenant(tx, { slug: "globex", name: "Globex", region: "eu" })]);
  return { db, acme: acme!, globex: globex! };
}

test("tenant isolation is enforced by row-level security", async () => {
  const { db, acme, globex } = await setup();
  await withTenant(db, acme.id, (tx) => ensureServiceAccount(tx, acme.id, "ci-acme"));
  await withTenant(db, globex.id, (tx) => ensureServiceAccount(tx, globex.id, "ci-globex"));

  const seenByAcme = await withTenant(db, acme.id, async (tx) => (await tx.query<{ name: string }>("SELECT name FROM service_accounts")).rows.map((r) => r.name));
  assert.deepEqual(seenByAcme, ["ci-acme"], "a query without WHERE tenant_id still only sees its own rows");

  const noContext = await asPlatform(db, async (tx) => (await tx.query("SELECT * FROM service_accounts")).rows.length);
  assert.equal(noContext, 0, "no tenant context, no tenant rows");

  await assert.rejects(
    withTenant(db, acme.id, (tx) => tx.query("INSERT INTO service_accounts (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'evil')", [globex.id])),
    /row-level security/,
    "cross-tenant writes are rejected",
  );
  await db.close();
});

test("API tokens resolve to their tenant through the SECURITY DEFINER lookup only", async () => {
  const { db, acme } = await setup();
  const sa = await withTenant(db, acme.id, (tx) => ensureServiceAccount(tx, acme.id, "ci"));
  const token = await withTenant(db, acme.id, (tx) => createApiToken(tx, { tenantId: acme.id, principalType: "service_account", principalId: sa, name: "ci", scopes: ["checks:write"] }));
  assert.match(token.secret, /^dop_[A-Za-z0-9]{32}$/);
  const principal = await asPlatform(db, (tx) => lookupApiToken(tx, token.secret));
  assert.equal(principal?.tenantId, acme.id);
  assert.deepEqual(principal?.scopes, ["checks:write"]);
  assert.equal(await asPlatform(db, (tx) => lookupApiToken(tx, "dop_doesnotexist0000000000000000")), null);
  const direct = await asPlatform(db, async (tx) => (await tx.query("SELECT * FROM api_tokens")).rows.length);
  assert.equal(direct, 0, "the app role cannot read token rows across tenants");
  await db.close();
});

test("audit events are append-only", async () => {
  const { db, acme } = await setup();
  await withTenant(db, acme.id, (tx) => appendAudit(tx, acme.id, { actor: { type: "system", id: "test" }, action: "test.ran", resource: { type: "test" }, outcome: "success" }));
  await assert.rejects(withTenant(db, acme.id, (tx) => tx.query("UPDATE audit_events SET action = 'tampered'")), /permission denied|append-only/);
  await assert.rejects(withTenant(db, acme.id, (tx) => tx.query("DELETE FROM audit_events")), /permission denied|append-only/);
  await db.close();
});
