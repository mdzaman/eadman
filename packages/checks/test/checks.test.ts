import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@docops/config";
import { parseMarkdown } from "@docops/markdown";
import { ACME_ROOT, acmeFile, acmeHeadConfigSchema, acmeHeadOpenApi } from "../../engine/test/fixtures.ts";
import { formatReport, ownersFor, parseCodeowners, runChecks, runDocTests, type FileReader } from "../src/index.ts";

const acmeConfig = () => parseConfig(acmeFile("docops.yaml"));
const disk: FileReader = async (p) => {
  try {
    return readFileSync(join(ACME_ROOT, p), "utf8");
  } catch {
    return null;
  }
};
const headReader: FileReader = async (p) => (p === "api/openapi.yaml" ? acmeHeadOpenApi() : p === "config/schema.json" ? acmeHeadConfigSchema() : disk(p));

async function acmeScenario(extra: Partial<Parameters<typeof runChecks>[0]> = {}) {
  return runChecks({
    repoRoot: ACME_ROOT,
    loaded: acmeConfig(),
    readHead: headReader,
    head: { ref: "feature/PAY-131-amount-cents", sha: "b".repeat(40) },
    base: { ref: "origin/main", sha: "a".repeat(40), read: disk },
    changedFiles: new Set(["api/openapi.yaml", "config/schema.json"]),
    now: new Date("2026-10-18T12:00:00Z"),
    ...extra,
  });
}

test("acme scenario: deterministic gates block the PR with actionable findings", async () => {
  const { report } = await acmeScenario();
  const summary = report.findings.map((f) => `${f.severity} ${f.ruleId} ${f.file}:${f.line ?? ""}`);
  assert.deepEqual(summary, [
    "error schema/changed-without-docs api/openapi.yaml:" + report.findings.find((f) => f.file === "api/openapi.yaml" && f.ruleId === "schema/changed-without-docs")?.line,
    "error schema/changed-without-docs config/schema.json:" + report.findings.find((f) => f.file === "config/schema.json")?.line,
    "error drift/stale-reference docs/guides/payments.md:20",
    "error drift/stale-reference docs/guides/payments.md:23",
    "error drift/stale-value docs/runbooks/payments-outage.md:16",
    "warning coverage/undocumented-entity api/openapi.yaml:" + report.findings.find((f) => f.ruleId === "coverage/undocumented-entity")?.line,
    "warning freshness/overdue-review docs/runbooks/payments-outage.md:1",
  ]);
  assert.equal(report.summary.gate.blocked, true);
  assert.deepEqual(report.summary.counts, { error: 5, warning: 2, info: 0 });
  assert.equal(report.summary.coverage?.percentL2, 83.3);
  assert.equal(report.stats.pages, 5);
});

test("clean base == head: no drift, gate passes", async () => {
  const { report } = await runChecks({
    repoRoot: ACME_ROOT,
    loaded: acmeConfig(),
    readHead: disk,
    base: { ref: "origin/main", sha: null, read: disk },
    changedFiles: new Set(),
    now: new Date("2026-08-01T00:00:00Z"),
  });
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.gate.blocked, false);
  assert.equal(report.summary.coverage?.percentL2, 100);
});

test("dismissals and the waiver label are honored", async () => {
  const first = await acmeScenario();
  const staleValue = first.report.findings.find((f) => f.ruleId === "drift/stale-value");
  assert.ok(staleValue);
  const second = await acmeScenario({ dismissed: new Set([staleValue.fingerprint]), waived: true });
  assert.ok(!second.report.findings.some((f) => f.ruleId === "drift/stale-value"));
  assert.ok(second.report.findings.filter((f) => f.ruleId === "schema/changed-without-docs").every((f) => f.severity === "info"));
  assert.equal(second.suppressed, 1);
});

test("--only restricts rule groups", async () => {
  const { report } = await acmeScenario({ only: ["coverage"] });
  assert.deepEqual([...new Set(report.findings.map((f) => f.ruleId))], ["coverage/undocumented-entity"]);
});

test("page rules: links, anchors, style, a11y, secrets, pragmas, includes", async () => {
  const root = mkdtempSync(join(tmpdir(), "docops-rules-"));
  mkdirSync(join(root, "docs/guides"), { recursive: true });
  writeFileSync(join(root, "docops.yaml"), "version: 1\nproject: { id: rules-test, name: Rules test }\n");
  writeFileSync(join(root, "schema.sql"), "SELECT 2;\n");
  writeFileSync(join(root, "docs/index.md"), "---\ntitle: Home\n---\n# Home\n\nSee [guide](guides/a.md#setup) and [missing](guides/nope.md).\n");
  writeFileSync(
    join(root, "docs/guides/a.md"),
    [
      "---",
      "title: A",
      "---",
      "# A",
      "",
      "## Setup",
      "",
      "Add the host to the whitelist. For details [click here](#setup).",
      "",
      "#### Too deep",
      "",
      "![](diagram.png)",
      "",
      "Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
      "",
      "<!-- docops-ignore style/inclusive-language -->",
      "The blacklist is ignored here.",
      "",
      '<!-- docops:include path="../../schema.sql" lang="sql" -->',
      "```sql",
      "SELECT 1;",
      "```",
      "<!-- docops:end-include -->",
      "",
      "Jump to [nowhere](#no-such-anchor).",
    ].join("\n"),
  );
  const loaded = parseConfig(readFileSync(join(root, "docops.yaml"), "utf8"));
  const { report } = await runChecks({ repoRoot: root, loaded });
  const got = report.findings.map((f) => `${f.ruleId}@${f.line}`).sort();
  assert.deepEqual(got, [
    "a11y/heading-order@10",
    "a11y/img-alt@12",
    "includes/out-of-date@19",
    "links/broken-anchor@25",
    "links/broken-internal@12",
    "links/broken-internal@6",
    "secrets/detected@14",
    "style/inclusive-language@8",
    "style/non-descriptive-link-text@8",
  ]);
  assert.ok(!report.findings.some((f) => f.message.includes("ghp_abcdefghijklmnop")), "secrets are never echoed");
});

test("reporters: JSON, SARIF, JUnit, Code Quality, GitHub commands, Markdown", async () => {
  const { report } = await acmeScenario();
  const json = JSON.parse(formatReport(report, "json"));
  assert.equal(json.schema, "docops.report.v1");
  const sarif = JSON.parse(formatReport(report, "sarif"));
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results.length, report.findings.length);
  assert.equal(sarif.runs[0].results[2].locations[0].physicalLocation.region.startLine, 20);
  const cq = JSON.parse(formatReport(report, "codequality"));
  assert.equal(cq[0].severity, "major");
  const junit = formatReport(report, "junit");
  assert.match(junit, /<testsuites name="docops" tests="7" failures="5">/);
  const gh = formatReport(report, "github");
  assert.match(gh, /^::error file=docs\/guides\/payments.md,line=20,title=drift\/stale-reference::/m);
  const md = formatReport(report, "markdown", { markdown: { previewUrl: "https://preview.docops.example/acme/payments/pr-7/" } });
  assert.ok(md.startsWith("<!-- docops:comment:v1 -->"));
  assert.match(md, /❌ \*\*Docs gate failed\*\*/);
  assert.match(md, /\+ Set `amount_cents` in minor currency units/);
  const text = formatReport(report, "text");
  assert.match(text, /gate: FAILED/);
});

test("CODEOWNERS semantics: last match wins", () => {
  const rules = parseCodeowners("/docs/ @docs\n/docs/runbooks/ @sre\n*.yaml @platform\n");
  assert.deepEqual(ownersFor(rules, "docs/runbooks/x.md"), ["@sre"]);
  assert.deepEqual(ownersFor(rules, "docs/guides/y.md"), ["@docs"]);
  assert.deepEqual(ownersFor(rules, "api/openapi.yaml"), ["@platform"]);
});

test("doc tests run marked samples in isolation and redact secrets", async () => {
  const page = parseMarkdown(
    "guides/t.md",
    [
      "```bash test expect=\"hello acme\"",
      "echo hello {{ name }}",
      "```",
      "",
      "```bash test",
      "echo token={{ env.DOCOPS_TEST_SECRET }} >&2; exit 3",
      "```",
      "",
      "```bash",
      "echo not a test",
      "```",
    ].join("\n"),
  );
  const results = await runDocTests([page], {
    languages: ["bash"],
    timeoutMs: 10_000,
    variables: { name: "acme" },
    env: { PATH: process.env.PATH, DOCOPS_TEST_SECRET: "s3cr3t-value" },
  });
  assert.equal(results.length, 2);
  assert.equal(results[0]?.passed, true);
  assert.equal(results[1]?.passed, false);
  assert.equal(results[1]?.exitCode, 3);
  assert.ok(!results[1]?.stderr.includes("s3cr3t-value"));
  assert.match(results[1]?.stderr ?? "", /token=\*\*\*/);
});
