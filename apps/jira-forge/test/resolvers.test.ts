/**
 * Runs the real resolver code (src/index.ts) against in-memory stand-ins for the Forge packages.
 *
 * The Forge packages are not installed at the repository root, so the test bundles src/index.ts with
 * esbuild (already a root devDependency) and points @forge/api, @forge/kvs and @forge/resolver at
 * test/support/forge-stubs.ts. That keeps the security-relevant branches under test: which key is
 * trusted, when a Jira permission or visibility check runs, and that DocOps is never called after a
 * denial. The app's own typecheck (`npm run typecheck` in apps/jira-forge) covers the Forge typings.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ApiResult } from "../src/view-model.ts";
import type { DocOpsCall, JiraRequest, Reply, StubState } from "./support/forge-stubs.ts";

// ---- load the bundled resolvers ---------------------------------------------------------------

const stubs = fileURLToPath(new URL("./support/forge-stubs.ts", import.meta.url));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
  alias: { "@forge/api": stubs, "@forge/kvs": stubs, "@forge/resolver": stubs },
});
const code = bundle.outputFiles[0]?.text ?? "";
const loaded = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
  handler: (invocation: { call: { functionKey: string; payload?: unknown }; context: Record<string, unknown> }) => Promise<unknown>;
};

// ---- helpers ------------------------------------------------------------------------------------

let state: StubState;

beforeEach(() => {
  state = {
    jira: () => ({ status: 500 }),
    docops: () => ({ status: 500 }),
    kvs: new Map(),
    kvsDown: false,
    installationId: "11111111-2222-3333-4444-555555555555",
    jiraCalls: [],
    jiraRequests: [],
    docopsCalls: [],
  };
  globalThis.__forgeStubState = state;
});

type AnyResult = ApiResult<any>;

async function invoke(functionKey: string, payload: unknown = {}, context: Record<string, unknown> = {}): Promise<AnyResult> {
  return (await loaded.handler({ call: { functionKey, payload }, context })) as AnyResult;
}

const issueContext = (key: string) => ({ cloudId: "c-1", extension: { issue: { key }, project: { key: key.slice(0, key.lastIndexOf("-")) } } });
const projectContext = (key: string) => ({ cloudId: "c-1", extension: { project: { key } } });

const PAGE_ID = "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e77";
const SPACE_ID = "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e78";

function ticketDocs(key: string) {
  return { ticket: { key, title: "Partial refunds", url: `https://acme.atlassian.net/browse/${key}` }, docsStatus: "missing", reasons: ["Docs are required"], links: [] };
}

function readiness(project: string, fixVersion: string) {
  return {
    project,
    fixVersion,
    generatedAt: "2026-10-18T14:05:12Z",
    summary: { total: 1, byStatus: { missing: 1 }, readyPercent: 0, blockers: 1, inReview: 0, ready: false },
    items: [{ ticketKey: `${project}-1`, title: "Partial refunds", docsRequired: "yes", docsStatus: "missing", reasons: [] }],
  };
}

const permission = (name: string, havePermission: boolean): Reply => ({ status: 200, body: { permissions: { [name]: { id: "1", key: name, havePermission } } } });

type JiraAnswer = Reply | Error | ((request: JiraRequest) => Reply | Error);

/** Jira stub: answers each known route, 500 for anything else. An answer may be a function of the request. */
function jira(routes: Record<string, JiraAnswer>) {
  state.jira = (route, request) => {
    const answer = routes[route];
    if (answer === undefined) return { status: 500, text: `unexpected Jira call ${route}` };
    return typeof answer === "function" ? answer(request) : answer;
  };
}

function docops(reply: Reply | Error | ((call: DocOpsCall) => Reply | Error)) {
  state.docops = typeof reply === "function" ? reply : () => reply;
}

/** Not `assert.deepEqual(calls, [])`: its assertion signature would narrow the array to `never[]`. */
const noDocOpsCalls = () => assert.equal(state.docopsCalls.length, 0, `DocOps was called: ${state.docopsCalls.map((c) => c.path).join(", ")}`);
const noJiraCalls = () => assert.equal(state.jiraCalls.length, 0, `Jira was called: ${state.jiraCalls.join(", ")}`);

const only = <T>(items: T[]): T => {
  assert.equal(items.length, 1, `expected exactly one entry, got ${items.length}`);
  return items[0] as T;
};

function errorOf(result: AnyResult) {
  assert.equal(result.ok, false, "expected a failure");
  return (result as { ok: false; error: { status: number; title: string; detail?: string; code?: string } }).error;
}

const SEARCH_ROUTE = "/rest/api/3/search/jql";
const ISSUE_ROUTE = (key: string) => `/rest/api/3/issue/${key}?fields=summary`;
/** The permission lookups only, ignoring the visibility search that follows a readiness answer. */
const permissionLookups = () => state.jiraCalls.filter((route) => route.startsWith("/rest/api/3/mypermissions"));
/** The JSON bodies of the visibility searches, in order. */
const searchBodies = () =>
  state.jiraRequests.filter((r) => r.route === SEARCH_ROUTE).map((r) => JSON.parse(r.body ?? "null") as { jql: string; fields: string[]; maxResults: number; nextPageToken?: string });

/** The search answers with these keys on one page. */
const sees = (...keys: string[]): Reply => ({ status: 200, body: { issues: keys.map((key) => ({ id: key.replace(/\D/g, ""), key })), isLast: true } });

/** The search answers page by page: page n carries nextPageToken "t<n>" except the last. */
function pages(...keySets: string[][]): (request: JiraRequest) => Reply {
  return (request) => {
    const token = (JSON.parse(request.body ?? "{}") as { nextPageToken?: string }).nextPageToken;
    const index = token === undefined ? 0 : Number(token.slice(1));
    const keys = keySets[index] ?? [];
    return { status: 200, body: { issues: keys.map((key) => ({ id: key.replace(/\D/g, ""), key })), ...(index < keySets.length - 1 ? { nextPageToken: `t${index + 1}` } : { isLast: true }) } };
  };
}

function item(ticketKey: string, docsStatus: string, extra: Record<string, unknown> = {}) {
  return { ticketKey, title: `Title of ${ticketKey}`, docsRequired: docsStatus === "not_required" ? "no" : "yes", docsStatus, reasons: [], ...extra };
}

/** A DocOps readiness answer whose summary is deliberately not what recomputing it would give. */
function readinessOf(project: string, fixVersion: string, items: ReturnType<typeof item>[]) {
  return {
    project,
    fixVersion,
    generatedAt: "2026-10-18T14:05:12Z",
    summary: { total: items.length, byStatus: { missing: 1, stale: 1, published: 1, in_review: 1, merged: 0, not_required: 0 }, readyPercent: 82.1, blockers: 2, inReview: 1, ready: false },
    items,
  };
}
const PERMISSION_ROUTE = (name: string, scope = "") => `/rest/api/3/mypermissions?permissions=${name}${scope}`;

// ---- getTicketDocs: which key is trusted ------------------------------------------------------

test("getTicketDocs: the issue from the Forge context needs no Jira call", async () => {
  docops({ status: 200, body: ticketDocs("PAY-1") });
  const result = await invoke("getTicketDocs", {}, issueContext("PAY-1"));
  assert.equal(result.ok, true);
  noJiraCalls();
  const call = only(state.docopsCalls);
  assert.equal(call.remoteKey, "docops");
  assert.equal(call.method, "GET");
  assert.equal(call.path, "/v1/tickets/PAY-1/docs?tracker=jira");
  assert.equal(call.headers["Accept"], "application/json");
});

test("getTicketDocs: a forged payload key never replaces the context key", async () => {
  docops({ status: 200, body: ticketDocs("PAY-1") });
  const result = await invoke("getTicketDocs", { issueKey: "SEC-9" }, issueContext("PAY-1"));
  assert.equal(result.ok, true);
  noJiraCalls();
  assert.equal(only(state.docopsCalls).path, "/v1/tickets/PAY-1/docs?tracker=jira");
});

test("getTicketDocs: a key that only came from the payload is read from Jira as the user first", async () => {
  jira({ [ISSUE_ROUTE("SEC-9")]: { status: 200, body: { key: "SEC-9", fields: { summary: "x" } } } });
  docops({ status: 200, body: ticketDocs("SEC-9") });
  const result = await invoke("getTicketDocs", { issueKey: "SEC-9" }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(state.jiraCalls, [ISSUE_ROUTE("SEC-9")]);
  assert.equal(only(state.docopsCalls).path, "/v1/tickets/SEC-9/docs?tracker=jira");
});

for (const status of [401, 403, 404]) {
  test(`getTicketDocs: Jira answering ${status} for a payload-only key means denied, and DocOps is not called`, async () => {
    jira({ [ISSUE_ROUTE("SEC-9")]: { status } });
    const error = errorOf(await invoke("getTicketDocs", { issueKey: "SEC-9" }, {}));
    assert.deepEqual([error.status, error.code, error.title], [403, "forge_forbidden", "You cannot view SEC-9"]);
    noDocOpsCalls();
  });
}

test("getTicketDocs: a failed visibility lookup is 'unverified', not 'denied', and DocOps is not called", async () => {
  for (const reply of [{ status: 500 }, { status: 429 }, new Error("socket hang up")]) {
    state.jiraCalls.length = 0;
    jira({ [ISSUE_ROUTE("SEC-9")]: reply });
    const error = errorOf(await invoke("getTicketDocs", { issueKey: "SEC-9" }, {}));
    assert.deepEqual([error.status, error.code], [502, "forge_jira_error"]);
  }
  noDocOpsCalls();
});

test("getTicketDocs: malformed keys are rejected before any call", async () => {
  for (const issueKey of ["../../etc/passwd", "pay-1", "PAY-1/../SEC-2", "PAY-1?x=1", "", 42, undefined, null]) {
    const error = errorOf(await invoke("getTicketDocs", { issueKey }, {}));
    assert.deepEqual([error.status, error.code], [400, "forge_bad_request"], String(issueKey));
  }
  noJiraCalls();
  noDocOpsCalls();
});

test("getTicketDocs: a project that is not enabled stops before DocOps is called", async () => {
  state.kvs.set("docops.config", { spaceId: null, projects: ["SEC"], updatedAt: null });
  const error = errorOf(await invoke("getTicketDocs", {}, issueContext("PAY-1")));
  assert.deepEqual([error.status, error.code], [409, "forge_project_disabled"]);
  noDocOpsCalls();
  docops({ status: 200, body: ticketDocs("SEC-1") });
  assert.equal((await invoke("getTicketDocs", {}, issueContext("SEC-1"))).ok, true);
});

test("getTicketDocs: storage being down does not take the panel down", async () => {
  state.kvsDown = true;
  docops({ status: 200, body: ticketDocs("PAY-1") });
  assert.equal((await invoke("getTicketDocs", {}, issueContext("PAY-1"))).ok, true);
});

// ---- getReadiness: which project is trusted, and which rows the user may see ---------------------

test("getReadiness: the project from the Forge context needs no permission lookup", async () => {
  docops({ status: 200, body: readiness("PAY", "2.4.0") });
  jira({ [SEARCH_ROUTE]: sees("PAY-1") });
  const result = await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"));
  assert.equal(result.ok, true);
  assert.deepEqual(permissionLookups(), []);
  assert.equal(only(state.docopsCalls).path, "/v1/readiness?tracker=jira&project=PAY&fixVersion=2.4.0");
});

test("getReadiness: a forged payload project never replaces the context project", async () => {
  docops({ status: 200, body: readiness("PAY", "2.4.0") });
  jira({ [SEARCH_ROUTE]: sees("PAY-1") });
  await invoke("getReadiness", { project: "SEC", fixVersion: "2.4.0" }, projectContext("PAY"));
  assert.deepEqual(permissionLookups(), []);
  assert.match(only(state.docopsCalls).path, /project=PAY&/);
  assert.match(only(searchBodies()).jql, /^project = "PAY" AND/);
});

test("getReadiness: a project that only came from the payload needs Browse projects for this user", async () => {
  jira({ [PERMISSION_ROUTE("BROWSE_PROJECTS", "&projectKey=SEC")]: permission("BROWSE_PROJECTS", true), [SEARCH_ROUTE]: sees("SEC-1") });
  docops({ status: 200, body: readiness("SEC", "1.0") });
  const result = await invoke("getReadiness", { project: "SEC", fixVersion: "1.0" }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(permissionLookups(), [PERMISSION_ROUTE("BROWSE_PROJECTS", "&projectKey=SEC")]);
  assert.equal(only(state.docopsCalls).path, "/v1/readiness?tracker=jira&project=SEC&fixVersion=1.0");
});

test("getReadiness: without Browse projects, or when Jira says the project is hidden, DocOps is not called", async () => {
  for (const reply of [permission("BROWSE_PROJECTS", false), { status: 404 }]) {
    jira({ [PERMISSION_ROUTE("BROWSE_PROJECTS", "&projectKey=SEC")]: reply });
    const error = errorOf(await invoke("getReadiness", { project: "SEC", fixVersion: "1.0" }, {}));
    assert.deepEqual([error.status, error.code, error.title], [403, "forge_forbidden", "You cannot browse project SEC"]);
  }
  noDocOpsCalls();
});

test("getReadiness: a failed permission lookup is 'unverified' and blocks the call", async () => {
  jira({ [PERMISSION_ROUTE("BROWSE_PROJECTS", "&projectKey=SEC")]: { status: 500 } });
  const error = errorOf(await invoke("getReadiness", { project: "SEC", fixVersion: "1.0" }, {}));
  assert.deepEqual([error.status, error.code], [502, "forge_jira_error"]);
  noDocOpsCalls();
});

test("getReadiness: version names are encoded into the query, and a missing one is a 400", async () => {
  docops({ status: 200, body: readiness("PAY", "Release 2026.10 (beta)") });
  jira({ [SEARCH_ROUTE]: sees("PAY-1") });
  await invoke("getReadiness", { fixVersion: " Release 2026.10 (beta) " }, projectContext("PAY"));
  assert.equal(only(state.docopsCalls).path, "/v1/readiness?tracker=jira&project=PAY&fixVersion=Release+2026.10+%28beta%29");
  for (const fixVersion of ["", "   ", undefined, 7]) {
    assert.equal(errorOf(await invoke("getReadiness", { fixVersion }, projectContext("PAY"))).status, 400, String(fixVersion));
  }
});

test("a permission answer that is not a clear yes or no is 'unverified', and only a literal true grants", async () => {
  const route = PERMISSION_ROUTE("BROWSE_PROJECTS", "&projectKey=SEC");
  for (const reply of [{ status: 200, body: { permissions: {} } }, { status: 200, body: null }, { status: 200, body: {} }, { status: 200, text: "not json" }]) {
    jira({ [route]: reply });
    const error = errorOf(await invoke("getReadiness", { project: "SEC", fixVersion: "1.0" }, {}));
    assert.deepEqual([error.status, error.code], [502, "forge_jira_error"], JSON.stringify(reply));
  }
  jira({ [route]: { status: 200, body: { permissions: { BROWSE_PROJECTS: { havePermission: "true" } } } } });
  assert.equal(errorOf(await invoke("getReadiness", { project: "SEC", fixVersion: "1.0" }, {})).status, 403, 'the string "true" is not a grant');
  noDocOpsCalls();
});

// ---- getReadiness: rows hidden by issue security -----------------------------------------------

const FOUR = [item("PAY-1", "missing"), item("PAY-2", "stale", { pages: ["secret-plan.md"], pullRequests: [9] }), item("PAY-3", "published"), item("PAY-4", "in_review")];

test("getReadiness: rows the user cannot see are dropped, and the totals are recomputed from the rows that remain", async () => {
  docops({ status: 200, body: readinessOf("PAY", "2.4.0", FOUR) });
  jira({ [SEARCH_ROUTE]: sees("PAY-1", "PAY-3") });
  const result = await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"));
  assert.equal(result.ok, true);
  const data = (result as { ok: true; data: { items: Array<{ ticketKey: string }>; summary: Record<string, unknown> } }).data;
  assert.deepEqual(data.items.map((i) => i.ticketKey), ["PAY-1", "PAY-3"]);
  assert.deepEqual(data.summary, {
    total: 2,
    byStatus: { not_required: 0, missing: 1, in_review: 0, merged: 0, published: 1, stale: 0 },
    readyPercent: 50,
    blockers: 1,
    inReview: 0,
    ready: false,
  });
  const everything = JSON.stringify(result);
  for (const hidden of ["PAY-2", "PAY-4", "secret-plan.md", "Title of PAY-2", "Title of PAY-4"]) assert.ok(!everything.includes(hidden), `${hidden} leaked into the answer`);
});

test("getReadiness: when every row is visible DocOps's own summary is passed through untouched", async () => {
  const docopsAnswer = readinessOf("PAY", "2.4.0", FOUR);
  docops({ status: 200, body: docopsAnswer });
  jira({ [SEARCH_ROUTE]: sees("PAY-1", "PAY-2", "PAY-3", "PAY-4", "PAY-5", "PAY-6") });
  assert.deepEqual(await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY")), { ok: true, data: docopsAnswer });
});

test("getReadiness: a user who sees nothing gets an empty table and zero totals", async () => {
  docops({ status: 200, body: readinessOf("PAY", "2.4.0", FOUR) });
  jira({ [SEARCH_ROUTE]: sees() });
  const result = (await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"))) as { ok: true; data: { items: unknown[]; summary: Record<string, unknown> } };
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, []);
  assert.deepEqual([result.data.summary["total"], result.data.summary["blockers"], result.data.summary["inReview"]], [0, 0, 0]);
});

test("getReadiness: the search is made as the user with a quoted JQL and the key field", async () => {
  docops({ status: 200, body: readinessOf("PAY", "2.4.0", FOUR) });
  jira({ [SEARCH_ROUTE]: sees("PAY-1") });
  await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"));
  const request = only(state.jiraRequests);
  assert.deepEqual([request.route, request.method], [SEARCH_ROUTE, "POST"]);
  assert.deepEqual(JSON.parse(request.body ?? "null"), { jql: 'project = "PAY" AND fixVersion = "2.4.0"', fields: ["key"], maxResults: 100 });
});

test("getReadiness: a fix version name cannot break out of its JQL quotes", async () => {
  const nasty = '2.4.0" OR project = "SEC\\';
  docops({ status: 200, body: readinessOf("PAY", nasty, FOUR) });
  jira({ [SEARCH_ROUTE]: sees("PAY-1") });
  await invoke("getReadiness", { fixVersion: nasty }, projectContext("PAY"));
  assert.equal(only(searchBodies()).jql, 'project = "PAY" AND fixVersion = "2.4.0\\" OR project = \\"SEC\\\\"');
});

test("getReadiness: the search follows nextPageToken until the last page", async () => {
  docops({ status: 200, body: readinessOf("PAY", "2.4.0", FOUR) });
  jira({ [SEARCH_ROUTE]: pages(["PAY-1"], ["PAY-3"], ["PAY-4"]) });
  const result = (await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"))) as { ok: true; data: { items: Array<{ ticketKey: string }> } };
  assert.deepEqual(result.data.items.map((i) => i.ticketKey), ["PAY-1", "PAY-3", "PAY-4"], "keys from every page count as visible");
  assert.deepEqual(searchBodies().map((b) => b.nextPageToken), [undefined, "t1", "t2"]);
  assert.ok(searchBodies().every((b) => b.maxResults === 100 && b.jql === 'project = "PAY" AND fixVersion = "2.4.0"'));
});

test("getReadiness: hitting the page cap shows nothing and says why", async () => {
  docops({ status: 200, body: readinessOf("PAY", "2.4.0", FOUR) });
  // Full pages of 100 distinct issues, forever.
  jira({
    [SEARCH_ROUTE]: () => {
      const page = searchBodies().length - 1;
      return { status: 200, body: { issues: Array.from({ length: 100 }, (_, i) => ({ id: String(page * 100 + i), key: `PAY-${page * 100 + i + 1}` })), nextPageToken: `t${page + 1}` } };
    },
  });
  const error = errorOf(await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY")));
  assert.deepEqual([error.status, error.code, error.title], [422, "forge_too_many_issues", "This fix version has too many issues to check"]);
  assert.equal(searchBodies().length, 20, "the cap is 20 pages of 100");
  assert.match(error.detail ?? "", /More than 2000 issues/);
});

test("getReadiness: a search that fails or answers oddly is 'unverified' and shows no rows", async () => {
  const bad: Array<[string, JiraAnswer]> = [
    ["HTTP 500", { status: 500 }],
    ["HTTP 400 (invalid JQL)", { status: 400, body: { errorMessages: ["bad jql"] } }],
    ["HTTP 403", { status: 403 }],
    ["thrown error", new Error("socket hang up")],
    ["no issue list", { status: 200, body: { total: 3 } }],
    ["not JSON", { status: 200, text: "<html>" }],
    ["an issue without a key", { status: 200, body: { issues: [{ id: "10001" }] } }],
    ["a key that is not a string", { status: 200, body: { issues: [{ id: "10001", key: 7 }] } }],
  ];
  for (const [label, answer] of bad) {
    jira({ [SEARCH_ROUTE]: answer });
    docops({ status: 200, body: readinessOf("PAY", "2.4.0", FOUR) });
    const result = await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"));
    const error = errorOf(result);
    assert.deepEqual([error.status, error.code], [502, "forge_jira_error"], label);
    assert.ok(!JSON.stringify(result).includes("PAY-2"), `${label}: rows leaked`);
  }
});

test("getReadiness: a failure on a later page also shows nothing, even though earlier pages worked", async () => {
  docops({ status: 200, body: readinessOf("PAY", "2.4.0", FOUR) });
  jira({ [SEARCH_ROUTE]: (request) => (JSON.parse(request.body ?? "{}").nextPageToken === undefined ? { status: 200, body: { issues: [{ id: "1", key: "PAY-1" }], nextPageToken: "t1" } } : { status: 500 }) });
  assert.equal(errorOf(await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"))).status, 502);
});

test("getReadiness: no search is made when DocOps has no rows or answers with an error", async () => {
  docops({ status: 200, body: readinessOf("PAY", "2.4.0", []) });
  assert.equal((await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"))).ok, true);
  docops({ status: 401, body: { title: "Unauthorized", status: 401 } });
  assert.equal(errorOf(await invoke("getReadiness", { fixVersion: "2.4.0" }, projectContext("PAY"))).status, 401);
  noJiraCalls();
});

// ---- createDocTasks -------------------------------------------------------------------------

test("createDocTasks: creates tasks only after the user's Create issues permission and the tickets' visibility are confirmed", async () => {
  jira({ [PERMISSION_ROUTE("CREATE_ISSUES", "&projectKey=PAY")]: permission("CREATE_ISSUES", true), [SEARCH_ROUTE]: sees("PAY-1", "PAY-2", "PAY-3") });
  docops({ status: 200, body: { created: [{ parentKey: "PAY-2", key: "PAY-90" }], skipped: [] } });
  const key = "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e99";
  const result = await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-2", "PAY-3", "PAY-2"], idempotencyKey: key }, projectContext("PAY"));
  assert.equal(result.ok, true);
  // The permission is checked first, then the user's own search for the version, then DocOps is called.
  assert.deepEqual(state.jiraCalls, [PERMISSION_ROUTE("CREATE_ISSUES", "&projectKey=PAY"), SEARCH_ROUTE]);
  assert.equal(only(searchBodies()).jql, 'project = "PAY" AND fixVersion = "2.4.0"');
  const call = only(state.docopsCalls);
  assert.deepEqual([call.method, call.path, call.headers["Idempotency-Key"], call.headers["Content-Type"]], ["POST", "/v1/readiness/doc-tasks", key, "application/json"]);
  assert.deepEqual(JSON.parse(call.body ?? "null"), { project: "PAY", fixVersion: "2.4.0", ticketKeys: ["PAY-2", "PAY-3"] });
});

test("createDocTasks: a malformed idempotency key is replaced, not forwarded", async () => {
  jira({ [PERMISSION_ROUTE("CREATE_ISSUES", "&projectKey=PAY")]: permission("CREATE_ISSUES", true), [SEARCH_ROUTE]: sees("PAY-2") });
  docops({ status: 200, body: { created: [], skipped: [] } });
  await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-2"], idempotencyKey: "bad key\nwith newline" }, projectContext("PAY"));
  assert.match(only(state.docopsCalls).headers["Idempotency-Key"] ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
});

test("createDocTasks: tickets of another project are refused before any Jira or DocOps call", async () => {
  const error = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-2", "SEC-1"] }, projectContext("PAY")));
  assert.deepEqual([error.status, error.code, error.title], [400, "forge_bad_request", "Tickets must belong to the project"]);
  noJiraCalls();
  noDocOpsCalls();
});

test("createDocTasks: invalid lists are rejected", async () => {
  for (const ticketKeys of [[], ["pay-1"], "PAY-1", undefined, [7], Array.from({ length: 501 }, (_, i) => `PAY-${i + 1}`)]) {
    const error = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys }, projectContext("PAY")));
    assert.equal(error.status, 400, JSON.stringify(ticketKeys)?.slice(0, 30));
  }
  noJiraCalls();
  noDocOpsCalls();
});

test("createDocTasks: no Create issues permission means no tasks, and an unverifiable one is reported as such", async () => {
  jira({ [PERMISSION_ROUTE("CREATE_ISSUES", "&projectKey=PAY")]: permission("CREATE_ISSUES", false) });
  const denied = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-2"] }, projectContext("PAY")));
  assert.deepEqual([denied.status, denied.code], [403, "forge_forbidden"]);
  jira({ [PERMISSION_ROUTE("CREATE_ISSUES", "&projectKey=PAY")]: { status: 503 } });
  const unverified = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-2"] }, projectContext("PAY")));
  assert.deepEqual([unverified.status, unverified.code], [502, "forge_jira_error"]);
  assert.equal(searchBodies().length, 0, "the visibility search only follows a granted permission");
  noDocOpsCalls();
});

// A user who may create issues can still be hidden from some of them (issue security levels), and DocOps
// would create sub-tasks under them as the app and report their docs status. The list must be the user's own.
const CAN_CREATE = { [PERMISSION_ROUTE("CREATE_ISSUES", "&projectKey=PAY")]: permission("CREATE_ISSUES", true) };

test("createDocTasks: a ticket the user cannot see is refused as a whole, and DocOps is not called", async () => {
  jira({ ...CAN_CREATE, [SEARCH_ROUTE]: sees("PAY-1", "PAY-3") });
  const error = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-1", "PAY-2", "PAY-3"] }, projectContext("PAY")));
  assert.deepEqual([error.status, error.code, error.title], [403, "forge_forbidden", "Some of these tickets are not available to you"]);
  assert.ok(!JSON.stringify(error).includes("PAY-2"), "the refusal must not name the ticket");
  noDocOpsCalls();
});

test("createDocTasks: a hidden ticket and one outside the fix version get exactly the same answer", async () => {
  jira({ ...CAN_CREATE, [SEARCH_ROUTE]: sees("PAY-1") });
  const hiddenOrElsewhere = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-1", "PAY-2"] }, projectContext("PAY")));
  const nonexistent = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-1", "PAY-98765"] }, projectContext("PAY")));
  assert.deepEqual(hiddenOrElsewhere, nonexistent);
  noDocOpsCalls();
});

test("createDocTasks: a visibility search that fails or answers oddly creates nothing", async () => {
  for (const answer of [{ status: 500 }, { status: 403 }, { status: 200, body: { nope: true } }, { status: 200, body: { issues: [{ id: "1" }] } }, new Error("socket hang up")] as const) {
    jira({ ...CAN_CREATE, [SEARCH_ROUTE]: answer });
    const error = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-2"] }, projectContext("PAY")));
    assert.deepEqual([error.status, error.code], [502, "forge_jira_error"], JSON.stringify(answer));
  }
  noDocOpsCalls();
});

test("createDocTasks: the visible set is read to the last page, and a version over the cap refuses", async () => {
  jira({ ...CAN_CREATE, [SEARCH_ROUTE]: pages(["PAY-1"], ["PAY-2"]) });
  docops({ status: 200, body: { created: [], skipped: [] } });
  assert.equal((await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-2"] }, projectContext("PAY"))).ok, true);
  assert.deepEqual(searchBodies().map((b) => b.nextPageToken), [undefined, "t1"]);

  state.docopsCalls.length = 0;
  state.jiraRequests.length = 0;
  jira({ ...CAN_CREATE, [SEARCH_ROUTE]: pages(...Array.from({ length: 21 }, (_, i) => [`PAY-${i + 1}`])) });
  const error = errorOf(await invoke("createDocTasks", { fixVersion: "2.4.0", ticketKeys: ["PAY-1"] }, projectContext("PAY")));
  assert.deepEqual([error.status, error.code], [422, "forge_too_many_issues"]);
  assert.equal(searchBodies().length, 20);
  noDocOpsCalls();
});

// ---- linkPage ---------------------------------------------------------------------------------

test("linkPage: links with the user's Link issues permission on that very issue", async () => {
  jira({ [PERMISSION_ROUTE("LINK_ISSUES", "&issueKey=PAY-1")]: permission("LINK_ISSUES", true) });
  docops({ status: 201, body: { id: "l-1", ticketKey: "PAY-1", targetType: "page", source: "tracker_panel", createdAt: "2026-10-18T14:05:12Z" } });
  const result = await invoke("linkPage", { pageId: PAGE_ID }, issueContext("PAY-1"));
  assert.equal(result.ok, true);
  const call = only(state.docopsCalls);
  assert.deepEqual([call.method, call.path], ["POST", "/v1/links"]);
  assert.deepEqual(JSON.parse(call.body ?? "null"), { ticketKey: "PAY-1", tracker: "jira", targetType: "page", targetId: PAGE_ID });
  assert.match(call.headers["Idempotency-Key"] ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
});

test("linkPage: a forged payload issue cannot be linked to without permission on it", async () => {
  jira({ [PERMISSION_ROUTE("LINK_ISSUES", "&issueKey=SEC-9")]: permission("LINK_ISSUES", false) });
  const error = errorOf(await invoke("linkPage", { issueKey: "SEC-9", pageId: PAGE_ID }, {}));
  assert.deepEqual([error.status, error.code], [403, "forge_forbidden"]);
  noDocOpsCalls();
});

test("linkPage: page ids must be UUIDs", async () => {
  for (const pageId of ["", "not-a-uuid", `${PAGE_ID}/../x`, 5, undefined]) {
    assert.equal(errorOf(await invoke("linkPage", { pageId }, issueContext("PAY-1"))).status, 400, String(pageId));
  }
  noJiraCalls();
  noDocOpsCalls();
});

// ---- searchPages and listFixVersions ------------------------------------------------------------

test("searchPages: needs a configured space, and sends the cleaned query", async () => {
  const none = errorOf(await invoke("searchPages", { query: "refunds" }, issueContext("PAY-1")));
  assert.deepEqual([none.status, none.code], [409, "forge_space_not_configured"]);
  noDocOpsCalls();

  state.kvs.set("docops.config", { spaceId: SPACE_ID, projects: [], updatedAt: null });
  const page = { id: PAGE_ID, spaceId: SPACE_ID, path: "guides/refunds.md", slug: "guides/refunds", title: "Refunds", pageType: "guide" };
  docops({ status: 200, body: { items: [page], nextCursor: "abc" } });
  const result = await invoke("searchPages", { query: "  refund \n a payment " }, issueContext("PAY-1"));
  assert.deepEqual(result, { ok: true, data: { items: [page], hasMore: true } });
  assert.equal(only(state.docopsCalls).path, `/v1/spaces/${SPACE_ID}/pages?q=refund+a+payment&limit=10`);
  assert.equal(errorOf(await invoke("searchPages", { query: "   " }, issueContext("PAY-1"))).status, 400);
});

test("listFixVersions: reads the versions as the user and trims the fields", async () => {
  jira({ "/rest/api/3/project/PAY/versions": { status: 200, body: [{ id: "10000", name: "2.4.0", released: false, releaseDate: "2026-10-30", self: "https://x", projectId: 1 }] } });
  const result = await invoke("listFixVersions", {}, projectContext("PAY"));
  assert.deepEqual(result, { ok: true, data: [{ id: "10000", name: "2.4.0", released: false, releaseDate: "2026-10-30" }] });
  jira({ "/rest/api/3/project/PAY/versions": { status: 404 } });
  const missing = errorOf(await invoke("listFixVersions", {}, projectContext("PAY")));
  assert.deepEqual([missing.status, missing.code], [404, "forge_jira_error"]);
  assert.equal(errorOf(await invoke("listFixVersions", { project: "a/b" }, {})).status, 400);
});

// ---- settings: Jira administrators only ----------------------------------------------------------

const ADMIN = PERMISSION_ROUTE("ADMINISTER");

test("settings resolvers refuse users who are not Jira administrators", async () => {
  jira({ [ADMIN]: permission("ADMINISTER", false) });
  for (const [name, payload] of [["getConfig", {}], ["saveConfig", { spaceId: SPACE_ID, projects: ["PAY"] }], ["checkConnection", {}]] as const) {
    const error = errorOf(await invoke(name, payload, {}));
    assert.deepEqual([error.status, error.code], [403, "forge_forbidden"], name);
  }
  assert.equal(state.kvs.size, 0, "nothing was stored");
  noDocOpsCalls();
});

test("settings resolvers report an administrator lookup that failed as 'unverified'", async () => {
  jira({ [ADMIN]: { status: 500 } });
  const error = errorOf(await invoke("saveConfig", { spaceId: SPACE_ID }, {}));
  assert.deepEqual([error.status, error.code], [502, "forge_jira_error"]);
  assert.equal(state.kvs.size, 0);
});

test("administrators can read, save and test the settings", async () => {
  jira({ [ADMIN]: permission("ADMINISTER", true) });
  const before = await invoke("getConfig", {}, { cloudId: "c-1" });
  assert.deepEqual(before, { ok: true, data: { config: { spaceId: null, projects: [], updatedAt: null }, installation: { installationId: state.installationId, cloudId: "c-1" } } });

  const saved = await invoke("saveConfig", { spaceId: SPACE_ID.toUpperCase(), projects: ["PAY", "SEC", "PAY"] }, {});
  assert.equal(saved.ok, true);
  assert.deepEqual(state.kvs.get("docops.config") && Object.keys(state.kvs.get("docops.config") as object).sort(), ["projects", "spaceId", "updatedAt"]);
  assert.deepEqual((saved as { ok: true; data: { spaceId: string; projects: string[] } }).data.projects, ["PAY", "SEC"]);
  assert.equal((saved as { ok: true; data: { spaceId: string } }).data.spaceId, SPACE_ID, "stored lower-case");

  docops({ status: 200, body: { items: [], nextCursor: null } });
  assert.deepEqual(await invoke("checkConnection", {}, {}), { ok: true, data: { spaceId: SPACE_ID } });
  assert.equal(only(state.docopsCalls).path, `/v1/spaces/${SPACE_ID}/pages?limit=1`);
});

test("saveConfig validates its input and survives a storage failure", async () => {
  jira({ [ADMIN]: permission("ADMINISTER", true) });
  for (const payload of [{ spaceId: "not-a-uuid" }, { projects: ["pay"] }, { projects: "PAY" }, { projects: Array.from({ length: 201 }, (_, i) => `P${String(i).padStart(3, "A")}`) }]) {
    assert.equal(errorOf(await invoke("saveConfig", payload, {})).status, 400, JSON.stringify(payload).slice(0, 40));
  }
  assert.equal(state.kvs.size, 0);
  state.kvsDown = true;
  assert.equal(errorOf(await invoke("saveConfig", { spaceId: SPACE_ID }, {})).status, 500);
});

test("an empty space ID clears the setting", async () => {
  jira({ [ADMIN]: permission("ADMINISTER", true) });
  await invoke("saveConfig", { spaceId: SPACE_ID }, {});
  const cleared = await invoke("saveConfig", { spaceId: "  " }, {});
  assert.equal((cleared as { ok: true; data: { spaceId: string | null } }).data.spaceId, null);
});

// ---- DocOps responses ---------------------------------------------------------------------------

test("DocOps problem responses become typed errors without leaking raw bodies", async () => {
  docops({ status: 401, body: { type: "https://docs.docops.example/errors/auth", title: "Unauthorized", status: 401, detail: "Unknown installation", traceId: "t-1" } });
  const error = errorOf(await invoke("getTicketDocs", {}, issueContext("PAY-1")));
  assert.deepEqual(error, { status: 401, title: "Unauthorized", detail: "Unknown installation", traceId: "t-1" });
});

test("a 200 that is not the expected shape is reported, not forwarded", async () => {
  for (const reply of [{ status: 200, text: "<html>maintenance</html>" }, { status: 200, body: { docsStatus: "missing" } }, { status: 200 }]) {
    docops(reply);
    const error = errorOf(await invoke("getTicketDocs", {}, issueContext("PAY-1")));
    assert.deepEqual([error.status, error.title], [502, "Unexpected response from DocOps"]);
  }
});

test("a platform failure while calling DocOps is status 0 with no internal detail", async () => {
  docops(new Error("getaddrinfo ENOTFOUND api.internal.example"));
  const error = errorOf(await invoke("getTicketDocs", {}, issueContext("PAY-1")));
  assert.deepEqual(error, { status: 0, title: "DocOps API unreachable" });
});

test("non-JSON error bodies fall back to the HTTP status", async () => {
  docops({ status: 500, text: "Internal Server Error" });
  assert.deepEqual(errorOf(await invoke("getTicketDocs", {}, issueContext("PAY-1"))), { status: 500, title: "HTTP 500" });
});

test("every UI call has a resolver behind it", async () => {
  const names = ["getTicketDocs", "getReadiness", "createDocTasks", "linkPage", "searchPages", "listFixVersions", "getConfig", "saveConfig", "checkConnection"];
  for (const name of names) {
    // A defined resolver answers (with a validation error or data); an undefined one rejects.
    await assert.doesNotReject(invoke(name, {}, {}), name);
  }
  await assert.rejects(invoke("noSuchResolver", {}, {}), /no definition/);
});
