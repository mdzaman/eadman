/**
 * DocOps for Jira: pure view-model layer.
 *
 * Maps DocOps API payloads (api/openapi.yaml: TicketDocs, Readiness, DocTasksResult, ...) to the
 * shapes the UI Kit screens render. Nothing in here knows about Forge or React, so it is
 * unit-tested by the repo's test runner (apps/jira-forge/test/view-model.test.ts) and
 * type-checked by the root tsconfig.
 *
 * Rules for this file:
 *   - no imports at all (it runs under `node --experimental-strip-types`, in the root typecheck
 *     and inside the Forge bundle, which resolves imports differently);
 *   - erasable TypeScript only (no enums, namespaces or parameter properties);
 *   - never mutate the input payloads;
 *   - status is always conveyed as text, never by color alone (see `statusLozenge`).
 */

// ---------------------------------------------------------------------------------------------
// API types. They mirror the schemas in api/openapi.yaml and only list what the app uses.
// Clients must ignore unknown fields and tolerate new enum values (docs/04-api-design.md §1).
// ---------------------------------------------------------------------------------------------

/** Schema `DocsStatus`. */
export type DocsStatus = "not_required" | "missing" | "in_review" | "merged" | "published" | "stale";
/** `docsRequired` on `TicketDocs.ticket` and `ReadinessItem`. */
export type DocsRequired = "yes" | "no" | "unknown";
export type PullRequestState = "open" | "closed" | "merged";
export type Tracker = "jira" | "jira_dc" | "linear" | "azure_boards" | "github";

/** Schema `Link`. */
export interface Link {
  id: string;
  ticketKey: string;
  targetType: "page" | "pull_request" | "commit" | "release" | "entity";
  targetId?: string | null;
  targetRef?: string | null;
  source: "frontmatter" | "pr_title" | "pr_body" | "branch_name" | "commit_message" | "tracker_panel" | "api" | "inferred";
  createdBy?: string;
  createdAt: string;
}

/** Schema `LinkCreate` (request body of `createLink`). */
export interface LinkCreate {
  ticketKey: string;
  tracker?: Tracker;
  targetType: "page" | "pull_request" | "release" | "entity";
  targetId?: string;
  spaceKey?: string;
  pagePath?: string;
}

export interface TicketDocsTicket {
  key: string;
  title: string;
  status?: string | null;
  docsRequired?: DocsRequired;
  fixVersions?: string[];
  url: string;
}

export interface TicketDocsPage {
  pageId?: string;
  path?: string;
  title?: string;
  url?: string | null;
  stale?: boolean;
}

export interface TicketDocsPullRequest {
  repository?: string;
  number?: number;
  title?: string;
  state?: PullRequestState;
  touchesDocs?: boolean;
  url?: string;
}

/** Schema `TicketDocs` (response of `getTicketDocs`). */
export interface TicketDocs {
  ticket: TicketDocsTicket;
  docsStatus: DocsStatus;
  reasons: string[];
  links: Link[];
  pages?: TicketDocsPage[];
  pullRequests?: TicketDocsPullRequest[];
}

/** Schema `ReadinessItem`. */
export interface ReadinessItem {
  ticketKey: string;
  title: string;
  issueType?: string | null;
  status?: string | null;
  docsRequired: DocsRequired;
  docsStatus: DocsStatus;
  reasons: string[];
  pages?: string[];
  pullRequests?: number[];
  url?: string;
}

/** `Readiness.summary`. `byStatus` may omit statuses with a zero count. */
export interface ReadinessSummary {
  total: number;
  byStatus: Record<string, number>;
  /** (published + merged + not_required) / total x 100 */
  readyPercent: number;
  /** missing + stale */
  blockers: number;
  inReview: number;
  /** True when there are no blockers and nothing in review. */
  ready: boolean;
}

/** Schema `Readiness` (response of `getReadiness`). */
export interface Readiness {
  tracker?: string;
  project: string;
  fixVersion: string;
  generatedAt: string;
  dataAsOf?: string;
  summary: ReadinessSummary;
  items: ReadinessItem[];
}

/** Schema `DocTasksRequest`. */
export interface DocTasksRequest {
  project: string;
  fixVersion: string;
  ticketKeys?: string[];
  issueType?: string;
}

/** Schema `DocTasksResult` (response of `createDocTasks`). */
export interface DocTasksResult {
  created: Array<{ parentKey?: string; key?: string; url?: string }>;
  skipped: Array<{ parentKey?: string; reason?: string }>;
}

export type PageType =
  | "guide"
  | "how_to"
  | "tutorial"
  | "concept"
  | "reference"
  | "generated_reference"
  | "runbook"
  | "adr"
  | "postmortem"
  | "release_notes"
  | "onboarding"
  | "snippet"
  | "other";

/** Schema `PageSummary` (items of `listPages`). */
export interface PageSummary {
  id: string;
  spaceId: string;
  path: string;
  slug: string;
  title: string;
  pageType: PageType;
  audience?: string[];
}

/** RFC 9457 problem details (schema `Problem`). */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  traceId?: string;
  errors?: Array<{ pointer: string; message: string }>;
}

/** The subset of Jira's `Version` (GET /rest/api/3/project/{key}/versions) used by the fix-version picker. */
export interface JiraVersion {
  id?: string;
  name: string;
  released?: boolean;
  archived?: boolean;
  /** yyyy-mm-dd */
  releaseDate?: string;
}

// ---------------------------------------------------------------------------------------------
// Resolver result envelope. Resolvers never throw to the UI; they return `ApiResult`.
// ---------------------------------------------------------------------------------------------

export interface ApiError {
  /** HTTP status from DocOps (or 0 when DocOps could not be reached). */
  status: number;
  title: string;
  detail?: string;
  code?: string;
  traceId?: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// ---------------------------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------------------------

/** The `appearance` values of the UI Kit `Lozenge` component that this app uses. */
export type LozengeAppearance = "default" | "inprogress" | "moved" | "new" | "removed" | "success";

export interface StatusLozenge {
  text: string;
  appearance: LozengeAppearance;
}

const STATUS_LOZENGES: Record<DocsStatus, StatusLozenge> = {
  missing: { text: "Missing", appearance: "removed" },
  stale: { text: "Stale", appearance: "moved" },
  in_review: { text: "In review", appearance: "inprogress" },
  merged: { text: "Merged", appearance: "success" },
  published: { text: "Published", appearance: "success" },
  not_required: { text: "Not required", appearance: "default" },
};

/**
 * Lozenge for a docs status. The text always carries the meaning, so color is never the only
 * signal. Unknown (future) statuses fall back to a neutral lozenge with a humanized label.
 */
export function statusLozenge(status: DocsStatus): StatusLozenge {
  if (Object.hasOwn(STATUS_LOZENGES, status)) return { ...STATUS_LOZENGES[status] };
  return { text: humanize(String(status)), appearance: "default" };
}

/** Blockers first: the order of readiness tables and the tie-break for sorting (docs/06 §9). */
export const DOCS_STATUS_ORDER: readonly DocsStatus[] = ["stale", "missing", "in_review", "merged", "published", "not_required"];

/** `missing` and `stale` block a release (`blockers = missing + stale`). */
export function isBlockerStatus(status: DocsStatus): boolean {
  return status === "missing" || status === "stale";
}

const STATUS_DESCRIPTIONS: Record<DocsStatus, string> = {
  missing: "Documentation is required but no documentation change is linked.",
  stale: "Linked documentation references code or API entities that changed after it was written.",
  in_review: "A documentation change is open and waiting for review.",
  merged: "Documentation is merged and waiting to be published.",
  published: "Documentation is published.",
  not_required: "Documentation is not required for this issue.",
};

/** Standard sentence for a status; empty for unknown (future) statuses. */
export function describeStatus(status: DocsStatus): string {
  return Object.hasOwn(STATUS_DESCRIPTIONS, status) ? STATUS_DESCRIPTIONS[status] : "";
}

export function docsRequiredLabel(value: DocsRequired | undefined): string {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return "Unknown";
}

function pullRequestLozenge(state: PullRequestState | undefined): StatusLozenge {
  switch (state) {
    case "open":
      return { text: "Open", appearance: "inprogress" };
    case "merged":
      return { text: "Merged", appearance: "success" };
    case "closed":
      return { text: "Closed", appearance: "default" };
    default:
      return { text: "Unknown", appearance: "default" };
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

/**
 * "82%" for 81.8. Whole percents only; never reports 100% unless the value is exactly 100 (a
 * release with one blocker in 300 tickets must not read "Ready 100%"). Non-numbers give "n/a".
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const clamped = Math.min(100, Math.max(0, value));
  let rounded = Math.round(clamped);
  if (clamped < 100 && rounded === 100) rounded = 99;
  return `${rounded}%`;
}

/** "14:05:12 UTC" for an ISO timestamp; undefined when the input or the time zone is invalid. */
export function formatDataAsOf(iso: string | undefined, timeZone = "UTC"): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return undefined;
  }
}

/**
 * Natural ticket-key order: project key first, then the numeric part (PAY-9 before PAY-10).
 * Locale independent so tests and the Forge runtime agree.
 */
export function compareTicketKeys(a: string, b: string): number {
  const pa = /^(.*)-(\d+)$/.exec(a);
  const pb = /^(.*)-(\d+)$/.exec(b);
  if (pa && pb) {
    const projectA = pa[1] ?? "";
    const projectB = pb[1] ?? "";
    if (projectA !== projectB) return projectA < projectB ? -1 : 1;
    const numberA = Number(pa[2]);
    const numberB = Number(pb[2]);
    if (numberA !== numberB) return numberA < numberB ? -1 : 1;
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function humanize(value: string): string {
  const text = value.replace(/[_-]+/g, " ").trim();
  return text === "" ? "Unknown" : text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text !== "" && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Issue panel and glance (GET /v1/tickets/{key}/docs)
// ---------------------------------------------------------------------------------------------

export interface PanelPage {
  key: string;
  title: string;
  path: string | undefined;
  /** Only published pages have a URL. */
  url: string | undefined;
  stale: boolean;
  /** "Stale" lozenge for stale pages, so staleness is text and not only color. */
  staleLozenge: StatusLozenge | null;
}

export interface PanelPullRequest {
  key: string;
  /** "acme/payments#482" */
  label: string;
  title: string;
  url: string | undefined;
  state: PullRequestState | undefined;
  lozenge: StatusLozenge;
  touchesDocs: boolean;
}

export type PanelAction =
  /** Opens the "Link documentation" form. */
  | { kind: "link_docs"; label: string }
  /** Navigates to an existing page or pull request. */
  | { kind: "open_url"; label: string; href: string };

export interface PanelViewModel {
  ticketKey: string;
  ticketTitle: string;
  ticketUrl: string;
  status: DocsStatus;
  lozenge: StatusLozenge;
  docsRequiredLabel: string;
  /** First reason from DocOps, or a standard sentence for the status. */
  description: string;
  reasons: string[];
  pages: PanelPage[];
  pullRequests: PanelPullRequest[];
  /** "2 pages (1 stale), 1 pull request", or "No linked pages or pull requests" (the glance shows this). */
  linkedSummary: string;
  primaryAction: PanelAction | null;
}

export function toPanelViewModel(docs: TicketDocs): PanelViewModel {
  const reasons = uniqueStrings(docs.reasons);
  const pages = toPanelPages(docs.pages);
  const pullRequests = toPanelPullRequests(docs.pullRequests);
  const status = docs.docsStatus;
  return {
    ticketKey: docs.ticket.key,
    ticketTitle: docs.ticket.title,
    ticketUrl: docs.ticket.url,
    status,
    lozenge: statusLozenge(status),
    docsRequiredLabel: docsRequiredLabel(docs.ticket.docsRequired),
    description: reasons[0] ?? describeStatus(status),
    reasons,
    pages,
    pullRequests,
    linkedSummary: linkedSummary(pages, pullRequests),
    primaryAction: primaryActionFor(status, pages, pullRequests),
  };
}

function linkedSummary(pages: readonly PanelPage[], pullRequests: readonly PanelPullRequest[]): string {
  if (pages.length === 0 && pullRequests.length === 0) return "No linked pages or pull requests";
  const parts: string[] = [];
  if (pages.length > 0) {
    const stale = pages.filter((page) => page.stale).length;
    parts.push(`${plural(pages.length, "page")}${stale > 0 ? ` (${stale} stale)` : ""}`);
  }
  if (pullRequests.length > 0) parts.push(plural(pullRequests.length, "pull request"));
  return parts.join(", ");
}

function toPanelPages(pages: TicketDocsPage[] | undefined): PanelPage[] {
  const views = (pages ?? []).map((page, index): PanelPage => {
    const path = page.path?.trim() || undefined;
    const stale = page.stale === true;
    return {
      key: page.pageId ?? path ?? `page-${index}`,
      title: page.title?.trim() || path || "Untitled page",
      path,
      url: page.url || undefined,
      stale,
      staleLozenge: stale ? statusLozenge("stale") : null,
    };
  });
  // Stale pages are the action items, so they come first.
  return views.sort((a, b) => Number(b.stale) - Number(a.stale) || compareText(a.title, b.title));
}

const PULL_REQUEST_STATE_RANK: Record<string, number> = { open: 0, merged: 1, closed: 2 };

function toPanelPullRequests(pullRequests: TicketDocsPullRequest[] | undefined): PanelPullRequest[] {
  const views = (pullRequests ?? []).map((pr, index): PanelPullRequest => {
    const repository = pr.repository?.trim() ?? "";
    const label = repository !== "" && pr.number !== undefined ? `${repository}#${pr.number}` : repository || (pr.number !== undefined ? `#${pr.number}` : "Pull request");
    return {
      key: `${label}-${index}`,
      label,
      title: pr.title?.trim() ?? "",
      url: pr.url || undefined,
      state: pr.state,
      lozenge: pullRequestLozenge(pr.state),
      touchesDocs: pr.touchesDocs === true,
    };
  });
  const rank = (pr: PanelPullRequest): number => (pr.state !== undefined ? (PULL_REQUEST_STATE_RANK[pr.state] ?? 3) : 3);
  return views.sort((a, b) => rank(a) - rank(b) || compareText(a.label, b.label));
}

function primaryActionFor(status: DocsStatus, pages: readonly PanelPage[], pullRequests: readonly PanelPullRequest[]): PanelAction | null {
  const linkDocs: PanelAction = { kind: "link_docs", label: "Link documentation" };
  switch (status) {
    case "missing":
      return linkDocs;
    case "stale": {
      const stalePages = pages.filter((page) => page.stale);
      const target = stalePages.find((page) => page.url !== undefined);
      if (target?.url === undefined) return linkDocs;
      return { kind: "open_url", label: stalePages.length > 1 ? "Review first stale page" : "Review stale page", href: target.url };
    }
    case "in_review": {
      const open = pullRequests.filter((pr) => pr.state === "open" && pr.url !== undefined);
      const target = open.find((pr) => pr.touchesDocs) ?? open[0];
      return target?.url === undefined ? null : { kind: "open_url", label: "View documentation pull request", href: target.url };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Release readiness page (GET /v1/readiness)
// ---------------------------------------------------------------------------------------------

export interface ReadinessRow {
  /** Ticket key, e.g. PAY-123. */
  key: string;
  url: string | undefined;
  title: string;
  issueType: string | undefined;
  ticketStatus: string | undefined;
  docsRequiredLabel: string;
  status: DocsStatus;
  lozenge: StatusLozenge;
  isBlocker: boolean;
  reasons: string[];
  pages: string[];
  pullRequests: number[];
  /** "guides/refunds.md, #482", or "None". */
  references: string;
}

export interface ReadinessViewModel {
  project: string;
  fixVersion: string;
  /** "Docs readiness · PAY · Fix version 2.4.0" */
  title: string;
  /** Overall state as text + appearance: Ready / In review / Not ready. */
  overall: StatusLozenge;
  isReady: boolean;
  /** No tickets in the fix version: show an empty state, not "Ready". */
  isEmpty: boolean;
  readyPercent: number;
  readyPercentText: string;
  /** "Ready 82% · Blockers 3 (Missing 2, Stale 1) · In review 4" */
  summaryText: string;
  blockers: number;
  inReview: number;
  total: number;
  /** Rows sorted blockers first (stale, missing, in_review, merged, published, not_required), then by key. */
  rows: ReadinessRow[];
  /** Keys for the bulk "Create doc tasks" action: tickets whose docs are missing, in key order. */
  missingKeys: string[];
  /** "Create doc tasks for Missing (2)" */
  createTasksLabel: string;
  /** "Data as of 14:05:12 UTC" */
  asOfText: string | undefined;
}

export interface ReadinessOptions {
  /** IANA time zone for `asOfText`, e.g. the viewer's zone from the Forge context. Defaults to UTC. */
  timeZone?: string;
}

export function toReadinessViewModel(readiness: Readiness, options: ReadinessOptions = {}): ReadinessViewModel {
  const { summary } = readiness;
  const rows = readiness.items.map(toReadinessRow).sort(compareReadinessRows);
  const missingKeys = rows.filter((row) => row.status === "missing").map((row) => row.key);
  const asOf = formatDataAsOf(readiness.dataAsOf ?? readiness.generatedAt, options.timeZone);
  return {
    project: readiness.project,
    fixVersion: readiness.fixVersion,
    title: `Docs readiness · ${readiness.project} · Fix version ${readiness.fixVersion}`,
    overall: overallLozenge(summary),
    isReady: summary.ready,
    isEmpty: readiness.items.length === 0,
    readyPercent: summary.readyPercent,
    readyPercentText: formatPercent(summary.readyPercent),
    summaryText: summaryText(summary),
    blockers: summary.blockers,
    inReview: summary.inReview,
    total: summary.total,
    rows,
    missingKeys,
    createTasksLabel: `Create doc tasks for Missing (${missingKeys.length})`,
    asOfText: asOf === undefined ? undefined : `Data as of ${asOf}`,
  };
}

/**
 * Readiness summary of a list of items, with the same arithmetic as `summarizeReadiness` in
 * @docops/engine (docs/06 §6): readyPercent = (published + merged + not_required) / total, to one
 * decimal; blockers = missing + stale; ready = no blockers and nothing in review. Used only when rows
 * had to be hidden from the viewer, because the totals DocOps computed would otherwise still count them.
 */
export function summarizeItems(items: readonly ReadinessItem[]): ReadinessSummary {
  const counts = new Map<string, number>(DOCS_STATUS_ORDER.map((status): [string, number] => [status, 0]));
  for (const item of items) counts.set(item.docsStatus, (counts.get(item.docsStatus) ?? 0) + 1);
  const count = (status: DocsStatus): number => counts.get(status) ?? 0;
  const readyCount = count("published") + count("merged") + count("not_required");
  const blockers = count("missing") + count("stale");
  const inReview = count("in_review");
  return {
    total: items.length,
    byStatus: Object.fromEntries(counts),
    readyPercent: items.length === 0 ? 100 : Math.round((readyCount / items.length) * 1000) / 10,
    blockers,
    inReview,
    ready: blockers === 0 && inReview === 0,
  };
}

/**
 * The readiness the viewer is allowed to see: only rows whose ticket key is in `visibleKeys`. If any
 * row is dropped the summary is recomputed from the rows that remain, so hidden issues leave no trace
 * in the totals. Nothing dropped returns the input untouched, with DocOps's own summary.
 */
export function restrictReadiness(readiness: Readiness, visibleKeys: ReadonlySet<string>): Readiness {
  const items = readiness.items.filter((item) => visibleKeys.has(item.ticketKey));
  if (items.length === readiness.items.length) return readiness;
  return { ...readiness, items, summary: summarizeItems(items) };
}

/** "Ready 82% · Blockers 3 (Missing 2, Stale 1) · In review 4" */
export function summaryText(summary: ReadinessSummary): string {
  const missing = summary.byStatus["missing"] ?? 0;
  const stale = summary.byStatus["stale"] ?? 0;
  const parts: string[] = [];
  if (missing > 0) parts.push(`Missing ${missing}`);
  if (stale > 0) parts.push(`Stale ${stale}`);
  const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `Ready ${formatPercent(summary.readyPercent)} · Blockers ${summary.blockers}${breakdown} · In review ${summary.inReview}`;
}

function overallLozenge(summary: ReadinessSummary): StatusLozenge {
  if (summary.ready) return { text: "Ready", appearance: "success" };
  if (summary.blockers === 0 && summary.inReview > 0) return { text: "In review", appearance: "inprogress" };
  return { text: "Not ready", appearance: "removed" };
}

function toReadinessRow(item: ReadinessItem): ReadinessRow {
  const pages = uniqueStrings(item.pages);
  const pullRequests = (item.pullRequests ?? []).filter((n) => Number.isInteger(n));
  const references = [...pages, ...pullRequests.map((n) => `#${n}`)];
  return {
    key: item.ticketKey,
    url: item.url || undefined,
    title: item.title,
    issueType: item.issueType ?? undefined,
    ticketStatus: item.status ?? undefined,
    docsRequiredLabel: docsRequiredLabel(item.docsRequired),
    status: item.docsStatus,
    lozenge: statusLozenge(item.docsStatus),
    isBlocker: isBlockerStatus(item.docsStatus),
    reasons: uniqueStrings(item.reasons),
    pages,
    pullRequests,
    references: references.length > 0 ? references.join(", ") : "None",
  };
}

function statusRank(status: DocsStatus): number {
  const index = DOCS_STATUS_ORDER.indexOf(status);
  return index === -1 ? DOCS_STATUS_ORDER.length : index;
}

function compareReadinessRows(a: ReadinessRow, b: ReadinessRow): number {
  return statusRank(a.status) - statusRank(b.status) || compareTicketKeys(a.key, b.key);
}

// ---------------------------------------------------------------------------------------------
// Bulk "Create doc tasks" result (POST /v1/readiness/doc-tasks)
// ---------------------------------------------------------------------------------------------

export interface DocTasksViewModel {
  /** "Created 2 doc tasks. 1 skipped." */
  headline: string;
  appearance: "success" | "warning" | "information";
  created: Array<{ parentKey: string; key: string; url: string | undefined }>;
  skipped: Array<{ parentKey: string; reason: string }>;
}

export function toDocTasksViewModel(result: DocTasksResult): DocTasksViewModel {
  const created = result.created.map((task) => ({ parentKey: task.parentKey ?? "", key: task.key ?? "", url: task.url || undefined }));
  const skipped = result.skipped.map((entry) => ({ parentKey: entry.parentKey ?? "", reason: entry.reason?.trim() || "Skipped" }));
  let headline: string;
  let appearance: DocTasksViewModel["appearance"];
  if (created.length === 0 && skipped.length === 0) {
    headline = "Nothing to create: no tickets with missing docs.";
    appearance = "information";
  } else if (created.length === 0) {
    headline = `No doc tasks created. ${skipped.length} skipped.`;
    appearance = "information";
  } else if (skipped.length === 0) {
    headline = `Created ${plural(created.length, "doc task")}.`;
    appearance = "success";
  } else {
    headline = `Created ${plural(created.length, "doc task")}. ${skipped.length} skipped.`;
    appearance = "warning";
  }
  return { headline, appearance, created, skipped };
}

// ---------------------------------------------------------------------------------------------
// Fix-version picker (Jira project versions)
// ---------------------------------------------------------------------------------------------

export interface VersionOption {
  label: string;
  value: string;
  released: boolean;
}

/**
 * Options for the fix-version dropdown. Archived versions are dropped. Unreleased versions come
 * first (soonest release date first, undated last), then released versions (most recent first).
 * The label spells out released/unreleased so the state is not only a visual cue.
 */
export function toVersionOptions(versions: readonly JiraVersion[]): VersionOption[] {
  const usable = versions.filter((v) => v.archived !== true && typeof v.name === "string" && v.name.trim() !== "");
  const byName = (a: JiraVersion, b: JiraVersion): number => compareText(a.name, b.name);
  const unreleased = usable
    .filter((v) => v.released !== true)
    .sort((a, b) => {
      if (a.releaseDate && b.releaseDate) return a.releaseDate < b.releaseDate ? -1 : a.releaseDate > b.releaseDate ? 1 : byName(a, b);
      if (a.releaseDate) return -1;
      if (b.releaseDate) return 1;
      return byName(a, b);
    });
  const released = usable
    .filter((v) => v.released === true)
    .sort((a, b) => {
      const dateA = a.releaseDate ?? "";
      const dateB = b.releaseDate ?? "";
      return dateA === dateB ? byName(a, b) : dateA < dateB ? 1 : -1;
    });
  return [
    ...unreleased.map((v) => ({ label: `${v.name} (unreleased${v.releaseDate ? `, due ${v.releaseDate}` : ""})`, value: v.name, released: false })),
    ...released.map((v) => ({ label: `${v.name} (released${v.releaseDate ? ` ${v.releaseDate}` : ""})`, value: v.name, released: true })),
  ];
}

/** The next release: the first unreleased version, else the most recent released one. */
export function defaultVersion(options: readonly VersionOption[]): string | undefined {
  return (options.find((option) => !option.released) ?? options[0])?.value;
}

// ---------------------------------------------------------------------------------------------
// Runtime guards for payloads that cross a trust boundary. A resolver forwards a response only
// when it passes, so the functions above never see a malformed object (for example an HTML error
// page that a proxy returned with status 200). Required fields from api/openapi.yaml are
// checked; unknown extra fields are ignored, as the API's versioning rules require.
// ---------------------------------------------------------------------------------------------

type Check = (value: unknown) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText: Check = (v) => typeof v === "string";
const isNumber: Check = (v) => typeof v === "number" && Number.isFinite(v);
const isFlag: Check = (v) => typeof v === "boolean";
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || v === null || check(v);
const arrayOf =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    isRecord(v) && Object.entries(fields).every(([key, check]) => check(v[key]));

const isTicketDocsShape = shape({
  ticket: shape({ key: isText, title: isText, url: isText, status: optional(isText), docsRequired: optional(isText) }),
  docsStatus: isText,
  reasons: arrayOf(isText),
  links: arrayOf(isRecord),
  pages: optional(arrayOf(shape({ pageId: optional(isText), path: optional(isText), title: optional(isText), url: optional(isText), stale: optional(isFlag) }))),
  pullRequests: optional(
    arrayOf(shape({ repository: optional(isText), number: optional(isNumber), title: optional(isText), state: optional(isText), touchesDocs: optional(isFlag), url: optional(isText) })),
  ),
});

const isReadinessShape = shape({
  project: isText,
  fixVersion: isText,
  generatedAt: isText,
  dataAsOf: optional(isText),
  summary: shape({
    total: isNumber,
    byStatus: (v) => isRecord(v) && Object.values(v).every(isNumber),
    readyPercent: isNumber,
    blockers: isNumber,
    inReview: isNumber,
    ready: isFlag,
  }),
  items: arrayOf(
    shape({
      ticketKey: isText,
      title: isText,
      docsRequired: isText,
      docsStatus: isText,
      reasons: arrayOf(isText),
      issueType: optional(isText),
      status: optional(isText),
      pages: optional(arrayOf(isText)),
      pullRequests: optional(arrayOf(isNumber)),
      url: optional(isText),
    }),
  ),
});

const isDocTasksResultShape = shape({
  created: arrayOf(shape({ parentKey: optional(isText), key: optional(isText), url: optional(isText) })),
  skipped: arrayOf(shape({ parentKey: optional(isText), reason: optional(isText) })),
});

const isPageListShape = shape({
  items: arrayOf(shape({ id: isText, spaceId: isText, path: isText, title: isText, pageType: optional(isText) })),
});

const isLinkShape = shape({ id: isText, ticketKey: isText, targetType: isText });

const isJiraVersionListShape = arrayOf(
  shape({ id: optional(isText), name: isText, released: optional(isFlag), archived: optional(isFlag), releaseDate: optional(isText) }),
);

export function isTicketDocs(value: unknown): value is TicketDocs {
  return isTicketDocsShape(value);
}

export function isReadiness(value: unknown): value is Readiness {
  return isReadinessShape(value);
}

export function isDocTasksResult(value: unknown): value is DocTasksResult {
  return isDocTasksResultShape(value);
}

/** Response of `listPages`: `{ items: PageSummary[], nextCursor }`. */
export function isPageList(value: unknown): value is { items: PageSummary[]; nextCursor?: string | null } {
  return isPageListShape(value);
}

export function isLink(value: unknown): value is Link {
  return isLinkShape(value);
}

export function isJiraVersionList(value: unknown): value is JiraVersion[] {
  return isJiraVersionListShape(value);
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Builds an `ApiError` from a failed DocOps response: an RFC 9457 problem body when there is one,
 * the HTTP status text otherwise. Field-level validation messages are appended to `detail`.
 */
export function toApiError(status: number, statusText: string | undefined, body: unknown): ApiError {
  const problem: Problem = isRecord(body) ? (body as Problem) : {};
  const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  const error: ApiError = { status, title: clip(text(problem.title) ?? text(statusText) ?? `HTTP ${status}`, 200) };
  const fieldMessages = Array.isArray(problem.errors)
    ? problem.errors
        .filter((entry) => isRecord(entry))
        .slice(0, 3)
        .map((entry) => [text(entry.pointer), text(entry.message)].filter(Boolean).join(": "))
        .filter((message) => message !== "")
    : [];
  const detail = [text(problem.detail), ...fieldMessages].filter(Boolean).join(" ");
  if (detail !== "") error.detail = clip(detail, 500);
  const code = text(problem.code);
  if (code !== undefined) error.code = clip(code, 100);
  const traceId = text(problem.traceId);
  if (traceId !== undefined) error.traceId = clip(traceId, 100);
  return error;
}

export interface ErrorViewModel {
  title: string;
  message: string;
  appearance: "error" | "warning" | "information";
  retryable: boolean;
  /** Trace id to quote to support, when DocOps sent one. */
  reference: string | undefined;
}

/** Turns an API error into text a Jira user can act on. */
export function toErrorViewModel(error: ApiError): ErrorViewModel {
  const detail = error.detail?.trim();
  const reference = error.traceId?.trim() || undefined;
  const status = error.status;
  if (error.code?.startsWith("forge_")) {
    // Raised by the Jira app itself (a disabled project, a missing permission, a missing setting):
    // the title and detail are already written for the user.
    return {
      title: error.title,
      message: detail ?? "",
      appearance: error.code === "forge_project_disabled" ? "information" : status === 400 || status >= 500 ? "error" : "warning",
      retryable: status >= 500,
      reference,
    };
  }
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return {
      title: "DocOps is unreachable",
      message: detail ?? "DocOps did not respond. Try again in a moment; if this keeps happening, contact your DocOps administrator.",
      appearance: "error",
      retryable: true,
      reference,
    };
  }
  if (status === 401) {
    return {
      title: "This Jira site is not connected to DocOps",
      message: "A Jira administrator must register this app installation in DocOps. Open Jira settings > Apps > Manage apps and choose Configure on DocOps for the installation ID.",
      appearance: "warning",
      retryable: false,
      reference,
    };
  }
  if (status === 403) {
    return {
      title: "You do not have access to this in DocOps",
      message: detail ?? "Ask a DocOps administrator to grant access.",
      appearance: "warning",
      retryable: false,
      reference,
    };
  }
  if (status === 404) {
    return {
      title: error.title.trim() || "Not found in DocOps",
      message: detail ?? "DocOps has no record of this yet. Data appears after the first sync.",
      appearance: "information",
      retryable: false,
      reference,
    };
  }
  if (status === 429) {
    return { title: "DocOps is busy", message: "Too many requests. Try again in a few seconds.", appearance: "warning", retryable: true, reference };
  }
  return {
    title: error.title.trim() || "Something went wrong",
    message: detail ?? "DocOps could not complete the request.",
    appearance: "error",
    retryable: status >= 500,
    reference,
  };
}
