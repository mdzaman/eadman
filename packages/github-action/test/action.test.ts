import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@docops/git";
import { ACME_ROOT, acmeHeadConfigSchema, acmeHeadOpenApi } from "../../engine/test/fixtures.ts";
import { run } from "../src/main.ts";

async function prRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "docops-action-"));
  cpSync(ACME_ROOT, dir, { recursive: true });
  const g = (...args: string[]) => git(dir, ["-c", "user.name=Dana", "-c", "user.email=dana@acme.example", "-c", "commit.gpgsign=false", ...args]);
  await g("init", "-q", "-b", "main");
  await g("add", ".");
  await g("commit", "-q", "-m", "initial");
  await g("checkout", "-q", "-b", "feature/PAY-131");
  writeFileSync(join(dir, "api/openapi.yaml"), acmeHeadOpenApi());
  writeFileSync(join(dir, "config/schema.json"), acmeHeadConfigSchema());
  // Touch the guide near the stale lines so they fall inside the PR diff (suggestions are allowed there).
  const page = join(dir, "docs/guides/payments.md");
  writeFileSync(page, readFileSync(page, "utf8").replace("```\n\nSet `amount`", "```\n<!-- reviewed for PAY-131 -->\nSet `amount`"));
  await g("commit", "-qam", "PAY-131 rename amount");
  return dir;
}

function fakeGitHub() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const reviewComments: Array<{ id: number; body: string; path: string; line: number }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path.endsWith("/issues/7/comments")) return Response.json([]);
    if (method === "POST" && path.endsWith("/issues/7/comments")) return Response.json({ id: 1 });
    if (method === "POST" && path.endsWith("/check-runs")) return Response.json({ id: 99 });
    if (method === "PATCH") return Response.json({});
    if (method === "GET" && path.endsWith("/pulls/7/comments")) return Response.json(reviewComments);
    if (method === "POST" && path.endsWith("/pulls/7/comments")) {
      reviewComments.push({ id: reviewComments.length + 1, body: body.body, path: body.path, line: body.line });
      return Response.json({ id: reviewComments.length });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { impl, calls, reviewComments };
}

test("GitHub Action: check run, sticky comment, in-diff suggestions, outputs, summary", async () => {
  const dir = await prRepo();
  const out = join(dir, "gh-output");
  const summary = join(dir, "gh-summary");
  const eventPath = join(dir, "event.json");
  writeFileSync(out, "");
  writeFileSync(summary, "");
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, title: "PAY-131 rename amount", body: "", labels: [], base: { ref: "main" }, head: { sha: head, ref: "feature/PAY-131" } } }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: dir,
    GITHUB_REPOSITORY: "acme/payments",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: out,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_API_URL: "https://api.github.test",
    INPUT_COMMAND: "check",
    INPUT_BASE: "main",
    "INPUT_GITHUB-TOKEN": "ghs_test",
  };
  const gh = fakeGitHub();
  const sink = { write: () => true };
  const code = await run({ env, fetch: gh.impl, stdout: sink, stderr: sink, now: () => new Date("2026-10-18T12:00:00Z") });
  assert.equal(code, 1);

  const checkRun = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/check-runs"));
  assert.equal(checkRun?.body.conclusion, "failure");
  assert.equal(checkRun?.body.head_sha, head);
  assert.ok(checkRun?.body.output.annotations.length >= 4);
  const sticky = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues/7/comments"));
  assert.match(sticky?.body.body, /^<!-- docops:comment:v1 -->/);

  // The guide changed in this PR, so its stale lines get one-click suggestions; the runbook did not, so no inline comment there.
  assert.deepEqual(gh.reviewComments.map((c) => [c.path, c.line]).sort(), [["docs/guides/payments.md", 20], ["docs/guides/payments.md", 23]]);
  assert.match(gh.reviewComments[0]!.body, /```suggestion\n/);

  const outputs = readFileSync(out, "utf8");
  assert.match(outputs, /conclusion<<ghadelimiter_[^\n]+\nfailure\n/);
  assert.match(outputs, /errors<<ghadelimiter_[^\n]+\n4\n/);
  assert.match(readFileSync(summary, "utf8"), /Docs gate failed/);

  // Re-running (new push) does not duplicate suggestions: fingerprints are embedded in comment bodies.
  await run({ env, fetch: gh.impl, stdout: sink, stderr: sink });
  assert.equal(gh.reviewComments.length, 2);
});
