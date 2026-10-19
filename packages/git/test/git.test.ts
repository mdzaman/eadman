import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeRef, changedFiles, commitsBetween, fileReaderAt, git, headInfo, mergeBase, parseRemoteUrl } from "../src/index.ts";

async function repo() {
  const dir = mkdtempSync(join(tmpdir(), "docops-git-"));
  const run = (...args: string[]) => git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
  await run("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.md"), "v1\n");
  await run("add", ".");
  await run("commit", "-q", "-m", "PAY-1 initial");
  await run("checkout", "-q", "-b", "feature/PAY-2-change");
  writeFileSync(join(dir, "a.md"), "v2\n");
  writeFileSync(join(dir, "b.md"), "new\n");
  await run("add", ".");
  await run("commit", "-q", "-m", "PAY-2 change docs", "-m", "Body line");
  writeFileSync(join(dir, "c.md"), "untracked\n");
  return dir;
}

test("reads files at refs and lists changed files since the merge base", async () => {
  const dir = await repo();
  assert.equal(await fileReaderAt(dir, "main")("a.md"), "v1\n");
  assert.equal(await fileReaderAt(dir, "HEAD")("a.md"), "v2\n");
  assert.equal(await fileReaderAt(dir, "main")("b.md"), null);
  assert.deepEqual([...(await changedFiles(dir, "main"))].sort(), ["a.md", "b.md", "c.md"]);
  assert.deepEqual([...(await changedFiles(dir, "main", { includeWorkingTree: false }))].sort(), ["a.md", "b.md"]);
  assert.match((await mergeBase(dir, "main")) ?? "", /^[0-9a-f]{40}$/);
});

test("head info and commit log", async () => {
  const dir = await repo();
  const head = await headInfo(dir);
  assert.equal(head.ref, "feature/PAY-2-change");
  assert.match(head.sha, /^[0-9a-f]{40}$/);
  const commits = await commitsBetween(dir, "main");
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.subject, "PAY-2 change docs");
  assert.equal(commits[0]?.body, "Body line");
});

test("rejects option-injection refs", () => {
  assert.throws(() => assertSafeRef("--output=/tmp/x"));
  assert.throws(() => assertSafeRef("a b"));
  assert.equal(assertSafeRef("origin/main"), "origin/main");
  assert.equal(assertSafeRef("v2.4.0^{commit}"), "v2.4.0^{commit}");
});

test("parses remote URLs", () => {
  assert.equal(parseRemoteUrl("git@github.com:acme/payments.git"), "acme/payments");
  assert.equal(parseRemoteUrl("https://github.com/acme/payments"), "acme/payments");
  assert.equal(parseRemoteUrl("https://gitlab.example.com/group/sub/repo.git"), "group/sub/repo");
  assert.equal(parseRemoteUrl("https://dev.azure.com/acme/Payments/_git/payments-api"), "acme/payments-api");
});
