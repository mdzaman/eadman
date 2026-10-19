import { createHmac, timingSafeEqual } from "node:crypto";
import type { DocsRequired, DocsStatus, LinkSource } from "@docops/core";

// ---------------------------------------------------------------------------- key extraction & linking

/** Tokens that look like issue keys but never are (when no project allowlist is configured). */
const NOT_KEYS = new Set(["UTF", "ISO", "SHA", "RFC", "AES", "TLS", "HTTP", "UTC", "GMT", "CVE", "PCI", "SOC", "ECMA", "WCAG", "NIST", "OCSF"]);

export interface KeyOptions {
  pattern?: string | undefined;
  projects?: readonly string[] | undefined;
}

export function extractIssueKeys(text: string, options: KeyOptions = {}): string[] {
  const re = new RegExp(options.pattern ?? "\\b[A-Z][A-Z0-9_]+-\\d+\\b", "g");
  const keys: string[] = [];
  for (const match of text.matchAll(re)) {
    const key = match[0].toUpperCase();
    const project = key.split("-")[0] ?? "";
    if (options.projects && options.projects.length > 0 ? !options.projects.includes(project) : NOT_KEYS.has(project)) continue;
    if (/-0+$/.test(key)) continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export interface PullRequestForLinking {
  title: string;
  body?: string | undefined;
  headRef?: string | undefined;
  commits?: ReadonlyArray<{ sha: string; message: string }> | undefined;
}

export interface ExtractedLink {
  key: string;
  source: LinkSource;
  /** Commit sha for commit_message links. */
  targetRef?: string | undefined;
}

export type LinkSourceSetting = "pr_title" | "pr_body" | "branch_name" | "commit_message" | "frontmatter";

/** Ticket links implied by a pull request, with provenance (docs/06-jira-integration.md §5). */
export function linksFromPullRequest(pr: PullRequestForLinking, linkFrom: readonly LinkSourceSetting[], keys: KeyOptions = {}): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const add = (key: string, source: LinkSource, targetRef?: string) => {
    if (!out.some((l) => l.key === key && l.source === source && l.targetRef === targetRef)) out.push({ key, source, targetRef });
  };
  if (linkFrom.includes("pr_title")) for (const k of extractIssueKeys(pr.title, keys)) add(k, "pr_title");
  if (linkFrom.includes("pr_body") && pr.body) for (const k of extractIssueKeys(pr.body, keys)) add(k, "pr_body");
  if (linkFrom.includes("branch_name") && pr.headRef) for (const k of extractIssueKeys(pr.headRef.toUpperCase(), keys)) add(k, "branch_name");
  if (linkFrom.includes("commit_message")) {
    for (const c of pr.commits ?? []) for (const k of extractIssueKeys(c.message, keys)) add(k, "commit_message", c.sha);
  }
  return out;
}

// ---------------------------------------------------------------------------- Jira REST v3

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    fixVersions?: Array<{ id?: string; name: string }>;
    labels?: string[];
    parent?: { key: string };
    assignee?: { displayName?: string; accountId?: string } | null;
    updated?: string;
    [customField: string]: unknown;
  };
}

export interface RemoteLink {
  globalId: string;
  url: string;
  title: string;
  summary?: string | undefined;
  iconUrl?: string | undefined;
  resolved?: boolean | undefined;
}

export interface JiraClient {
  readonly site: string;
  getIssue(key: string, fields?: readonly string[]): Promise<JiraIssue | null>;
  searchJql(jql: string, fields: readonly string[], maxIssues?: number): Promise<JiraIssue[]>;
  setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void>;
  upsertRemoteLink(key: string, link: RemoteLink): Promise<void>;
  createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }>;
  /** Forge apps only: write a value to the app-owned custom field. */
  setAppFieldValue?(fieldKey: string, issueIds: readonly string[], value: string): Promise<void>;
}

export class JiraApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HttpJiraClientOptions {
  /** https://acme.atlassian.net, a DC base URL, or https://api.atlassian.com/ex/jira/{cloudId} */
  baseUrl: string;
  auth: { type: "basic"; email: string; apiToken: string } | { type: "bearer"; token: string };
  fetch?: typeof fetch | undefined;
}

export class HttpJiraClient implements JiraClient {
  readonly site: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpJiraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.site = new URL(this.baseUrl).host;
    this.authHeader =
      options.auth.type === "basic"
        ? `Basic ${Buffer.from(`${options.auth.email}:${options.auth.apiToken}`).toString("base64")}`
        : `Bearer ${options.auth.token}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T | null> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: this.authHeader, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (okStatuses.includes(response.status)) return null;
    if (!response.ok) throw new JiraApiError(response.status, `${method} ${path} -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T | null;
  }

  async getIssue(key: string, fields: readonly string[] = ["summary", "status", "issuetype", "fixVersions", "labels", "parent", "updated"]): Promise<JiraIssue | null> {
    return this.request<JiraIssue>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.map(encodeURIComponent).join(",")}`, undefined, [404]);
  }

  /** Enhanced search (`/rest/api/3/search/jql`), paginated by nextPageToken. */
  async searchJql(jql: string, fields: readonly string[], maxIssues = 2000): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{ issues: JiraIssue[]; nextPageToken?: string }>("POST", "/rest/api/3/search/jql", {
        jql,
        fields,
        maxResults: Math.min(100, maxIssues - issues.length),
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      issues.push(...(page?.issues ?? []));
      nextPageToken = page?.nextPageToken;
    } while (nextPageToken && issues.length < maxIssues);
    return issues;
  }

  async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`, value);
  }

  async upsertRemoteLink(key: string, link: RemoteLink): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, {
      globalId: link.globalId,
      application: { type: "io.docops", name: "DocOps" },
      object: {
        url: link.url,
        title: link.title,
        summary: link.summary,
        icon: link.iconUrl ? { url16x16: link.iconUrl, title: "DocOps" } : undefined,
        status: link.resolved === undefined ? undefined : { resolved: link.resolved },
      },
    });
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const created = await this.request<{ id: string; key: string }>("POST", "/rest/api/3/issue", { fields });
    if (!created) throw new JiraApiError(500, "empty response creating issue");
    return created;
  }

  async setAppFieldValue(fieldKey: string, issueIds: readonly string[], value: string): Promise<void> {
    await this.request("PUT", `/rest/api/3/app/field/${encodeURIComponent(fieldKey)}/value`, {
      updates: [{ issueIds: issueIds.map(Number), value }],
    });
  }
}

/** In-memory Jira for tests and offline demos. Records every write. */
export class FakeJiraClient implements JiraClient {
  readonly site: string;
  readonly issues = new Map<string, JiraIssue>();
  readonly properties = new Map<string, unknown>();
  readonly remoteLinks = new Map<string, RemoteLink[]>();
  readonly fieldValues = new Map<string, string>();
  readonly created: Array<Record<string, unknown>> = [];
  readonly calls: string[] = [];

  constructor(site = "acme.atlassian.net", issues: JiraIssue[] = []) {
    this.site = site;
    for (const issue of issues) this.issues.set(issue.key, issue);
  }

  async getIssue(key: string): Promise<JiraIssue | null> {
    this.calls.push(`getIssue ${key}`);
    return this.issues.get(key) ?? null;
  }

  async searchJql(jql: string): Promise<JiraIssue[]> {
    this.calls.push(`searchJql ${jql}`);
    const project = /project\s*=\s*"?([A-Z0-9_]+)"?/i.exec(jql)?.[1];
    const fixVersion = /fixVersion\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(jql)?.[1]?.replace(/\\(.)/g, "$1");
    return [...this.issues.values()].filter(
      (i) => (!project || i.key.startsWith(`${project}-`)) && (!fixVersion || (i.fields.fixVersions ?? []).some((v) => v.name === fixVersion)),
    );
  }

  async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
    this.calls.push(`setIssueProperty ${key} ${propertyKey}`);
    this.properties.set(`${key}/${propertyKey}`, value);
  }

  async upsertRemoteLink(key: string, link: RemoteLink): Promise<void> {
    this.calls.push(`upsertRemoteLink ${key} ${link.globalId}`);
    const list = (this.remoteLinks.get(key) ?? []).filter((l) => l.globalId !== link.globalId);
    list.push(link);
    this.remoteLinks.set(key, list);
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const project = (fields.project as { key?: string } | undefined)?.key ?? "DOC";
    const key = `${project}-${1000 + this.created.length}`;
    this.created.push(fields);
    this.issues.set(key, { id: String(20000 + this.created.length), key, fields: { summary: String(fields.summary ?? "") } });
    this.calls.push(`createIssue ${key}`);
    return { id: String(20000 + this.created.length), key };
  }

  async setAppFieldValue(fieldKey: string, issueIds: readonly string[], value: string): Promise<void> {
    this.calls.push(`setAppFieldValue ${fieldKey} ${issueIds.join(",")}`);
    for (const id of issueIds) this.fieldValues.set(`${fieldKey}/${id}`, value);
  }
}

// ---------------------------------------------------------------------------- mapping & sync

export interface DocsRequiredPolicy {
  field?: string | undefined;
  label?: string | undefined;
  issueTypes?: readonly string[] | undefined;
}

/** "Docs required": explicit field wins, then label, then issue-type policy. */
export function resolveDocsRequired(issue: JiraIssue, policy: DocsRequiredPolicy): DocsRequired {
  if (policy.field) {
    const raw = issue.fields[policy.field] as { value?: string } | string | null | undefined;
    const value = typeof raw === "string" ? raw : raw?.value;
    if (value) return /^(yes|true|required)$/i.test(value) ? "yes" : /^(no|false|n\/?a|not applicable)$/i.test(value) ? "no" : "unknown";
  }
  if (policy.label && (issue.fields.labels ?? []).includes(policy.label)) return "yes";
  if (policy.issueTypes && policy.issueTypes.length > 0) {
    return policy.issueTypes.includes(issue.fields.issuetype?.name ?? "") ? "yes" : "no";
  }
  return "unknown";
}

export interface TicketMirror {
  tracker: "jira" | "jira_dc";
  site: string;
  externalId: string;
  key: string;
  projectKey: string;
  title: string;
  issueType: string | null;
  status: string | null;
  statusCategory: "todo" | "in_progress" | "done" | null;
  docsRequired: DocsRequired;
  fixVersions: string[];
  parentKey: string | null;
  assignee: string | null;
  url: string;
  sourceUpdatedAt: string;
}

export function ticketFromIssue(issue: JiraIssue, site: string, policy: DocsRequiredPolicy, tracker: "jira" | "jira_dc" = "jira"): TicketMirror {
  const category = issue.fields.status?.statusCategory?.key;
  return {
    tracker,
    site,
    externalId: issue.id,
    key: issue.key,
    projectKey: issue.key.split("-")[0] ?? "",
    title: issue.fields.summary ?? issue.key,
    issueType: issue.fields.issuetype?.name ?? null,
    status: issue.fields.status?.name ?? null,
    statusCategory: category === "new" ? "todo" : category === "indeterminate" ? "in_progress" : category === "done" ? "done" : null,
    docsRequired: resolveDocsRequired(issue, policy),
    fixVersions: (issue.fields.fixVersions ?? []).map((v) => v.name),
    parentKey: issue.fields.parent?.key ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    url: `https://${site}/browse/${issue.key}`,
    sourceUpdatedAt: issue.fields.updated ?? new Date().toISOString(),
  };
}

export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function fixVersionJql(project: string, fixVersion: string): string {
  if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw new Error(`invalid project key ${project}`);
  return `project = ${project} AND fixVersion = ${jqlString(fixVersion)} ORDER BY key ASC`;
}

export const DOCS_PROPERTY_KEY = "docops.docs";

export interface DocsStatusSnapshot {
  required: DocsRequired;
  status: DocsStatus;
  reasons: string[];
  pages: Array<{ path: string; title: string; url: string | null; stale: boolean; pageId: string }>;
  pullRequests: Array<{ repo: string; number: number; state: string; url: string; title?: string | undefined }>;
}

export const STATUS_LABEL: Record<DocsStatus, string> = {
  not_required: "Not required",
  missing: "Missing",
  in_review: "In review",
  merged: "Merged",
  published: "Published",
  stale: "Stale",
};

/**
 * Write the docs status into Jira so Jira stays a system of record: issue property
 * (read by the workflow validator), remote links (upserted by globalId), and the app field.
 */
export async function pushDocsStatus(
  client: JiraClient,
  issue: { key: string; id: string },
  snapshot: DocsStatusSnapshot,
  options: { tenantId: string; source: string; statusFieldKey?: string | undefined; now?: Date | undefined },
): Promise<void> {
  await client.setIssueProperty(issue.key, DOCS_PROPERTY_KEY, {
    v: 1,
    required: snapshot.required,
    status: snapshot.status,
    reasons: snapshot.reasons.slice(0, 20),
    pages: snapshot.pages.slice(0, 50).map(({ path, url, stale }) => ({ path, url, stale })),
    pullRequests: snapshot.pullRequests.slice(0, 50).map(({ repo, number, state }) => ({ repo, number, state })),
    updatedAt: (options.now ?? new Date()).toISOString(),
    source: options.source,
  });
  for (const page of snapshot.pages) {
    if (!page.url) continue;
    await client.upsertRemoteLink(issue.key, {
      globalId: `docops:page:${options.tenantId}:${page.pageId}`,
      url: page.url,
      title: `📄 ${page.title} (docs)`,
      summary: page.stale ? "Stale: references changed entities" : page.path,
      resolved: !page.stale,
    });
  }
  for (const pr of snapshot.pullRequests) {
    await client.upsertRemoteLink(issue.key, {
      globalId: `docops:pr:github:${pr.repo}#${pr.number}`,
      url: pr.url,
      title: `PR #${pr.number}${pr.title ? ` · ${pr.title}` : ""}`,
      summary: `Docs change ${pr.state}`,
      resolved: pr.state === "merged",
    });
  }
  if (options.statusFieldKey && client.setAppFieldValue) {
    await client.setAppFieldValue(options.statusFieldKey, [issue.id], STATUS_LABEL[snapshot.status]);
  }
}

/** Fields for a "Doc task" sub-task (Atlassian Document Format description). */
export function docTaskFields(parent: { key: string; summary: string }, project: string, issueType = "Sub-task"): Record<string, unknown> {
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  return {
    project: { key: project },
    parent: { key: parent.key },
    issuetype: { name: issueType },
    summary: `Docs: ${parent.summary}`.slice(0, 250),
    labels: ["docops", "docs-task"],
    description: {
      type: "doc",
      version: 1,
      content: [
        paragraph(`${parent.key} requires documentation, but no merged doc change is linked yet.`),
        paragraph("Link a doc PR (mention the parent key in the PR title or branch) or add the key to the page frontmatter `tickets:`."),
      ],
    },
  };
}

/** Jira admin/DC webhooks: `X-Hub-Signature: sha256=<hex>` over the raw body. */
export function verifyJiraSignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const [method, signature] = header.split("=", 2);
  if (method !== "sha256" || !signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"), "utf8");
  const given = Buffer.from(signature, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
