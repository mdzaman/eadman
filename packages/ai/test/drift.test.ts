import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRIFT_PATCH_SCHEMA,
  DRIFT_VERIFY_SCHEMA,
  DriftAiService,
  MockProvider,
  mockStructuredStatus,
  unifiedDiff,
  type PatchResult,
  type StructuredGenerationRequest,
} from "../src/index.ts";

const passage = [
  "## Check the configuration",
  "",
  "Requests to the card processor time out after 30 seconds.",
  "The processor is retried up to 3 times for idempotent calls.",
  "",
  "| Setting | Default |",
  "|---|---|",
  "| `PAYMENTS_TIMEOUT_MS` | 30000 |",
].join("\n");

const deltas = [{ entityKey: "config.key:payments-config:PAYMENTS_TIMEOUT_MS", path: "default", before: "30000", after: "60000" }];
const grounded = [{ source: "entity_diff", path: "default", before: "30000", after: "60000" }];

function claim(quote: string, overrides: Record<string, unknown> = {}) {
  return { quote, verdict: "now_false", evidence: grounded, explanation: "The default timeout changed from 30000 ms to 60000 ms.", confidence: 0.93, ...overrides };
}

test("verify keeps grounded now_false claims and computes their page line", async () => {
  const provider = new MockProvider({
    structured: () => ({
      claims: [
        claim("Requests to the card processor time out after 30 seconds."),
        claim("| `PAYMENTS_TIMEOUT_MS` | 30000 |", { confidence: 0.81 }),
        claim("The processor is retried up to 3 times for idempotent calls.", { verdict: "still_true" }),
      ],
    }),
  });
  const drift = new DriftAiService({ provider });
  const result = await drift.verify({ pagePath: "runbooks/payments-outage.md", startLine: 12, passage, deltas, codeHunks: ["@@ -1 +1 @@\n-timeout: 30000\n+timeout: 60000"] });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.findings.map((f) => [f.line, f.quote]),
    [
      [14, "Requests to the card processor time out after 30 seconds."],
      [19, "| `PAYMENTS_TIMEOUT_MS` | 30000 |"],
    ],
  );
  assert.equal(result.findings[0]?.pagePath, "runbooks/payments-outage.md");
  assert.equal(result.findings[0]?.confidence, 0.93);
  assert.deepEqual(result.findings[0]?.evidence, grounded);
  assert.deepEqual(result.dropped, [{ quote: "The processor is retried up to 3 times for idempotent calls.", reason: "verdict still_true" }]);

  assert.equal(result.provenance.provider, "mock");
  assert.equal(result.provenance.promptTemplate, "drift-verify");
  assert.equal(result.provenance.promptVersion, "2");
  assert.equal(result.provenance.inputHashes.length, 3);
  assert.ok(result.provenance.inputHashes.every((h) => /^[0-9a-f]{64}$/.test(h)));

  const request = provider.calls[0]?.request as StructuredGenerationRequest;
  assert.equal(request.schemaName, "drift_verify");
  assert.equal(request.effort, "high");
  assert.deepEqual(request.schema, DRIFT_VERIFY_SCHEMA);
  assert.ok(request.system.startsWith("You check whether documentation is still accurate"));
  assert.ok(request.prompt.includes(passage));
  assert.ok(request.prompt.includes('"path":"default","before":"30000","after":"60000"'));
  assert.match(request.prompt, /--- BEGIN PASSAGE (docops-boundary-[0-9a-f]{24}) ---[\s\S]*--- END PASSAGE \1 ---/);
});

test("verify drops hallucinated quotes, ungrounded evidence and low confidence", async () => {
  const provider = new MockProvider({
    structured: () => ({
      claims: [
        claim("Requests time out after 30 seconds."),
        claim("Requests to the card processor time out after 30 seconds.", { evidence: [{ source: "entity_diff", path: "maximum", before: "1", after: "2" }] }),
        claim("Requests to the card processor time out after 30 seconds.", { evidence: [{ source: "code_hunk", path: "src/other.ts", before: "x", after: "y" }] }),
        claim("Requests to the card processor time out after 30 seconds.", { evidence: [] }),
        claim("The processor is retried up to 3 times for idempotent calls.", { confidence: 0.6 }),
        // A quote that wraps differently than the passage still matches after whitespace normalization.
        claim("The processor is retried up to   3 times\nfor idempotent calls.", { evidence: [{ source: "code_hunk", path: "config/schema.json", before: "30000", after: "60000" }] }),
      ],
    }),
  });
  const result = await new DriftAiService({ provider }).verify({
    pagePath: "runbooks/payments-outage.md",
    startLine: 12,
    passage,
    deltas,
    codeHunks: ['--- a/config/schema.json\n+++ b/config/schema.json\n-  "default": 30000\n+  "default": 60000'],
  });
  assert.deepEqual(
    result.dropped.map((d) => d.reason),
    ["quote not found", "evidence not grounded", "evidence not grounded", "no evidence", "confidence 0.6 below 0.8"],
  );
  assert.deepEqual(
    result.findings.map((f) => f.line),
    [15],
  );
});

test("verify reports provider failures instead of findings", async () => {
  const provider = new MockProvider({ structured: () => mockStructuredStatus("refused", "refused (category: cyber)") });
  const result = await new DriftAiService({ provider }).verify({ pagePath: "a.md", startLine: 1, passage, deltas });
  assert.equal(result.status, "refused");
  assert.equal(result.error, "refused (category: cyber)");
  assert.deepEqual(result.findings, []);
});

const fileLines = [
  "---",
  "title: Runbook",
  "---",
  "",
  "# Runbook: payment processor timeouts",
  "",
  "See the [status page](https://status.acme.example) first.",
  "",
  "| Setting | Default | What it controls |",
  "|---|---|---|",
  "| `PAYMENTS_TIMEOUT_MS` | 30000 | How long to wait for the card processor |",
  "| `PAYMENTS_RETRY_LIMIT` | 3 | Retries for idempotent processor calls |",
  "",
  "Requests time out after 30 seconds.",
];

function patcher(value: unknown) {
  const provider = new MockProvider({ structured: () => value });
  return { provider, drift: new DriftAiService({ provider }) };
}

const finding = { message: "PAYMENTS_TIMEOUT_MS default changed", before: "30000", after: "60000" };

function reasonOf(result: PatchResult): string {
  return "reason" in result ? result.reason : "";
}

test("suggestPatch validates a minimal replacement and computes the unified diff", async () => {
  const { provider, drift } = patcher({
    replacement_lines: ["| `PAYMENTS_TIMEOUT_MS` | 60000 | How long to wait for the card processor |"],
    needs_human: false,
    reason: "",
  });
  const result = await drift.suggestPatch({ pagePath: "runbooks/payments-outage.md", fileLines, editable: { start: 11, end: 11 }, finding });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(
    result.unifiedDiff,
    [
      "--- a/runbooks/payments-outage.md",
      "+++ b/runbooks/payments-outage.md",
      "@@ -8,7 +8,7 @@",
      " ",
      " | Setting | Default | What it controls |",
      " |---|---|---|",
      "-| `PAYMENTS_TIMEOUT_MS` | 30000 | How long to wait for the card processor |",
      "+| `PAYMENTS_TIMEOUT_MS` | 60000 | How long to wait for the card processor |",
      " | `PAYMENTS_RETRY_LIMIT` | 3 | Retries for idempotent processor calls |",
      " ",
      " Requests time out after 30 seconds.",
      "",
    ].join("\n"),
  );
  assert.equal(result.provenance.promptTemplate, "drift-patch");
  assert.equal(result.provenance.promptVersion, "2");
  const request = provider.calls[0]?.request as StructuredGenerationRequest;
  assert.deepEqual(request.schema, DRIFT_PATCH_SCHEMA);
  assert.equal(request.schemaName, "drift_patch");
  assert.equal(request.effort, "medium");
  assert.ok(request.prompt.includes("editable_lines: 11-11"));
  assert.ok(request.prompt.includes(">11 | | `PAYMENTS_TIMEOUT_MS` | 30000 |"));
});

test("suggestPatch rejects edits outside the editable range", async () => {
  const { drift } = patcher({
    replacement_lines: [
      "|---|---|---|",
      "| `PAYMENTS_TIMEOUT_MS` | 60000 | How long to wait for the card processor |",
      "| `PAYMENTS_RETRY_LIMIT` | 3 | Retries for idempotent processor calls |",
    ],
    needs_human: false,
    reason: "",
  });
  const result = await drift.suggestPatch({ pagePath: "runbooks/payments-outage.md", fileLines, editable: { start: 11, end: 11 }, finding });
  assert.equal(result.status, "failed_validation");
  assert.match(reasonOf(result), /outside the editable range/);

  const outOfFile = await drift.suggestPatch({ pagePath: "x.md", fileLines, editable: { start: 14, end: 15 }, finding });
  assert.equal(outOfFile.status, "error");
});

test("suggestPatch rejects new external links, raw HTML, stale values and oversized changes", async () => {
  const cases: Array<[string[], { start: number; end: number }, RegExp]> = [
    [["Requests time out after 60 seconds. See [details](https://evil.example/timeouts)."], { start: 14, end: 14 }, /link to evil\.example/],
    [["Requests time out after 60 seconds. See [details](javascript:alert(1))."], { start: 14, end: 14 }, /javascript: link/],
    [["Requests time out after 60 seconds.<script>alert(1)</script>"], { start: 14, end: 14 }, /raw HTML/],
    [["| `PAYMENTS_TIMEOUT_MS` | 30000 | How long to wait (now 60000) |"], { start: 11, end: 11 }, /old value "30000" is still present/],
    [["| `PAYMENTS_TIMEOUT_MS` | 1 minute | How long to wait for the card processor |"], { start: 11, end: 11 }, /new value "60000" is missing/],
    [["```", "Requests time out after 60 seconds."], { start: 14, end: 14 }, /code fence/],
    [["| `PAYMENTS_TIMEOUT_MS` | 30000 | How long to wait for the card processor |"], { start: 11, end: 11 }, /no change/],
    [
      ["| a | b | c |", "|---|---|---|", "| x | 60000 | y |", "| z | 3 | w |", "", "Requests time out after 60 seconds."],
      { start: 9, end: 14 },
      /changes \d of 6 lines/,
    ],
  ];
  for (const [replacement, editable, expected] of cases) {
    const { drift } = patcher({ replacement_lines: replacement, needs_human: false, reason: "" });
    const result = await drift.suggestPatch({ pagePath: "runbooks/payments-outage.md", fileLines, editable, finding });
    assert.equal(result.status, "failed_validation", `${replacement.join("⏎")} should fail`);
    assert.match(reasonOf(result), expected);
  }

  // Links to hosts already in the file, or explicitly allowed, are fine.
  const { drift } = patcher({
    replacement_lines: ["Requests time out after 60 seconds. See [status](https://status.acme.example/history) and [docs](https://docs.acme.example/t)."],
    needs_human: false,
    reason: "",
  });
  const ok = await drift.suggestPatch({
    pagePath: "runbooks/payments-outage.md",
    fileLines,
    editable: { start: 14, end: 14 },
    finding: { message: "Timeout changed to 60 seconds" },
    allowedLinkHosts: ["docs.acme.example"],
  });
  assert.equal(ok.status, "ok");
});

test("suggestPatch rejects a patch that breaks MDX parsing", async () => {
  const mdx = ["# Webhooks", "", "Events are delivered at least once.", "", "<Callout>Retry on 5xx.</Callout>"];
  const { drift } = patcher({ replacement_lines: ["Events are delivered at least once. <Callout"], needs_human: false, reason: "" });
  const result = await drift.suggestPatch({ pagePath: "guides/webhooks.mdx", fileLines: mdx, editable: { start: 3, end: 3 }, finding: { message: "delivery changed" } });
  assert.equal(result.status, "failed_validation");
  assert.match(reasonOf(result), /Markdown does not parse/);
});

test("suggestPatch passes needs_human and refusals through", async () => {
  const human = patcher({ replacement_lines: [], needs_human: true, reason: "The new default depends on the region." });
  const result = await human.drift.suggestPatch({ pagePath: "runbooks/payments-outage.md", fileLines, editable: { start: 11, end: 11 }, finding });
  assert.deepEqual([result.status, reasonOf(result)], ["needs_human", "The new default depends on the region."]);

  const refused = patcher(mockStructuredStatus("refused", "refused (category: cyber)"));
  const r = await refused.drift.suggestPatch({ pagePath: "runbooks/payments-outage.md", fileLines, editable: { start: 11, end: 11 }, finding });
  assert.equal(r.status, "refused");
});

test("unifiedDiff handles insertions, deletions and separate hunks", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const after = [...before];
  after.splice(2, 1, "line 3 changed", "line 3b");
  after.splice(18, 1); // "line 18" (shifted by the insertion above)
  const diff = unifiedDiff("a.md", before, after, 2);
  assert.equal(
    diff,
    [
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,5 +1,6 @@",
      " line 1",
      " line 2",
      "-line 3",
      "+line 3 changed",
      "+line 3b",
      " line 4",
      " line 5",
      "@@ -16,5 +17,4 @@",
      " line 16",
      " line 17",
      "-line 18",
      " line 19",
      " line 20",
      "",
    ].join("\n"),
  );
  assert.equal(unifiedDiff("a.md", before, before), "");
  assert.equal(unifiedDiff("b.md", [], ["new"]), "--- a/b.md\n+++ b/b.md\n@@ -0,0 +1 @@\n+new\n");
});
