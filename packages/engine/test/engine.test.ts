import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPages } from "@docops/markdown";
import { extractJsonSchemaConfig, extractOpenApi } from "@docops/extractors";
import {
  buildReferenceIndex,
  computeCoverage,
  computeDocsStatus,
  detectDrift,
  diffEntities,
  findHttpRequests,
  isDistinctive,
  summarizeReadiness,
} from "../src/index.ts";
import { ACME_ROOT, acmeFile, acmeHeadConfigSchema, acmeHeadOpenApi } from "./fixtures.ts";

async function scenario() {
  const { pages } = await loadPages(`${ACME_ROOT}docs`, {
    include: ["**/*.md"],
    exclude: [],
    snippetsDir: "_snippets",
    defaultPageType: "guide",
  });
  const extract = (openapi: string, config: string) => [
    ...extractOpenApi({ sourceKey: "payments-api", path: "api/openapi.yaml", content: openapi }),
    ...extractJsonSchemaConfig({ sourceKey: "payments-config", path: "config/schema.json", content: config, visibility: "internal" }),
  ];
  const base = extract(acmeFile("api/openapi.yaml"), acmeFile("config/schema.json"));
  const head = extract(acmeHeadOpenApi(), acmeHeadConfigSchema());
  return { pages, base, head };
}

test("distinctive vs generic surface forms", () => {
  for (const form of ["amount_cents", "PAYMENTS_TIMEOUT_MS", "createPayment", "/v1/payments", "POST /v1/payments", "PaymentCreate"]) {
    assert.ok(isDistinctive(form), form);
  }
  for (const form of ["amount", "limit", "status", "Payment", "currency"]) assert.ok(!isDistinctive(form), form);
});

test("finds HTTP requests in curl, fetch and raw HTTP samples", () => {
  const curl = 'curl -X POST {{ apiBaseUrl }}/v1/payments \\\n  -H "A: b" \\\n  -d \'{"amount": 1}\'';
  assert.deepEqual(findHttpRequests(curl), [{ method: "POST", path: "/v1/payments", lineOffset: 0 }]);
  assert.deepEqual(findHttpRequests("curl https://api.acme.example/v1/payments/pay_1?expand=x"), [{ method: "GET", path: "/v1/payments/pay_1", lineOffset: 0 }]);
  assert.deepEqual(findHttpRequests('const r = await fetch(`${base}/v1/refunds`, {\n  method: "POST",\n})'), [{ method: "POST", path: "/v1/refunds", lineOffset: 0 }]);
  assert.deepEqual(findHttpRequests("DELETE /v1/x/1 HTTP/1.1\nHost: a"), [{ method: "DELETE", path: "/v1/x/1", lineOffset: 0 }]);
});

test("reference index: explicit, code sample, contextual mentions", async () => {
  const { pages, base } = await scenario();
  const index = buildReferenceIndex(pages, base);
  const payments = index.byPage.get("guides/payments.md") ?? [];
  const keys = (kind: string) => new Set(payments.filter((r) => r.kind === kind).map((r) => r.entityKey));
  assert.ok(keys("explicit").has("api.operation:payments-api:POST /v1/payments"));
  assert.ok(keys("code_sample").has("api.property:payments-api:PaymentCreate.amount"), "JSON body key in curl sample");
  assert.ok(keys("mention").has("api.operation:payments-api:POST /v1/payments/{payment_id}/capture"));
  assert.ok(keys("mention").has("api.property:payments-api:PaymentCreate.amount"), "generic `amount` resolved by context");
  // `amount` on the refunds page belongs to the refund schemas, not to PaymentCreate.
  const refunds = (index.byPage.get("guides/refunds.md") ?? []).map((r) => r.entityKey);
  assert.ok(refunds.includes("api.property:payments-api:RefundCreate.amount"));
  assert.ok(!refunds.includes("api.property:payments-api:PaymentCreate.amount"));
  // Config keys in the runbook table.
  assert.ok((index.byPage.get("runbooks/payments-outage.md") ?? []).some((r) => r.entityKey === "config.key:payments-config:PAYMENTS_TIMEOUT_MS"));
  assert.deepEqual(index.unresolved, []);
});

test("entity diff: rename detection, breaking classification, literal deltas", async () => {
  const { base, head } = await scenario();
  const changes = diffEntities(base, head);
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const rename = byKey.get("api.property:payments-api:PaymentCreate.amount");
  assert.equal(rename?.type, "renamed");
  assert.equal(rename?.renamedTo, "api.property:payments-api:PaymentCreate.amount_cents");
  assert.equal(rename?.breaking, true);
  assert.equal(byKey.get("api.operation:payments-api:GET /v1/refunds/{refund_id}")?.type, "added");
  const timeout = byKey.get("config.key:payments-config:PAYMENTS_TIMEOUT_MS");
  assert.equal(timeout?.type, "modified");
  assert.deepEqual(timeout?.deltas, [{ path: "default", before: 30000, after: 60000 }]);
  assert.equal(timeout?.breaking, false, "internal config is never breaking");
  assert.equal(timeout?.userVisible, true);
  // Description-only edits are not user-visible.
  const cosmetic = diffEntities(base, base.map((e) => (e.key.endsWith("PaymentCreate.capture") ? { ...e, fingerprint: "x", attributes: { ...e.attributes, description: "new words" } } : e)));
  assert.equal(cosmetic.length, 1);
  assert.equal(cosmetic[0]?.userVisible, false);
});

test("drift rules on the canonical scenario", async () => {
  const { pages, base, head } = await scenario();
  const changes = diffEntities(base, head);
  const findings = detectDrift({
    changes,
    baseRefs: buildReferenceIndex(pages, base),
    headRefs: buildReferenceIndex(pages, head),
    pages,
    docsRoot: "docs",
    changedFiles: new Set(["api/openapi.yaml", "config/schema.json"]),
    sourcePaths: new Map([["payments-api", "api/openapi.yaml"], ["payments-config", "config/schema.json"]]),
    levels: { drift: "block", changedEntity: "warn", schemaChange: "block", newEntities: "warn" },
    coverageKinds: ["api.operation"],
    includeDeprecated: false,
    baseEntities: base,
    headEntities: head,
  });
  const rules = findings.map((f) => `${f.ruleId} ${f.file}:${f.line ?? ""}`).sort();
  const stale = findings.filter((f) => f.ruleId === "drift/stale-reference");
  assert.deepEqual(stale.map((f) => f.line).sort(), [20, 23], rules.join("\n"));
  const prose = stale.find((f) => f.line === 23);
  assert.equal(prose?.severity, "error");
  assert.equal(prose?.suggestion?.replacement, "Set `amount_cents` in minor currency units: `2000` is $20.00. The `currency` must be `usd`, `eur` or `gbp`.");
  assert.match(stale.find((f) => f.line === 20)?.suggestion?.replacement ?? "", /"amount_cents": 2000/);

  const staleValue = findings.find((f) => f.ruleId === "drift/stale-value");
  assert.equal(staleValue?.file, "docs/runbooks/payments-outage.md");
  assert.equal(staleValue?.suggestion?.replacement, "| `PAYMENTS_TIMEOUT_MS` | 60000 | How long to wait for the card processor |");
  assert.ok(!findings.some((f) => f.ruleId === "drift/changed-entity" && f.file === "docs/runbooks/payments-outage.md"), "stale-value supersedes changed-entity");

  const schema = findings.filter((f) => f.ruleId === "schema/changed-without-docs");
  assert.deepEqual(schema.map((f) => f.file).sort(), ["api/openapi.yaml", "config/schema.json"]);
  assert.ok(schema.every((f) => f.severity === "error"));

  const coverage = findings.find((f) => f.ruleId === "coverage/undocumented-entity");
  assert.equal(coverage?.entityKey, "api.operation:payments-api:GET /v1/refunds/{refund_id}");
  assert.equal(coverage?.severity, "warning");

  // Fingerprints are stable across runs.
  const again = detectDrift({
    changes,
    baseRefs: buildReferenceIndex(pages, base),
    headRefs: buildReferenceIndex(pages, head),
    pages,
    docsRoot: "docs",
    changedFiles: new Set(["api/openapi.yaml", "config/schema.json"]),
    sourcePaths: new Map(),
    levels: { drift: "block", changedEntity: "warn", schemaChange: "block", newEntities: "warn" },
    coverageKinds: ["api.operation"],
    includeDeprecated: false,
    baseEntities: base,
    headEntities: head,
  });
  assert.deepEqual(again.map((f) => f.fingerprint).sort(), findings.map((f) => f.fingerprint).sort());
});

test("updating the docs in the same change clears the schema gate; waiver downgrades it", async () => {
  const { pages, base, head } = await scenario();
  const changes = diffEntities(base, head);
  const run = (changedFiles: string[], waived = false) =>
    detectDrift({
      changes,
      baseRefs: buildReferenceIndex(pages, base),
      headRefs: buildReferenceIndex(pages, head),
      pages,
      docsRoot: "docs",
      changedFiles: new Set(changedFiles),
      sourcePaths: new Map([["payments-api", "api/openapi.yaml"]]),
      levels: { drift: "block", changedEntity: "warn", schemaChange: "block", newEntities: "warn" },
      coverageKinds: ["api.operation"],
      includeDeprecated: false,
      waived,
      baseEntities: base,
      headEntities: head,
    }).filter((f) => f.ruleId === "schema/changed-without-docs" && f.file === "api/openapi.yaml");
  assert.equal(run(["api/openapi.yaml", "docs/guides/payments.md"]).length, 0);
  assert.equal(run(["api/openapi.yaml"], true)[0]?.severity, "info");
});

test("coverage L1/L2", async () => {
  const { pages, head } = await scenario();
  const report = computeCoverage(head, buildReferenceIndex(pages, head), {
    kinds: ["api.operation"],
    includeDeprecated: false,
    referenceSources: new Set(["payments-api"]),
  });
  assert.deepEqual(report.totals, { publicEntities: 6, documentedL1: 6, documentedL2: 5, percentL1: 100, percentL2: 83.3 });
  assert.deepEqual(report.undocumented, [{ key: "api.operation:payments-api:GET /v1/refunds/{refund_id}", kind: "api.operation" }]);
});

test("docs status state machine and readiness", () => {
  const pr = (state: "open" | "closed" | "merged", touchesDocs = true) => ({ ref: "acme/payments#1", state, touchesDocs });
  const page = (stale = false, published = false) => ({ path: "guides/refunds.md", stale, published });
  assert.equal(computeDocsStatus({ required: true, pullRequests: [], pages: [] }).status, "missing");
  assert.equal(computeDocsStatus({ required: false, pullRequests: [], pages: [] }).status, "not_required");
  assert.equal(computeDocsStatus({ required: true, pullRequests: [pr("open")], pages: [page(true)] }).status, "in_review");
  assert.equal(computeDocsStatus({ required: true, pullRequests: [pr("merged")], pages: [page(true)] }).status, "stale");
  assert.equal(computeDocsStatus({ required: true, pullRequests: [pr("merged")], pages: [page()] }).status, "merged");
  assert.equal(computeDocsStatus({ required: true, pullRequests: [pr("merged")], pages: [page(false, true)] }).status, "published");
  assert.equal(computeDocsStatus({ required: true, pullRequests: [pr("open", false)], pages: [] }).status, "missing", "code-only PRs are not doc changes");
  assert.equal(computeDocsStatus({ required: false, pullRequests: [pr("merged")], pages: [] }).status, "merged", "docs exist even if not required");

  const summary = summarizeReadiness([
    { docsStatus: "published" },
    { docsStatus: "merged" },
    { docsStatus: "not_required" },
    { docsStatus: "missing" },
    { docsStatus: "in_review" },
  ]);
  assert.equal(summary.readyPercent, 60);
  assert.equal(summary.blockers, 1);
  assert.equal(summary.ready, false);
  assert.equal(summarizeReadiness([]).ready, true);
});
