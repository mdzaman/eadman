import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@docops/git";
import { ACME_ROOT, acmeHeadConfigSchema, acmeHeadOpenApi } from "../../engine/test/fixtures.ts";
import { createTestEnv } from "../../../apps/api/test/helpers.ts";
import { main } from "../src/main.ts";
import type { CliContext } from "../src/context.ts";

function capture(cwd: string, overrides: Partial<CliContext> = {}) {
  let stdout = "";
  let stderr = "";
  const ctx: CliContext = {
    cwd,
    env: { PATH: process.env.PATH },
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
    fetch,
    color: false,
    now: () => new Date("2026-10-18T12:00:00Z"),
    ...overrides,
  } as CliContext;
  return { ctx, out: () => stdout, err: () => stderr };
}

/** A temp git repo with the Acme example on `main` and the API-change scenario on a feature branch. */
async function acmeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "docops-cli-"));
  cpSync(ACME_ROOT, dir, { recursive: true });
  const run = (...args: string[]) => git(dir, ["-c", "user.name=Dana", "-c", "user.email=dana@acme.example", "-c", "commit.gpgsign=false", ...args]);
  await run("init", "-q", "-b", "main");
  await run("add", ".");
  await run("commit", "-q", "-m", "PAY-100 initial docs");
  await run("checkout", "-q", "-b", "feature/PAY-131-amount-cents");
  writeFileSync(join(dir, "api/openapi.yaml"), acmeHeadOpenApi());
  writeFileSync(join(dir, "config/schema.json"), acmeHeadConfigSchema());
  await run("commit", "-qam", "PAY-131 rename amount to amount_cents");
  return dir;
}

test("docops check --base: blocks drift, writes SARIF and JUnit, exit codes follow --fail-on", async () => {
  const dir = await acmeRepo();
  const { ctx, out } = capture(dir);
  const code = await main(["check", "--base", "main", "--format", "json", "--report", "sarif=docops.sarif", "--report", "junit=docops-junit.xml"], ctx);
  assert.equal(code, 1);
  const report = JSON.parse(out()) as { findings: Array<{ ruleId: string; file: string; line?: number; suggestion?: { replacement: string } }>; summary: { counts: Record<string, number> }; base: { ref: string } };
  assert.equal(report.base.ref, "main");
  assert.deepEqual(report.summary.counts, { error: 5, warning: 2, info: 0 });
  assert.equal(report.findings.find((f) => f.line === 23)?.suggestion?.replacement, "Set `amount_cents` in minor currency units: `2000` is $20.00. The `currency` must be `usd`, `eur` or `gbp`.");
  assert.equal(JSON.parse(readFileSync(join(dir, "docops.sarif"), "utf8")).runs[0].results.length, 7);
  assert.match(readFileSync(join(dir, "docops-junit.xml"), "utf8"), /failures="5"/);

  const lenient = capture(dir);
  assert.equal(await main(["check", "--base", "main", "--fail-on", "never", "--quiet", "--report", "json=r.json"], lenient.ctx), 0);
  const groups = capture(dir);
  assert.equal(await main(["check", "--base", "main", "--only", "coverage,links"], groups.ctx), 0, "coverage warnings only");
  assert.match(groups.out(), /coverage\/undocumented-entity/);
});

test("docops check fixing the docs in the same branch clears the drift gate", async () => {
  const dir = await acmeRepo();
  const page = join(dir, "docs/guides/payments.md");
  writeFileSync(page, readFileSync(page, "utf8").replaceAll('"amount"', '"amount_cents"').replace("Set `amount`", "Set `amount_cents`"));
  const runbook = join(dir, "docs/runbooks/payments-outage.md");
  writeFileSync(runbook, readFileSync(runbook, "utf8").replace("| 30000 |", "| 60000 |").replace("reviewed: 2026-07-10", "reviewed: 2026-10-17"));
  const { ctx, out } = capture(dir);
  const code = await main(["check", "--base", "main", "--format", "json"], ctx);
  const report = JSON.parse(out()) as { findings: Array<{ ruleId: string }> };
  assert.deepEqual(report.findings.map((f) => f.ruleId), ["coverage/undocumented-entity"]);
  assert.equal(code, 0, "only a warning remains (new endpoint without a guide)");
});

test("docops diff and coverage", async () => {
  const dir = await acmeRepo();
  const diff = capture(dir);
  assert.equal(await main(["diff", "--base", "main", "--format", "json"], diff.ctx), 0);
  const changes = (JSON.parse(diff.out()) as { changes: Array<{ key: string; type: string; renamedTo?: string; pages: string[] }> }).changes;
  const rename = changes.find((c) => c.type === "renamed");
  assert.equal(rename?.renamedTo, "api.property:payments-api:PaymentCreate.amount_cents");
  assert.deepEqual(rename?.pages, ["guides/payments.md"]);

  const coverage = capture(dir);
  assert.equal(await main(["coverage", "--min", "90"], coverage.ctx), 1);
  assert.match(coverage.out(), /api\.operation\s+L2\s+83\.3% \(5\/6\)/);
  await git(dir, ["checkout", "-q", "main"]);
  assert.equal(await main(["coverage", "--min", "90"], capture(dir).ctx), 0);
});

test("init, config validate, new, link and sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docops-init-"));
  writeFileSync(join(dir, "openapi.yaml"), readFileSync(join(ACME_ROOT, "api/openapi.yaml")));
  const init = capture(dir);
  assert.equal(await main(["init"], init.ctx), 0);
  assert.match(init.out(), /Created docops\.yaml, docs\/index\.md, \.github\/workflows\/docs\.yml/);
  assert.match(init.out(), /Detected API specs: openapi\.yaml/);
  assert.equal(await main(["config", "validate"], capture(dir).ctx), 0);
  const again = capture(dir);
  await main(["init"], again.ctx);
  assert.match(again.out(), /Nothing to do/);

  assert.equal(await main(["new", "runbook", "docs/runbooks/db-failover.md", "--owner", "@acme/sre"], capture(dir).ctx), 0);
  const runbook = readFileSync(join(dir, "docs/runbooks/db-failover.md"), "utf8");
  assert.match(runbook, /^---\ntitle: "Db failover"\ntype: runbook\nowners: \["@acme\/sre"\]\nreviewed: 2026-10-18\n---/);
  assert.equal(await main(["new", "runbook", "docs/runbooks/db-failover.md"], capture(dir).ctx), 2, "never overwrites");

  assert.equal(await main(["link", "PAY-999", "docs/runbooks/db-failover.md"], capture(dir).ctx), 0);
  assert.match(readFileSync(join(dir, "docs/runbooks/db-failover.md"), "utf8"), /tickets: \[ PAY-999 \]|tickets: \[PAY-999\]/);
  assert.equal(await main(["link", "PAY-999", "docs/runbooks/db-failover.md", "--remove"], capture(dir).ctx), 0);
  assert.doesNotMatch(readFileSync(join(dir, "docs/runbooks/db-failover.md"), "utf8"), /PAY-999/);

  writeFileSync(join(dir, "docops.yaml"), "version: 1\nproject:\n  id: x\n  name: X\n");
  const invalid = capture(dir);
  assert.equal(await main(["config", "validate"], invalid.ctx), 2);
  assert.match(invalid.err(), /docops\.yaml:3:\d+ \/project\/id must match pattern/);

  assert.equal(await main(["sync", "--check"], capture(ACME_ROOT).ctx), 0);
  assert.equal(await main(["frobnicate"], capture(dir).ctx), 2);
  assert.equal(await main(["check", "--bogus"], capture(dir).ctx), 2);
});

test("build renders the site; publish uploads only new blobs and promotes; the CLI honours platform dismissals", async () => {
  const dir = await acmeRepo();
  await git(dir, ["checkout", "-q", "main"]);
  const build = capture(dir);
  assert.equal(await main(["build", "--format", "json"], build.ctx), 0, build.err());
  const stats = JSON.parse(build.out()) as { pages: number; referencePages: number; files: number };
  assert.equal(stats.pages, 5);
  assert.ok(stats.referencePages >= 5);
  assert.ok(existsSync(join(dir, ".docops/site/index.html")));
  assert.ok(existsSync(join(dir, ".docops/site/guides/payments/index.html")));

  const env = await createTestEnv();
  const viaApp = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(env.app.request(String(input), init))) as typeof fetch;
  const api = ["--api-url", "http://docops.test", "--token", env.tokens.ci];
  const first = capture(dir, { fetch: viaApp });
  assert.equal(await main(["publish", "--env", "dev", "--format", "json", ...api], first.ctx), 0, first.err());
  const published = JSON.parse(first.out()) as { buildId: string; uploaded: number; reused: number; deployment: { environment: string; url: string } };
  assert.ok(published.uploaded > 5);
  assert.equal(published.deployment.url, "http://docops.test/sites/acme/payments/dev/");
  const page = await env.request("/sites/acme/payments/dev/guides/payments/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Accept a payment/);

  const second = capture(dir, { fetch: viaApp });
  assert.equal(await main(["publish", "--format", "json", ...api], second.ctx), 0);
  assert.equal((JSON.parse(second.out()) as { uploaded: number }).uploaded, 0, "content-addressed: nothing re-uploaded");

  // Upload a check run, dismiss a finding on the platform, and the next CI run suppresses it.
  await git(dir, ["checkout", "-q", "feature/PAY-131-amount-cents"]);
  const upload = capture(dir, { fetch: viaApp });
  assert.equal(await main(["check", "--base", "main", "--upload", "--format", "json", ...api], upload.ctx), 1);
  const runs = (await (await env.request("/v1/findings?category=drift&limit=50", { token: env.tokens.ci })).json()) as { items: Array<{ id: string; ruleId: string }> };
  const staleValue = runs.items.find((f) => f.ruleId === "drift/stale-value")!;
  assert.equal((await env.request(`/v1/findings/${staleValue.id}/dismiss`, { method: "POST", token: env.tokens.owner, json: { reason: "false_positive" } })).status, 200);
  const after = capture(dir, { fetch: viaApp });
  await main(["check", "--base", "main", "--upload", "--format", "json", ...api], after.ctx);
  const report = JSON.parse(after.out()) as { findings: Array<{ ruleId: string }> };
  assert.ok(!report.findings.some((f) => f.ruleId === "drift/stale-value"), "dismissed on the platform, suppressed in CI");

  // Platform outage: fail open with a warning by default, exit 4 when fail-closed is requested.
  const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  const open = capture(dir, { fetch: down });
  assert.equal(await main(["check", "--base", "main", "--upload", "--fail-on", "never", ...api], open.ctx), 0);
  assert.match(open.err(), /warning: DocOps platform unavailable/);
  assert.equal(await main(["check", "--base", "main", "--upload", "--fail-on-platform-error", ...api], capture(dir, { fetch: down }).ctx), 4);
});
