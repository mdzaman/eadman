import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractJsonSchemaConfig, extractOpenApi, extractSource, OpenApiError } from "../src/index.ts";

const acme = (p: string) => readFileSync(new URL(`../../../examples/acme-payments/${p}`, import.meta.url), "utf8");
const docopsApi = readFileSync(new URL("../../../api/openapi.yaml", import.meta.url), "utf8");

test("extracts operations, parameters, schemas and properties with stable keys", () => {
  const entities = extractOpenApi({ sourceKey: "payments-api", path: "api/openapi.yaml", content: acme("api/openapi.yaml") });
  const byKey = new Map(entities.map((e) => [e.key, e]));
  const ops = entities.filter((e) => e.kind === "api.operation");
  assert.equal(ops.length, 6);

  const create = byKey.get("api.operation:payments-api:POST /v1/payments");
  assert.ok(create);
  assert.equal(create.name, "createPayment");
  assert.deepEqual(create.surfaceForms, ["POST /v1/payments", "/v1/payments", "createPayment"]);
  assert.deepEqual(create.related, ["api.schema:payments-api:Payment", "api.schema:payments-api:PaymentCreate"]);
  assert.equal(create.location?.file, "api/openapi.yaml");
  assert.ok((create.location?.line ?? 0) > 18);

  assert.equal(byKey.get("api.operation:payments-api:POST /v1/payments/{payment_id}/reconcile")?.visibility, "internal");
  const amount = byKey.get("api.property:payments-api:PaymentCreate.amount");
  assert.equal(amount?.parentKey, "api.schema:payments-api:PaymentCreate");
  assert.deepEqual(amount?.attributes.required, true);
  // Path-level parameters are merged into each operation.
  assert.ok(byKey.has("api.parameter:payments-api:GET /v1/payments/{payment_id}:path.payment_id"));
  // $ref'd component parameters resolve.
  assert.ok(byKey.has("api.parameter:payments-api:POST /v1/payments:header.Idempotency-Key"));
});

test("fingerprints change only when the definition changes", () => {
  const base = extractOpenApi({ sourceKey: "s", path: "a.yaml", content: acme("api/openapi.yaml") });
  const reordered = extractOpenApi({
    sourceKey: "s",
    path: "a.yaml",
    content: acme("api/openapi.yaml").replace("enum: [pending, succeeded, failed, refunded]", "enum: [pending, succeeded, failed, refunded] # comment"),
  });
  assert.deepEqual(base.map((e) => e.fingerprint), reordered.map((e) => e.fingerprint));
  const changed = extractOpenApi({
    sourceKey: "s",
    path: "a.yaml",
    content: acme("api/openapi.yaml").replace("default: 20", "default: 25"),
  });
  const before = base.find((e) => e.key === "api.parameter:s:GET /v1/payments:query.limit");
  const after = changed.find((e) => e.key === "api.parameter:s:GET /v1/payments:query.limit");
  assert.notEqual(before?.fingerprint, after?.fingerprint);
});

test("extracts webhooks from OpenAPI 3.1 (DocOps' own spec)", () => {
  const entities = extractOpenApi({ sourceKey: "docops-api", path: "api/openapi.yaml", content: docopsApi });
  assert.equal(entities.filter((e) => e.kind === "api.webhook").length, 12);
  assert.equal(entities.filter((e) => e.kind === "api.operation").length, 63);
});

test("extracts config keys from JSON Schema", () => {
  const entities = extractJsonSchemaConfig({ sourceKey: "payments-config", path: "config/schema.json", content: acme("config/schema.json"), visibility: "internal" });
  const timeout = entities.find((e) => e.name === "PAYMENTS_TIMEOUT_MS");
  assert.equal(timeout?.key, "config.key:payments-config:PAYMENTS_TIMEOUT_MS");
  assert.equal(timeout?.attributes.default, 30000);
  assert.equal(timeout?.visibility, "internal");
  assert.equal(entities.find((e) => e.name === "PAYMENTS_WEBHOOK_SECRET")?.attributes.required, true);
});

test("refuses remote $refs and non-OpenAPI documents", () => {
  assert.throws(() => extractOpenApi({ sourceKey: "s", path: "x", content: "foo: bar" }), OpenApiError);
  const remote = "openapi: 3.1.0\npaths:\n  /a:\n    get:\n      parameters:\n        - $ref: 'https://evil.example/p.yaml'\n      responses: {}\n";
  assert.throws(() => extractOpenApi({ sourceKey: "s", path: "x", content: remote }), /remote \$ref not allowed/);
  assert.match(extractSource("terraform", { sourceKey: "t", path: "x", content: "" }).warning ?? "", /no extractor/);
});
