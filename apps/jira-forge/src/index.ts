/**
 * Forge resolver functions for DocOps for Jira (manifest: function key `resolver`, handler
 * `index.handler`, shared by every UI module).
 *
 * The functions are thin (docs/06-jira-integration.md §2): they validate input, take the issue or
 * project from the trusted Forge context, call the DocOps API through Forge Remote and hand the
 * result back as an `ApiResult`. All business logic (status computation, linking, readiness)
 * runs in DocOps. They never throw to the UI.
 *
 * Forge APIs used, and what they were verified against (October 2026):
 *   - `Resolver`, `resolver.define(key, fn)`, `resolver.getDefinitions()`, `Handlers<>`:
 *     @forge/resolver@2.0.1 `out/index.d.ts`;
 *     https://developer.atlassian.com/platform/forge/runtime-reference/forge-resolver/
 *   - `invokeRemote(remoteKey, { path, method, headers, body })` -> `{ ok, status, statusText, text(), json() }`:
 *     @forge/api@8.3.0 `out/api/endpoint.d.ts`;
 *     https://developer.atlassian.com/platform/forge/runtime-reference/invoke-remote-api/
 *     The remote needs `compute` in its `operations` (manifest.yml has it). Forge signs the call
 *     and sends the Forge Invocation Token as `Authorization: Bearer`; DocOps maps
 *     `app.installationId` in that token to the tenant. No API key is stored in this app.
 *   - `asUser().requestJira(route`...`)` and `route`: @forge/api@8.3.0 `out/index.d.ts`, `out/safeUrl.d.ts`
 *   - `getAppContext().installationAri.installationId`: @forge/api@8.3.0 `out/api/runtime.d.ts`;
 *     https://developer.atlassian.com/platform/forge/runtime-reference/app-context-api/
 *   - `kvs.get` / `kvs.set`: @forge/kvs@2.1.0 `out/kvs.d.ts` (needs the `storage:app` scope, which
 *     manifest.yml declares). Stored per installation; holds non-content settings only.
 */
import { asUser, getAppContext, invokeRemote, route } from "@forge/api";
import { kvs } from "@forge/kvs";
import Resolver from "@forge/resolver";
import type { Handlers } from "@forge/resolver";

import type { AdminConfig, AdminSettings, ConnectionStatus, PageSearchResult, ResolverDefinitions } from "./contract";
import {
  MAX_PROJECTS,
  MAX_TICKET_KEYS,
  allInProject,
  isProjectEnabled,
  isProjectKey,
  isUuid,
  jqlQuote,
  newIdempotencyKey,
  normalizeSearchQuery,
  normalizeVersionName,
  parseTicketKeys,
  projectKeyOfIssue,
  readIdempotencyKey,
  readIssueKey,
  readIssueKeyWithSource,
  readProjectKey,
  readProjectKeyWithSource,
} from "./validation";
import {
  isDocTasksResult,
  isJiraVersionList,
  isLink,
  isPageList,
  isReadiness,
  isTicketDocs,
  restrictReadiness,
  toApiError,
} from "./view-model";
import type { ApiError, ApiResult, JiraVersion, LinkCreate } from "./view-model";

/** `remotes[0].key` in manifest.yml. */
const REMOTE_KEY = "docops";
/** Key of the settings document in Forge hosted storage. */
const CONFIG_KEY = "docops.config";
const PAGE_SEARCH_LIMIT = 10;
/**
 * The visibility search asks for pages of 100 issues (`maxResults` is a maximum: Jira may return fewer)
 * and reads at most 20 of them, so 2,000 issues of one fix version when Jira honours the page size.
 */
const VISIBILITY_PAGE_SIZE = 100;
const MAX_VISIBILITY_PAGES = 20;

// ---------------------------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------------------------

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

/**
 * `code` values starting with `forge_` mark errors raised by this app (not by DocOps); their
 * title and detail are written for the user (see `toErrorViewModel`).
 */
function fail(status: number, title: string, detail?: string, code?: string): { ok: false; error: ApiError } {
  const error: ApiError = { status, title };
  if (detail !== undefined) error.detail = detail;
  if (code !== undefined) error.code = code;
  return { ok: false, error };
}

const badRequest = (title: string, detail?: string) => fail(400, title, detail, "forge_bad_request");
const forbidden = (title: string, detail: string) => fail(403, title, detail, "forge_forbidden");

function projectDisabled(project: string) {
  return fail(
    409,
    `DocOps is not enabled for project ${project}`,
    "A Jira administrator can change the project list in Jira settings > Apps > Manage apps > DocOps > Configure.",
    "forge_project_disabled",
  );
}

function spaceNotConfigured() {
  return fail(
    409,
    "No documentation space is configured",
    "A Jira administrator must choose the DocOps space in Jira settings > Apps > Manage apps > DocOps > Configure.",
    "forge_space_not_configured",
  );
}

/** Passes an error through, or checks that a successful body has the shape the UI depends on. */
function checked<T>(result: ApiResult<unknown>, guard: (value: unknown) => value is T, what: string): ApiResult<T> {
  if (!result.ok) return result;
  if (guard(result.data)) return ok(result.data);
  console.error(`DocOps returned an unexpected ${what} payload`);
  return fail(502, "Unexpected response from DocOps", `DocOps returned ${what} data that this version of the Jira app does not understand. Update the app or contact support.`);
}

// ---------------------------------------------------------------------------------------------
// DocOps API through Forge Remote
// ---------------------------------------------------------------------------------------------

interface RemoteCall {
  /** Path and query, relative to the remote's baseUrl. */
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function callDocOps(call: RemoteCall): Promise<ApiResult<unknown>> {
  const method = call.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (call.body !== undefined) headers["Content-Type"] = "application/json";
  if (call.idempotencyKey !== undefined) headers["Idempotency-Key"] = call.idempotencyKey;
  try {
    const response = await invokeRemote(REMOTE_KEY, {
      path: call.path,
      method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    const parsed = parseJson(await response.text());
    if (response.ok) return ok(parsed);
    const error = toApiError(response.status, response.statusText, parsed);
    console.warn(`DocOps ${method} ${call.path.split("?")[0]} -> ${error.status}${error.traceId ? ` (trace ${error.traceId})` : ""}`);
    return { ok: false, error };
  } catch (error) {
    // invokeRemote throws for platform-level failures (unknown remote, egress, network).
    console.error("DocOps call failed", error instanceof Error ? error.message : error);
    return fail(0, "DocOps API unreachable");
  }
}

// ---------------------------------------------------------------------------------------------
// Jira REST as the calling user (permission checks, fix versions)
// ---------------------------------------------------------------------------------------------

type JiraPermission = "ADMINISTER" | "BROWSE_PROJECTS" | "CREATE_ISSUES" | "LINK_ISSUES";
type PermissionCheck = "granted" | "denied" | "unverified";

/**
 * Whether the calling user holds a Jira permission (GET /rest/api/3/mypermissions, called as that
 * user). Every resolver is reachable from every module's UI and the payload is user input, so
 * reads and writes are authorized here instead of trusting that only the right screen calls them.
 * Anything but a clear "yes" blocks the action; "unverified" (Jira did not answer) is kept apart
 * from "denied" so that a lookup failure is not reported as a missing permission.
 */
async function checkJiraPermission(permission: JiraPermission, scope: { projectKey?: string; issueKey?: string } = {}): Promise<PermissionCheck> {
  const query = new URLSearchParams({ permissions: permission });
  if (scope.projectKey !== undefined) query.set("projectKey", scope.projectKey);
  if (scope.issueKey !== undefined) query.set("issueKey", scope.issueKey);
  try {
    const response = await asUser().requestJira(route`/rest/api/3/mypermissions?${query}`);
    // Jira answers 404 for a project or issue the user cannot see (or that does not exist).
    if (response.status === 404) return "denied";
    if (!response.ok) {
      console.warn(`mypermissions ${permission} -> ${response.status}`);
      return "unverified";
    }
    const body: unknown = await response.json();
    const permissions = (body as { permissions?: Record<string, { havePermission?: unknown } | undefined> } | null)?.permissions;
    const entry = permissions?.[permission];
    if (entry === undefined) return "unverified";
    return entry.havePermission === true ? "granted" : "denied";
  } catch (error) {
    console.error("mypermissions failed", error instanceof Error ? error.message : error);
    return "unverified";
  }
}

/**
 * Whether the calling user can see an issue. Jira answers 404 for an issue the user cannot browse,
 * also when an issue security level hides it, so 401, 403 and 404 all mean "denied"; any other
 * failure means Jira could not tell us ("unverified").
 */
async function checkIssueVisible(issueKey: string): Promise<PermissionCheck> {
  try {
    const response = await asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary`);
    if (response.ok) return "granted";
    if (response.status === 401 || response.status === 403 || response.status === 404) return "denied";
    console.warn(`issue visibility check -> ${response.status}`);
    return "unverified";
  } catch (error) {
    console.error("issue visibility check failed", error instanceof Error ? error.message : error);
    return "unverified";
  }
}

/** Jira did not answer a visibility or permission question: nothing is shown or done (HTTP 502). */
function unverified() {
  return fail(502, "Your Jira permissions could not be verified", "Try again; if it keeps failing, check the app logs with `forge logs`.", "forge_jira_error");
}

/** The error for a permission check that did not come back "granted". */
function notAllowed(check: Exclude<PermissionCheck, "granted">, title: string, detail: string) {
  return check === "denied" ? forbidden(title, detail) : unverified();
}

/**
 * The issues of a fix version that the calling user can see, from a JQL search made as that user, so
 * Jira applies project permissions and issue security levels. DocOps works as the app and covers
 * every issue it mirrors, so `getReadiness` cuts its rows down to these keys and `createDocTasks`
 * refuses tickets outside them. Fails closed: a search that fails, returns something unexpected or
 * does not finish within the page cap yields an error, never a partial set.
 */
async function visibleKeysInVersion(project: string, fixVersion: string): Promise<{ keys: Set<string> } | { error: ReturnType<typeof fail> }> {
  const jql = `project = ${jqlQuote(project)} AND fixVersion = ${jqlQuote(fixVersion)}`;
  const keys = new Set<string>();
  let read = 0;
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_VISIBILITY_PAGES; page++) {
    try {
      const response = await asUser().requestJira(route`/rest/api/3/search/jql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jql, fields: ["key"], maxResults: VISIBILITY_PAGE_SIZE, ...(nextPageToken === undefined ? {} : { nextPageToken }) }),
      });
      if (!response.ok) {
        console.warn(`issue search -> ${response.status}`);
        return { error: unverified() };
      }
      const body = (await response.json()) as { issues?: unknown; nextPageToken?: unknown } | null;
      const issues: unknown = body?.issues;
      if (!Array.isArray(issues)) {
        console.error("issue search returned no issue list");
        return { error: unverified() };
      }
      read += issues.length;
      for (const issue of issues as unknown[]) {
        const key = (issue as { key?: unknown } | null)?.key;
        if (typeof key !== "string") {
          console.error("issue search returned an issue without a key");
          return { error: unverified() };
        }
        keys.add(key);
      }
      const next = body?.nextPageToken;
      if (typeof next !== "string" || next === "") return { keys };
      nextPageToken = next;
    } catch (error) {
      console.error("issue search failed", error instanceof Error ? error.message : error);
      return { error: unverified() };
    }
  }
  return {
    error: fail(
      422,
      "This fix version has too many issues to check",
      `More than ${read} issues have this fix version, so DocOps cannot confirm which of them you may see. Nothing is shown or changed.`,
      "forge_too_many_issues",
    ),
  };
}

/** Settings are for Jira administrators: null when the caller is one, else the error to return. */
async function requireAdministrator(action: "view" | "change" | "test") {
  const administer = await checkJiraPermission("ADMINISTER");
  if (administer === "granted") return null;
  return notAllowed(administer, `Only Jira administrators can ${action} DocOps settings`, "Ask a user with the Administer Jira global permission.");
}

// ---------------------------------------------------------------------------------------------
// Settings in Forge hosted storage
// ---------------------------------------------------------------------------------------------

function normalizeConfig(stored: unknown): AdminConfig {
  const record = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const spaceId = isUuid(record["spaceId"]) ? record["spaceId"] : null;
  const projects = Array.isArray(record["projects"]) ? record["projects"].filter(isProjectKey).slice(0, MAX_PROJECTS) : [];
  const updatedAt = typeof record["updatedAt"] === "string" ? record["updatedAt"] : null;
  return { spaceId, projects, updatedAt };
}

/** Settings are optional: when storage is unavailable the app behaves as if nothing is configured. */
async function loadConfig(): Promise<AdminConfig> {
  try {
    return normalizeConfig(await kvs.get<unknown>(CONFIG_KEY));
  } catch (error) {
    console.error("Could not read settings", error instanceof Error ? error.message : error);
    return normalizeConfig(undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------------------------

const resolver = new Resolver();

/** `resolver.define` with the name, payload and result checked against `ResolverDefinitions`. */
function define<K extends keyof ResolverDefinitions & string>(name: K, handler: Handlers<ResolverDefinitions>[K]): void {
  resolver.define(name, handler);
}

/** GET /v1/tickets/{key}/docs (operation getTicketDocs): the issue panel and the issue-context glance. */
define("getTicketDocs", async ({ payload, context }) => {
  const issue = readIssueKeyWithSource(context, payload);
  if (issue === undefined) return badRequest("Issue key is missing or invalid");
  // A key from the Forge context is the issue the user is looking at. A key from the payload is
  // user input, and DocOps is called as the app, so first make sure this user can see that issue.
  if (!issue.trusted) {
    const visible = await checkIssueVisible(issue.key);
    if (visible !== "granted") {
      return notAllowed(visible, `You cannot view ${issue.key}`, "Jira does not show this issue to you, so DocOps does not show its documentation either.");
    }
  }
  const project = projectKeyOfIssue(issue.key);
  if (!isProjectEnabled((await loadConfig()).projects, project)) return projectDisabled(project);
  const result = await callDocOps({ path: `/v1/tickets/${encodeURIComponent(issue.key)}/docs?tracker=jira` });
  return checked(result, isTicketDocs, "ticket docs");
});

/** GET /v1/readiness (operation getReadiness): the project page, cut down to the issues the user can see. */
define("getReadiness", async ({ payload, context }) => {
  const found = readProjectKeyWithSource(context, payload);
  const fixVersion = normalizeVersionName(payload.fixVersion);
  if (found === undefined) return badRequest("Project is missing or invalid");
  if (fixVersion === undefined) return badRequest("Choose a fix version");
  const project = found.key;
  // Same rule as getTicketDocs: only a project from the payload needs the user's own check.
  if (!found.trusted) {
    const browse = await checkJiraPermission("BROWSE_PROJECTS", { projectKey: project });
    if (browse !== "granted") {
      return notAllowed(browse, `You cannot browse project ${project}`, "Jira does not show this project to you, so DocOps does not show its readiness either.");
    }
  }
  if (!isProjectEnabled((await loadConfig()).projects, project)) return projectDisabled(project);
  const query = new URLSearchParams({ tracker: "jira", project, fixVersion });
  const readiness = checked(await callDocOps({ path: `/v1/readiness?${query}` }), isReadiness, "readiness");
  if (!readiness.ok || readiness.data.items.length === 0) return readiness;
  // DocOps answers as the app and lists every issue it mirrors, whatever the user may see in Jira
  // (issue security levels hide issues from people who can browse the project). Keep only the rows
  // this user can see, and recompute the totals from them.
  const visible = await visibleKeysInVersion(project, fixVersion);
  if ("error" in visible) return visible.error;
  return ok(restrictReadiness(readiness.data, visible.keys));
});

/** POST /v1/readiness/doc-tasks (operation createDocTasks): bulk "Create doc tasks for Missing". */
define("createDocTasks", async ({ payload, context }) => {
  const project = readProjectKey(context, payload);
  const fixVersion = normalizeVersionName(payload.fixVersion);
  if (Array.isArray(payload.ticketKeys) && payload.ticketKeys.length > MAX_TICKET_KEYS) {
    return badRequest("Too many tickets", `Create doc tasks for at most ${MAX_TICKET_KEYS} tickets at a time.`);
  }
  const tickets = parseTicketKeys(payload.ticketKeys);
  if (project === undefined) return badRequest("Project is missing or invalid");
  if (fixVersion === undefined) return badRequest("Choose a fix version");
  if (tickets.invalid) return badRequest("The ticket list is not valid");
  if (tickets.keys.length === 0) return badRequest("There are no tickets with missing docs");
  // DocOps creates the sub-tasks as the app. So a payload must not be able to name tickets of another
  // project, and the user needs their own right to create issues in this one.
  if (!allInProject(tickets.keys, project)) return badRequest("Tickets must belong to the project", `Every ticket key must start with ${project}-.`);
  const create = await checkJiraPermission("CREATE_ISSUES", { projectKey: project });
  if (create !== "granted") {
    return notAllowed(create, `You cannot create issues in project ${project}`, "Doc tasks are created as sub-tasks, so Jira's Create issues permission is required.");
  }
  // DocOps acts on the tickets of the fix version it mirrors, whatever this user may see, and reports
  // what became of each one. A user who may create issues but cannot see some issue (an issue security
  // level) must not reach it with a crafted list, so each ticket has to be in the user's own search.
  // The same answer covers "hidden" and "not in this version": it must not tell the two apart.
  const visible = await visibleKeysInVersion(project, fixVersion);
  if ("error" in visible) return visible.error;
  if (tickets.keys.some((key) => !visible.keys.has(key))) {
    return forbidden(
      "Some of these tickets are not available to you",
      `Every ticket must be in fix version ${fixVersion} of project ${project} and visible to you. Reload the readiness table and try again.`,
    );
  }
  const result = await callDocOps({
    path: "/v1/readiness/doc-tasks",
    method: "POST",
    body: { project, fixVersion, ticketKeys: tickets.keys },
    idempotencyKey: readIdempotencyKey(payload.idempotencyKey) ?? newIdempotencyKey(),
  });
  return checked(result, isDocTasksResult, "doc task");
});

/** POST /v1/links (operation createLink): "Link documentation" in the panel and the issue action. */
define("linkPage", async ({ payload, context }) => {
  const issueKey = readIssueKey(context, payload);
  if (issueKey === undefined) return badRequest("Issue key is missing or invalid");
  if (!isUuid(payload.pageId)) return badRequest("Choose a page to link");
  const link = await checkJiraPermission("LINK_ISSUES", { issueKey });
  if (link !== "granted") return notAllowed(link, `You cannot link documentation to ${issueKey}`, "Jira's Link issues permission is required.");
  const body: LinkCreate = { ticketKey: issueKey, tracker: "jira", targetType: "page", targetId: payload.pageId };
  const result = await callDocOps({
    path: "/v1/links",
    method: "POST",
    body,
    idempotencyKey: readIdempotencyKey(payload.idempotencyKey) ?? newIdempotencyKey(),
  });
  return checked(result, isLink, "link");
});

/** GET /v1/spaces/{spaceId}/pages?q= (operation listPages) in the space chosen on the admin page. */
define("searchPages", async ({ payload }) => {
  const query = normalizeSearchQuery(payload.query);
  if (query === "") return badRequest("Enter a page title or path to search for");
  const { spaceId } = await loadConfig();
  if (spaceId === null) return spaceNotConfigured();
  const params = new URLSearchParams({ q: query, limit: String(PAGE_SEARCH_LIMIT) });
  const result = await callDocOps({ path: `/v1/spaces/${encodeURIComponent(spaceId)}/pages?${params}` });
  const list = checked(result, isPageList, "page list");
  if (!list.ok) return list;
  const found: PageSearchResult = { items: list.data.items, hasMore: typeof list.data.nextCursor === "string" && list.data.nextCursor !== "" };
  return ok(found);
});

/** Versions of the project, as the viewing user sees them, for the fix-version picker. */
define("listFixVersions", async ({ payload, context }) => {
  const project = readProjectKey(context, payload);
  if (project === undefined) return badRequest("Project is missing or invalid");
  try {
    const response = await asUser().requestJira(route`/rest/api/3/project/${project}/versions`);
    if (!response.ok) return fail(response.status, "Could not load the project's versions from Jira", undefined, "forge_jira_error");
    const body: unknown = await response.json();
    if (!isJiraVersionList(body)) return fail(502, "Jira returned versions in an unexpected format", undefined, "forge_jira_error");
    const versions: JiraVersion[] = body.map(({ id, name, released, archived, releaseDate }) => ({ id, name, released, archived, releaseDate }));
    return ok(versions);
  } catch (error) {
    console.error("Could not load versions", error instanceof Error ? error.message : error);
    return fail(502, "Could not load the project's versions from Jira", undefined, "forge_jira_error");
  }
});

/** Admin page: current settings and the installation ID that DocOps maps to a tenant. */
define("getConfig", async ({ context }) => {
  const denied = await requireAdministrator("view");
  if (denied !== null) return denied;
  const config = await loadConfig();
  let installationId = "";
  try {
    installationId = getAppContext().installationAri.installationId;
  } catch (error) {
    console.error("Could not read the installation ID", error instanceof Error ? error.message : error);
  }
  const cloudId = typeof context["cloudId"] === "string" ? context["cloudId"] : null;
  const settings: AdminSettings = { config, installation: { installationId, cloudId } };
  return ok(settings);
});

/** Admin page: save settings. Like getConfig and checkConnection it is for Jira administrators only; the check is made here, not in the UI. */
define("saveConfig", async ({ payload }) => {
  const denied = await requireAdministrator("change");
  if (denied !== null) return denied;
  const current = await loadConfig();
  let spaceId = current.spaceId;
  if (payload.spaceId !== undefined) {
    const text = typeof payload.spaceId === "string" ? payload.spaceId.trim() : "";
    if (text === "") spaceId = null;
    else if (isUuid(text)) spaceId = text.toLowerCase();
    else return badRequest("The space ID must be a UUID", "Copy it from the space settings in DocOps.");
  }
  let projects = current.projects;
  if (payload.projects !== undefined) {
    const list: unknown = payload.projects;
    if (!Array.isArray(list) || list.length > MAX_PROJECTS || !list.every(isProjectKey)) {
      return badRequest("Projects must be Jira project keys", "Use upper-case keys such as PAY, separated by commas.");
    }
    projects = [...new Set<string>(list)];
  }
  const config: AdminConfig = { spaceId, projects, updatedAt: new Date().toISOString() };
  try {
    await kvs.set(CONFIG_KEY, config);
  } catch (error) {
    console.error("Could not save settings", error instanceof Error ? error.message : error);
    return fail(500, "Settings could not be saved", "Try again; if it keeps failing, check the app logs with `forge logs`.");
  }
  return ok(config);
});

/**
 * Admin page: proves the whole chain works (Forge Remote, the FIT, the installation -> tenant
 * mapping and the configured space) with the cheapest authorized call: one page of listPages.
 */
define("checkConnection", async () => {
  const denied = await requireAdministrator("test");
  if (denied !== null) return denied;
  const { spaceId } = await loadConfig();
  if (spaceId === null) return spaceNotConfigured();
  const result = await callDocOps({ path: `/v1/spaces/${encodeURIComponent(spaceId)}/pages?limit=1` });
  const list = checked(result, isPageList, "page list");
  if (!list.ok) return list;
  const status: ConnectionStatus = { spaceId };
  return ok(status);
});

export const handler = resolver.getDefinitions();
