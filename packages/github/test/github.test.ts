import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getActionsIdToken,
  getBooleanInput,
  getInput,
  GitHubClient,
  pullRequestFromEvent,
  setOutput,
  signGithubPayload,
  suggestionBody,
  verifyGithubSignature,
  type CheckRunAnnotation,
} from "../src/index.ts";

test("webhook signatures: valid, tampered, wrong secret, missing", () => {
  const body = JSON.stringify({ action: "opened", number: 7 });
  const header = signGithubPayload("s3cret", body);
  assert.equal(verifyGithubSignature("s3cret", body, header), true);
  assert.equal(verifyGithubSignature("s3cret", body.replace("7", "8"), header), false);
  assert.equal(verifyGithubSignature("other", body, header), false);
  assert.equal(verifyGithubSignature("s3cret", body, undefined), false);
  assert.equal(verifyGithubSignature("s3cret", body, "sha1=abc"), false);
});

function fakeFetch(handler: (method: string, url: string, body: unknown) => unknown) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });
    const result = handler(method, String(url), body);
    return new Response(result === undefined ? null : JSON.stringify(result), { status: result === undefined ? 204 : 200 });
  }) as typeof fetch;
  return { impl, calls };
}

test("sticky comment is created once and then updated in place", async () => {
  const comments: Array<{ id: number; body: string }> = [];
  const { impl, calls } = fakeFetch((method, url, body) => {
    if (method === "GET") return comments;
    if (method === "POST") {
      comments.push({ id: 11, body: (body as { body: string }).body });
      return { id: 11 };
    }
    if (method === "PATCH") return { id: Number(url.split("/").pop()) };
    return undefined;
  });
  const gh = new GitHubClient({ token: "t", fetch: impl });
  assert.deepEqual(await gh.upsertStickyComment("acme", "payments", 7, "<!-- m --> v1", "<!-- m -->"), { id: 11, created: true });
  assert.deepEqual(await gh.upsertStickyComment("acme", "payments", 7, "<!-- m --> v2", "<!-- m -->"), { id: 11, created: false });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(calls.at(-1)?.method, "PATCH");
});

test("check run annotations are batched by 50", async () => {
  const { impl, calls } = fakeFetch((method) => (method === "POST" ? { id: 99 } : {}));
  const gh = new GitHubClient({ token: "t", fetch: impl });
  const annotations: CheckRunAnnotation[] = Array.from({ length: 120 }, (_, i) => ({ path: "docs/a.md", start_line: i + 1, end_line: i + 1, annotation_level: "warning", message: `m${i}` }));
  const result = await gh.createCheckRun({ owner: "acme", repo: "payments", name: "DocOps", headSha: "abc", conclusion: "failure", title: "t", summary: "s", annotations });
  assert.equal(result.requests, 3);
  assert.deepEqual(calls.map((c) => [c.method, (c.body as { output: { annotations: unknown[] } }).output.annotations.length]), [
    ["POST", 50],
    ["PATCH", 50],
    ["PATCH", 20],
  ]);
});

test("suggestion body uses a suggestion fence", () => {
  assert.match(suggestionBody("Rename", "Set `amount_cents`"), /```suggestion\nSet `amount_cents`\n```/);
  assert.match(suggestionBody("x", "```js\ncode\n```"), /````suggestion/);
});

test("actions runtime helpers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docops-gha-"));
  const out = join(dir, "out");
  writeFileSync(out, "");
  const env = { INPUT_COMMAND: " check ", "INPUT_FAIL-ON": "warning", INPUT_COMMENT: "false", GITHUB_OUTPUT: out } as NodeJS.ProcessEnv;
  assert.equal(getInput("command", env), "check");
  assert.equal(getInput("fail-on", env), "warning");
  assert.equal(getBooleanInput("comment", true, env), false);
  assert.equal(getBooleanInput("annotations", true, env), true);
  setOutput("errors", 5, env);
  assert.match(readFileSync(out, "utf8"), /^errors<<ghadelimiter_[0-9a-f-]+\n5\nghadelimiter_[0-9a-f-]+\n$/);

  const { impl, calls } = fakeFetch(() => ({ value: "jwt-token" }));
  const token = await getActionsIdToken("https://api.docops.example", { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/x?api-version=2.0", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "rt" }, impl);
  assert.equal(token, "jwt-token");
  assert.equal(calls[0]?.url, "https://token.example/x?api-version=2.0&audience=https%3A%2F%2Fapi.docops.example");
});

test("pull request context from the event payload", () => {
  const pr = pullRequestFromEvent(
    { pull_request: { number: 7, title: "PAY-131 rename", body: "", labels: [{ name: "docs-not-needed" }], base: { ref: "main" }, head: { sha: "abc", ref: "feature/x" } } },
    "acme/payments",
  );
  assert.deepEqual(pr, { owner: "acme", repo: "payments", number: 7, headSha: "abc", headRef: "feature/x", baseRef: "main", labels: ["docs-not-needed"], title: "PAY-131 rename", body: "" });
});
