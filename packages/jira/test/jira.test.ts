import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  docTaskFields,
  extractIssueKeys,
  FakeJiraClient,
  fixVersionJql,
  HttpJiraClient,
  linksFromPullRequest,
  pushDocsStatus,
  resolveDocsRequired,
  ticketFromIssue,
  verifyJiraSignature,
  type JiraIssue,
} from "../src/index.ts";

test("extracts issue keys, honoring project allowlists and ignoring look-alikes", () => {
  assert.deepEqual(extractIssueKeys("PAY-123: fix PAY-123 and PAY-7; encoding UTF-8; SHA-256"), ["PAY-123", "PAY-7"]);
  assert.deepEqual(extractIssueKeys("PAY-1 OPS-2 DOC-3", { projects: ["PAY", "DOC"] }), ["PAY-1", "DOC-3"]);
  assert.deepEqual(extractIssueKeys("PAY-0 is not a key"), []);
});

test("links from a pull request carry provenance", () => {
  const links = linksFromPullRequest(
    {
      title: "PAY-131 rename amount",
      body: "Also fixes PAY-140",
      headRef: "feature/pay-150-amount",
      commits: [{ sha: "abc", message: "PAY-131 update docs" }],
    },
    ["pr_title", "branch_name", "commit_message"],
    { projects: ["PAY"] },
  );
  assert.deepEqual(links, [
    { key: "PAY-131", source: "pr_title", targetRef: undefined },
    { key: "PAY-150", source: "branch_name", targetRef: undefined },
    { key: "PAY-131", source: "commit_message", targetRef: "abc" },
  ]);
});

const issue = (key: string, fields: Partial<JiraIssue["fields"]> = {}): JiraIssue => ({
  id: String(10000 + Number(key.split("-")[1])),
  key,
  fields: { summary: `Summary ${key}`, issuetype: { name: "Story" }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, fixVersions: [{ name: "2.4.0" }], ...fields },
});

test("docs-required resolution: field, label, issue-type policy", () => {
  assert.equal(resolveDocsRequired(issue("PAY-1", { customfield_10071: { value: "No" } }), { field: "customfield_10071", issueTypes: ["Story"] }), "no");
  assert.equal(resolveDocsRequired(issue("PAY-1"), { field: "customfield_10071", issueTypes: ["Story"] }), "yes");
  assert.equal(resolveDocsRequired(issue("PAY-1", { issuetype: { name: "Task" } }), { issueTypes: ["Story", "Bug"] }), "no");
  assert.equal(resolveDocsRequired(issue("PAY-1", { labels: ["docs-required"] }), { label: "docs-required" }), "yes");
  assert.equal(resolveDocsRequired(issue("PAY-1"), {}), "unknown");
  const mirror = ticketFromIssue(issue("PAY-9"), "acme.atlassian.net", { issueTypes: ["Story"] });
  assert.equal(mirror.statusCategory, "in_progress");
  assert.equal(mirror.url, "https://acme.atlassian.net/browse/PAY-9");
});

test("JQL values are escaped", () => {
  assert.equal(fixVersionJql("PAY", '2.4.0 "beta"'), 'project = PAY AND fixVersion = "2.4.0 \\"beta\\"" ORDER BY key ASC');
  assert.throws(() => fixVersionJql("PAY OR 1=1", "x"));
});

test("pushing docs status writes the issue property, remote links and the app field", async () => {
  const jira = new FakeJiraClient("acme.atlassian.net", [issue("PAY-123")]);
  await pushDocsStatus(
    jira,
    { key: "PAY-123", id: "10123" },
    {
      required: "yes",
      status: "in_review",
      reasons: ["PR acme/payments#482 is open and changes docs"],
      pages: [{ path: "guides/refunds.md", title: "Refund a payment", url: "https://docs.acme.example/guides/refunds/", stale: false, pageId: "p1" }],
      pullRequests: [{ repo: "acme/payments", number: 482, state: "open", url: "https://github.com/acme/payments/pull/482" }],
    },
    { tenantId: "t1", source: "docops://cells/us-1", statusFieldKey: "docs-status", now: new Date("2026-10-18T00:00:00Z") },
  );
  const property = jira.properties.get("PAY-123/docops.docs") as { status: string; required: string; v: number };
  assert.equal(property.status, "in_review");
  assert.equal(property.v, 1);
  assert.deepEqual((jira.remoteLinks.get("PAY-123") ?? []).map((l) => l.globalId), ["docops:page:t1:p1", "docops:pr:github:acme/payments#482"]);
  assert.equal(jira.fieldValues.get("docs-status/10123"), "In review");
  // Idempotent: a second push upserts the same links instead of duplicating them.
  await pushDocsStatus(jira, { key: "PAY-123", id: "10123" }, { required: "yes", status: "merged", reasons: [], pages: [], pullRequests: [{ repo: "acme/payments", number: 482, state: "merged", url: "u" }] }, { tenantId: "t1", source: "s" });
  assert.equal(jira.remoteLinks.get("PAY-123")?.length, 2);
});

test("HTTP client: enhanced JQL search pagination and request shapes", async () => {
  const calls: Array<{ method: string; url: string; body: any; auth: string | null }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", url: String(url), body, auth: new Headers(init?.headers).get("authorization") });
    if (String(url).endsWith("/search/jql")) {
      return Response.json(body.nextPageToken ? { issues: [issue("PAY-2")] } : { issues: [issue("PAY-1")], nextPageToken: "tok" });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const jira = new HttpJiraClient({ baseUrl: "https://acme.atlassian.net", auth: { type: "basic", email: "bot@acme.example", apiToken: "tkn" }, fetch: impl });
  const issues = await jira.searchJql(fixVersionJql("PAY", "2.4.0"), ["summary"]);
  assert.deepEqual(issues.map((i) => i.key), ["PAY-1", "PAY-2"]);
  assert.equal(calls[1]?.body.nextPageToken, "tok");
  assert.equal(calls[0]?.auth, `Basic ${Buffer.from("bot@acme.example:tkn").toString("base64")}`);
  await jira.setIssueProperty("PAY-1", "docops.docs", { v: 1 });
  assert.equal(calls.at(-1)?.url, "https://acme.atlassian.net/rest/api/3/issue/PAY-1/properties/docops.docs");
  await jira.setAppFieldValue("docs-status", ["10001"], "Missing");
  assert.deepEqual(calls.at(-1)?.body, { updates: [{ issueIds: [10001], value: "Missing" }] });
});

test("doc task fields and webhook signatures", () => {
  const fields = docTaskFields({ key: "PAY-140", summary: "Webhook retries" }, "PAY");
  assert.equal(fields.summary, "Docs: Webhook retries");
  assert.deepEqual(fields.parent, { key: "PAY-140" });
  const body = '{"webhookEvent":"jira:issue_updated"}';
  const sig = `sha256=${createHmac("sha256", "jsecret").update(body).digest("hex")}`;
  assert.equal(verifyJiraSignature("jsecret", body, sig), true);
  assert.equal(verifyJiraSignature("jsecret", `${body} `, sig), false);
  assert.equal(verifyJiraSignature("jsecret", body, "sha1=abc"), false);
});
