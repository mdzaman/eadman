import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeReadiness } from "@docops/engine";
import {
  DOCS_STATUS_ORDER,
  compareTicketKeys,
  defaultVersion,
  describeStatus,
  docsRequiredLabel,
  formatDataAsOf,
  formatPercent,
  isBlockerStatus,
  isDocTasksResult,
  isJiraVersionList,
  isLink,
  isPageList,
  isReadiness,
  isTicketDocs,
  restrictReadiness,
  statusLozenge,
  summarizeItems,
  summaryText,
  toApiError,
  toDocTasksViewModel,
  toErrorViewModel,
  toPanelViewModel,
  toReadinessViewModel,
  toVersionOptions,
} from "../src/view-model.ts";
import type { DocsStatus, Readiness, ReadinessItem, ReadinessSummary, TicketDocs } from "../src/view-model.ts";

// ---- fixtures -------------------------------------------------------------------------------

/** Frozen inputs prove the view-model never mutates API payloads (writes throw in strict mode). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

function item(ticketKey: string, docsStatus: DocsStatus, extra: Partial<ReadinessItem> = {}): ReadinessItem {
  return {
    ticketKey,
    title: `Title of ${ticketKey}`,
    docsRequired: docsStatus === "not_required" ? "no" : "yes",
    docsStatus,
    reasons: [],
    url: `https://acme.atlassian.net/browse/${ticketKey}`,
    ...extra,
  };
}

/** Same arithmetic as the API (docs/06 §6): readyPercent = (published + merged + not_required) / total. */
function summarize(items: readonly ReadinessItem[]): ReadinessSummary {
  const byStatus: Record<string, number> = { not_required: 0, missing: 0, in_review: 0, merged: 0, published: 0, stale: 0 };
  for (const entry of items) byStatus[entry.docsStatus] = (byStatus[entry.docsStatus] ?? 0) + 1;
  const ready = (byStatus["published"] ?? 0) + (byStatus["merged"] ?? 0) + (byStatus["not_required"] ?? 0);
  const blockers = (byStatus["missing"] ?? 0) + (byStatus["stale"] ?? 0);
  const inReview = byStatus["in_review"] ?? 0;
  return {
    total: items.length,
    byStatus,
    readyPercent: items.length === 0 ? 100 : Math.round((ready / items.length) * 1000) / 10,
    blockers,
    inReview,
    ready: blockers === 0 && inReview === 0,
  };
}

function readiness(items: ReadinessItem[], overrides: Partial<Readiness> = {}): Readiness {
  return {
    tracker: "jira",
    project: "PAY",
    fixVersion: "2.4.0",
    generatedAt: "2026-10-18T14:05:12Z",
    summary: summarize(items),
    items,
    ...overrides,
  };
}

/** The four rows of the readiness mock-up in docs/06 §9. */
function mockupItems(): ReadinessItem[] {
  return [
    item("PAY-123", "in_review", { title: "Partial refunds", pages: ["guides/refunds.md"], pullRequests: [482] }),
    item("PAY-131", "stale", { title: "Rename amount → amount_cents", pages: ["payments.md"] }),
    item("PAY-140", "missing", { title: "Webhook retries" }),
    item("PAY-152", "not_required", { title: "Internal metrics" }),
  ];
}

function ticketDocs(docsStatus: DocsStatus, extra: Partial<TicketDocs> = {}): TicketDocs {
  return {
    ticket: { key: "PAY-123", title: "Partial refunds", url: "https://acme.atlassian.net/browse/PAY-123", docsRequired: "yes" },
    docsStatus,
    reasons: [],
    links: [],
    ...extra,
  };
}

// ---- statusLozenge and small helpers -------------------------------------------------------

test("statusLozenge maps every docs status to text and a UI Kit appearance", () => {
  const expected: Array<[DocsStatus, string, string]> = [
    ["missing", "Missing", "removed"],
    ["stale", "Stale", "moved"],
    ["in_review", "In review", "inprogress"],
    ["merged", "Merged", "success"],
    ["published", "Published", "success"],
    ["not_required", "Not required", "default"],
  ];
  for (const [status, text, appearance] of expected) {
    assert.deepEqual(statusLozenge(status), { text, appearance }, status);
  }
});

test("statusLozenge returns a copy and survives unknown statuses", () => {
  const lozenge = statusLozenge("missing");
  lozenge.text = "changed";
  assert.equal(statusLozenge("missing").text, "Missing");
  // The API may add enum values additively; "constructor" also proves prototype keys are not looked up.
  assert.deepEqual(statusLozenge("needs_legal_review" as DocsStatus), { text: "Needs legal review", appearance: "default" });
  assert.deepEqual(statusLozenge("constructor" as DocsStatus), { text: "Constructor", appearance: "default" });
});

test("status order puts blockers first and matches the lozenge table", () => {
  assert.deepEqual([...DOCS_STATUS_ORDER], ["stale", "missing", "in_review", "merged", "published", "not_required"]);
  assert.deepEqual(DOCS_STATUS_ORDER.filter(isBlockerStatus), ["stale", "missing"]);
  for (const status of DOCS_STATUS_ORDER) assert.notEqual(describeStatus(status), "", status);
  assert.equal(describeStatus("constructor" as DocsStatus), "");
});

test("docsRequiredLabel", () => {
  assert.equal(docsRequiredLabel("yes"), "Yes");
  assert.equal(docsRequiredLabel("no"), "No");
  assert.equal(docsRequiredLabel("unknown"), "Unknown");
  assert.equal(docsRequiredLabel(undefined), "Unknown");
});

test("formatPercent rounds to whole percents and never overstates completion", () => {
  assert.equal(formatPercent(82), "82%");
  assert.equal(formatPercent(81.8), "82%");
  assert.equal(formatPercent(82.4), "82%");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(100), "100%");
  assert.equal(formatPercent(99.6), "99%", "99.6 must not read as 100%");
  assert.equal(formatPercent(99.999), "99%");
  assert.equal(formatPercent(150), "100%");
  assert.equal(formatPercent(-5), "0%");
  assert.equal(formatPercent(Number.NaN), "n/a");
  assert.equal(formatPercent(Number.POSITIVE_INFINITY), "n/a");
});

test("compareTicketKeys sorts by project, then numerically", () => {
  const keys = ["PAY-100", "PAY-9", "AAA-5", "PAY-10", "ZED-1", "PAY-9"];
  assert.deepEqual([...keys].sort(compareTicketKeys), ["AAA-5", "PAY-9", "PAY-9", "PAY-10", "PAY-100", "ZED-1"]);
  assert.equal(compareTicketKeys("PAY-1", "PAY-1"), 0);
  // Keys that do not look like ticket keys fall back to plain ordering instead of throwing.
  assert.ok(compareTicketKeys("abc", "abd") < 0);
});

test("formatDataAsOf", () => {
  assert.equal(formatDataAsOf("2026-10-18T14:05:12Z"), "14:05:12 UTC");
  const berlin = formatDataAsOf("2026-10-18T14:05:12Z", "Europe/Berlin");
  assert.ok(berlin?.startsWith("16:05:12"), berlin);
  assert.equal(formatDataAsOf(undefined), undefined);
  assert.equal(formatDataAsOf("not a date"), undefined);
  assert.equal(formatDataAsOf("2026-10-18T14:05:12Z", "Mars/Olympus_Mons"), undefined);
});

// ---- readiness ------------------------------------------------------------------------------

test("readiness summary text matches the design (docs/06 §9)", () => {
  const summary: ReadinessSummary = {
    total: 39,
    byStatus: { missing: 2, stale: 1, in_review: 4, merged: 20, published: 10, not_required: 2 },
    readyPercent: 82.1,
    blockers: 3,
    inReview: 4,
    ready: false,
  };
  assert.equal(summaryText(summary), "Ready 82% · Blockers 3 (Missing 2, Stale 1) · In review 4");
  const vm = toReadinessViewModel(readiness([item("PAY-1", "missing")], { summary }));
  assert.equal(vm.summaryText, "Ready 82% · Blockers 3 (Missing 2, Stale 1) · In review 4");
  assert.equal(vm.readyPercentText, "82%");
  assert.equal(vm.blockers, 3);
  assert.equal(vm.inReview, 4);
});

test("readiness summary text omits empty breakdown parts", () => {
  const onlyMissing = { ...summarize([item("A-1", "missing"), item("A-2", "missing"), item("A-3", "published")]) };
  assert.equal(summaryText(onlyMissing), "Ready 33% · Blockers 2 (Missing 2) · In review 0");
  const onlyStale = summarize([item("A-1", "stale"), item("A-2", "merged")]);
  assert.equal(summaryText(onlyStale), "Ready 50% · Blockers 1 (Stale 1) · In review 0");
  const clean = summarize([item("A-1", "published"), item("A-2", "not_required")]);
  assert.equal(summaryText(clean), "Ready 100% · Blockers 0 · In review 0");
  // byStatus may omit statuses with a zero count.
  assert.equal(
    summaryText({ total: 3, byStatus: { missing: 1 }, readyPercent: 66.7, blockers: 1, inReview: 0, ready: false }),
    "Ready 67% · Blockers 1 (Missing 1) · In review 0",
  );
});

test("readiness rows are sorted blockers first, then by ticket key", () => {
  const items = [
    item("PAY-10", "published"),
    item("PAY-9", "published"),
    item("PAY-152", "not_required"),
    item("PAY-123", "in_review"),
    item("PAY-131", "stale"),
    item("PAY-140", "missing"),
    item("PAY-141", "missing"),
    item("PAY-7", "merged"),
    item("PAY-130", "stale"),
  ];
  const vm = toReadinessViewModel(deepFreeze(readiness(items)));
  assert.deepEqual(
    vm.rows.map((row) => `${row.status}:${row.key}`),
    [
      "stale:PAY-130",
      "stale:PAY-131",
      "missing:PAY-140",
      "missing:PAY-141",
      "in_review:PAY-123",
      "merged:PAY-7",
      "published:PAY-9",
      "published:PAY-10",
      "not_required:PAY-152",
    ],
  );
  assert.deepEqual(vm.rows.map((row) => row.isBlocker), [true, true, true, true, false, false, false, false, false]);
});

test("readiness rows carry text for every status and a combined pages/PRs column", () => {
  const vm = toReadinessViewModel(readiness(mockupItems()));
  assert.deepEqual(
    vm.rows.map((row) => [row.key, row.lozenge.text, row.references]),
    [
      ["PAY-131", "Stale", "payments.md"],
      ["PAY-140", "Missing", "None"],
      ["PAY-123", "In review", "guides/refunds.md, #482"],
      ["PAY-152", "Not required", "None"],
    ],
  );
  const row = vm.rows[0];
  assert.equal(row?.url, "https://acme.atlassian.net/browse/PAY-131");
  assert.equal(row?.docsRequiredLabel, "Yes");
  assert.equal(vm.rows[3]?.docsRequiredLabel, "No");
});

test("missingKeys feed the bulk 'Create doc tasks' action", () => {
  const items = [item("PAY-140", "missing"), item("PAY-12", "missing"), item("PAY-131", "stale"), item("PAY-9", "published"), item("PAY-20", "missing")];
  const vm = toReadinessViewModel(readiness(items));
  assert.deepEqual(vm.missingKeys, ["PAY-12", "PAY-20", "PAY-140"]);
  assert.equal(vm.createTasksLabel, "Create doc tasks for Missing (3)");

  const none = toReadinessViewModel(readiness([item("PAY-1", "published")]));
  assert.deepEqual(none.missingKeys, []);
  assert.equal(none.createTasksLabel, "Create doc tasks for Missing (0)");
});

test("isReady and the overall lozenge follow the API summary", () => {
  const ready = toReadinessViewModel(readiness([item("PAY-1", "published"), item("PAY-2", "not_required")]));
  assert.equal(ready.isReady, true);
  assert.deepEqual(ready.overall, { text: "Ready", appearance: "success" });

  const blocked = toReadinessViewModel(readiness(mockupItems()));
  assert.equal(blocked.isReady, false);
  assert.deepEqual(blocked.overall, { text: "Not ready", appearance: "removed" });

  const reviewOnly = toReadinessViewModel(readiness([item("PAY-1", "in_review"), item("PAY-2", "merged")]));
  assert.equal(reviewOnly.isReady, false, "a release with docs still in review is not ready");
  assert.deepEqual(reviewOnly.overall, { text: "In review", appearance: "inprogress" });
});

test("an empty fix version is flagged so the UI can show an empty state instead of 'Ready'", () => {
  const vm = toReadinessViewModel(readiness([]));
  assert.equal(vm.isEmpty, true);
  assert.deepEqual(vm.rows, []);
  assert.deepEqual(vm.missingKeys, []);
  assert.equal(toReadinessViewModel(readiness([item("PAY-1", "merged")])).isEmpty, false);
});

test("readiness header: title and data-as-of text", () => {
  const vm = toReadinessViewModel(readiness(mockupItems(), { dataAsOf: "2026-10-18T14:05:12Z", generatedAt: "2026-10-18T15:00:00Z" }));
  assert.equal(vm.title, "Docs readiness · PAY · Fix version 2.4.0");
  assert.equal(vm.asOfText, "Data as of 14:05:12 UTC", "dataAsOf wins over generatedAt");
  const fallback = toReadinessViewModel(readiness(mockupItems(), { generatedAt: "2026-10-18T15:00:00Z" }));
  assert.equal(fallback.asOfText, "Data as of 15:00:00 UTC");
  const zoned = toReadinessViewModel(readiness(mockupItems()), { timeZone: "Asia/Dhaka" });
  assert.ok(zoned.asOfText?.startsWith("Data as of 20:05:12"), zoned.asOfText);
  assert.equal(toReadinessViewModel(readiness(mockupItems(), { generatedAt: "garbage" })).asOfText, undefined);
});

test("readiness view-model does not mutate or alias its input", () => {
  const input = deepFreeze(readiness(mockupItems()));
  const vm = toReadinessViewModel(input);
  assert.equal(input.items[0]?.ticketKey, "PAY-123", "input order is untouched");
  assert.notEqual(vm.rows[0]?.pages, input.items[1]?.pages);
});

// ---- issue panel ----------------------------------------------------------------------------

test("a missing status offers 'Link documentation'", () => {
  const vm = toPanelViewModel(deepFreeze(ticketDocs("missing", { reasons: ["Docs are required but no doc change is linked"] })));
  assert.equal(vm.ticketKey, "PAY-123");
  assert.deepEqual(vm.lozenge, { text: "Missing", appearance: "removed" });
  assert.deepEqual(vm.primaryAction, { kind: "link_docs", label: "Link documentation" });
  assert.equal(vm.docsRequiredLabel, "Yes");
  assert.equal(vm.description, "Docs are required but no doc change is linked");
  assert.deepEqual(vm.pages, []);
  assert.deepEqual(vm.pullRequests, []);
});

test("without reasons the panel falls back to the standard sentence for the status", () => {
  assert.equal(toPanelViewModel(ticketDocs("missing")).description, "Documentation is required but no documentation change is linked.");
  assert.equal(toPanelViewModel(ticketDocs("published")).description, "Documentation is published.");
});

test("reasons are trimmed and de-duplicated", () => {
  const vm = toPanelViewModel(ticketDocs("in_review", { reasons: ["  PR acme/payments#482 is open ", "PR acme/payments#482 is open", "", "Second reason"] }));
  assert.deepEqual(vm.reasons, ["PR acme/payments#482 is open", "Second reason"]);
  assert.equal(vm.description, "PR acme/payments#482 is open");
});

test("stale pages are listed first, flagged with a text lozenge, and the action opens one", () => {
  const vm = toPanelViewModel(
    deepFreeze(
      ticketDocs("stale", {
        pages: [
          { pageId: "p1", path: "guides/refunds.md", title: "Refund a payment", url: "https://docs.acme.example/payments/guides/refunds/", stale: false },
          { pageId: "p2", path: "reference/payments.md", title: "Payments API", url: "https://docs.acme.example/payments/reference/payments/", stale: true },
          { pageId: "p3", path: "guides/webhooks.md", title: "Webhooks", url: null, stale: true },
        ],
      }),
    ),
  );
  assert.deepEqual(vm.pages.map((page) => [page.title, page.stale]), [["Payments API", true], ["Webhooks", true], ["Refund a payment", false]]);
  assert.deepEqual(vm.pages[0]?.staleLozenge, { text: "Stale", appearance: "moved" });
  assert.equal(vm.pages[2]?.staleLozenge, null);
  assert.equal(vm.pages[1]?.url, undefined, "unpublished pages have no URL");
  assert.deepEqual(vm.primaryAction, { kind: "open_url", label: "Review first stale page", href: "https://docs.acme.example/payments/reference/payments/" });
});

test("a stale ticket whose stale pages have no URL falls back to linking documentation", () => {
  const vm = toPanelViewModel(ticketDocs("stale", { pages: [{ path: "a.md", stale: true, url: null }] }));
  assert.deepEqual(vm.primaryAction, { kind: "link_docs", label: "Link documentation" });
  const single = toPanelViewModel(ticketDocs("stale", { pages: [{ path: "a.md", stale: true, url: "https://docs.acme.example/a/" }] }));
  assert.deepEqual(single.primaryAction, { kind: "open_url", label: "Review stale page", href: "https://docs.acme.example/a/" });
});

test("an in-review ticket links to the open documentation pull request", () => {
  const vm = toPanelViewModel(
    ticketDocs("in_review", {
      pullRequests: [
        { repository: "acme/payments", number: 480, title: "Refactor client", state: "open", touchesDocs: false, url: "https://github.com/acme/payments/pull/480" },
        { repository: "acme/payments", number: 482, title: "Document partial refunds", state: "open", touchesDocs: true, url: "https://github.com/acme/payments/pull/482" },
        { repository: "acme/payments", number: 470, title: "Old attempt", state: "closed", touchesDocs: true, url: "https://github.com/acme/payments/pull/470" },
        { repository: "acme/payments", number: 475, title: "Prior change", state: "merged", touchesDocs: true, url: "https://github.com/acme/payments/pull/475" },
      ],
    }),
  );
  assert.deepEqual(vm.pullRequests.map((pr) => [pr.label, pr.lozenge.text]), [
    ["acme/payments#480", "Open"],
    ["acme/payments#482", "Open"],
    ["acme/payments#475", "Merged"],
    ["acme/payments#470", "Closed"],
  ]);
  assert.deepEqual(vm.pullRequests.map((pr) => pr.touchesDocs), [false, true, true, true]);
  assert.deepEqual(vm.primaryAction, { kind: "open_url", label: "View documentation pull request", href: "https://github.com/acme/payments/pull/482" });
});

test("no primary action when there is nothing left to do", () => {
  for (const status of ["merged", "published", "not_required"] as const) {
    assert.equal(toPanelViewModel(ticketDocs(status)).primaryAction, null, status);
  }
  // In review but no PR URL to open: no action rather than a dead button.
  assert.equal(toPanelViewModel(ticketDocs("in_review", { pullRequests: [{ repository: "a/b", number: 1, state: "open" }] })).primaryAction, null);
});

test("partial API objects do not break the panel", () => {
  const vm = toPanelViewModel(
    ticketDocs("merged", {
      pages: [{}, { path: "guides/x.md" }, { title: "  " }],
      pullRequests: [{}, { number: 7 }, { repository: "a/b" }],
    }),
  );
  assert.deepEqual(vm.pages.map((page) => page.title).sort(), ["Untitled page", "Untitled page", "guides/x.md"]);
  assert.deepEqual(vm.pullRequests.map((pr) => pr.label).sort(), ["#7", "Pull request", "a/b"]);
  assert.ok(vm.pullRequests.every((pr) => pr.lozenge.text === "Unknown" && !pr.touchesDocs));
  assert.equal(new Set(vm.pages.map((page) => page.key)).size, 3, "page keys are unique for React lists");
});

// ---- doc tasks, versions, errors -----------------------------------------------------------

test("doc task results get a headline and an appearance", () => {
  const created = [{ parentKey: "PAY-140", key: "PAY-201", url: "https://acme.atlassian.net/browse/PAY-201" }, { parentKey: "PAY-12", key: "PAY-202" }];

  const all = toDocTasksViewModel({ created, skipped: [] });
  assert.equal(all.headline, "Created 2 doc tasks.");
  assert.equal(all.appearance, "success");
  assert.deepEqual(all.created[1], { parentKey: "PAY-12", key: "PAY-202", url: undefined });

  const one = toDocTasksViewModel({ created: [created[0] ?? {}], skipped: [] });
  assert.equal(one.headline, "Created 1 doc task.");

  const mixed = toDocTasksViewModel({ created, skipped: [{ parentKey: "PAY-20", reason: "Doc task already exists" }] });
  assert.equal(mixed.headline, "Created 2 doc tasks. 1 skipped.");
  assert.equal(mixed.appearance, "warning");
  assert.deepEqual(mixed.skipped, [{ parentKey: "PAY-20", reason: "Doc task already exists" }]);

  const skippedOnly = toDocTasksViewModel({ created: [], skipped: [{ parentKey: "PAY-20" }, { parentKey: "PAY-21", reason: "  " }] });
  assert.equal(skippedOnly.headline, "No doc tasks created. 2 skipped.");
  assert.equal(skippedOnly.appearance, "information");
  assert.deepEqual(skippedOnly.skipped.map((entry) => entry.reason), ["Skipped", "Skipped"]);

  assert.equal(toDocTasksViewModel({ created: [], skipped: [] }).headline, "Nothing to create: no tickets with missing docs.");
});

test("fix-version options: unreleased first by date, then released newest first; archived dropped", () => {
  const options = toVersionOptions(
    deepFreeze([
      { name: "2.3.0", released: true, releaseDate: "2026-08-01" },
      { name: "2.5.0", released: false },
      { name: "2.4.1", released: false, releaseDate: "2026-11-20" },
      { name: "2.4.0", released: false, releaseDate: "2026-10-30" },
      { name: "2.2.0", released: true, releaseDate: "2026-06-01" },
      { name: "1.0.0", released: true, archived: true, releaseDate: "2025-01-01" },
      { name: "  " },
    ]),
  );
  assert.deepEqual(options.map((option) => option.value), ["2.4.0", "2.4.1", "2.5.0", "2.3.0", "2.2.0"]);
  assert.deepEqual(options.map((option) => option.label), [
    "2.4.0 (unreleased, due 2026-10-30)",
    "2.4.1 (unreleased, due 2026-11-20)",
    "2.5.0 (unreleased)",
    "2.3.0 (released 2026-08-01)",
    "2.2.0 (released 2026-06-01)",
  ]);
  assert.equal(defaultVersion(options), "2.4.0");
  assert.equal(defaultVersion(options.filter((option) => option.released)), "2.3.0");
  assert.equal(defaultVersion([]), undefined);
});

test("errors become actionable text", () => {
  const unreachable = toErrorViewModel({ status: 0, title: "DocOps API unreachable" });
  assert.equal(unreachable.title, "DocOps is unreachable");
  assert.equal(unreachable.retryable, true);
  assert.equal(unreachable.appearance, "error");

  const unauthorized = toErrorViewModel({ status: 401, title: "Unauthorized", traceId: "abc123" });
  assert.equal(unauthorized.title, "This Jira site is not connected to DocOps");
  assert.equal(unauthorized.retryable, false);
  assert.equal(unauthorized.reference, "abc123");

  assert.equal(toErrorViewModel({ status: 403, title: "Forbidden", detail: "Missing readiness:read" }).message, "Missing readiness:read");
  assert.equal(toErrorViewModel({ status: 404, title: "Not Found" }).appearance, "information");
  assert.equal(toErrorViewModel({ status: 429, title: "Too Many Requests" }).retryable, true);

  const validation = toErrorViewModel({ status: 400, title: "Validation failed", detail: "fixVersion is required" });
  assert.deepEqual([validation.title, validation.message, validation.retryable], ["Validation failed", "fixVersion is required", false]);

  const server = toErrorViewModel({ status: 500, title: "", detail: undefined });
  assert.deepEqual([server.title, server.retryable], ["Something went wrong", true]);
});

// ---- runtime guards and error mapping ------------------------------------------------------

test("isTicketDocs accepts API-shaped payloads and ignores unknown fields", () => {
  const valid = ticketDocs("in_review", {
    reasons: ["PR acme/payments#482 is open"],
    pages: [{ pageId: "p1", path: "a.md", title: "A", url: null, stale: false }, {}],
    pullRequests: [{ repository: "acme/payments", number: 482, state: "open", touchesDocs: true, url: "https://github.com/acme/payments/pull/482" }],
  });
  assert.ok(isTicketDocs(valid));
  assert.ok(isTicketDocs({ ...valid, futureField: { anything: true } }));
  assert.ok(isTicketDocs(JSON.parse(JSON.stringify(valid))));
});

test("isTicketDocs rejects anything the panel could not render safely", () => {
  const valid = ticketDocs("missing");
  const bad: unknown[] = [
    null,
    undefined,
    "<html>502 Bad Gateway</html>",
    [],
    {},
    { ...valid, ticket: undefined },
    { ...valid, ticket: { ...valid.ticket, key: 123 } },
    { ...valid, docsStatus: undefined },
    { ...valid, reasons: "none" },
    { ...valid, pages: [{ title: 5 }] },
    { ...valid, pages: "x" },
    { ...valid, pullRequests: [{ number: "482" }] },
    { ...valid, pullRequests: [null] },
  ];
  for (const value of bad) assert.ok(!isTicketDocs(value), JSON.stringify(value));
});

test("isReadiness accepts API-shaped payloads and rejects broken ones", () => {
  const valid = readiness(mockupItems(), { dataAsOf: "2026-10-18T14:05:12Z" });
  assert.ok(isReadiness(valid));
  assert.ok(isReadiness(JSON.parse(JSON.stringify(valid))));
  assert.ok(isReadiness(readiness([])));

  const bad: unknown[] = [
    null,
    "oops",
    { ...valid, summary: undefined },
    { ...valid, summary: { ...valid.summary, readyPercent: "82" } },
    { ...valid, summary: { ...valid.summary, byStatus: { missing: "2" } } },
    { ...valid, summary: { ...valid.summary, ready: "yes" } },
    { ...valid, items: [{ ...item("PAY-1", "missing"), docsStatus: 4 }] },
    { ...valid, items: [{ ...item("PAY-1", "missing"), reasons: undefined }] },
    { ...valid, items: [{ ...item("PAY-1", "missing"), pullRequests: ["482"] }] },
    { ...valid, items: {} },
    { ...valid, fixVersion: undefined },
  ];
  for (const value of bad) assert.ok(!isReadiness(value), JSON.stringify(value));
});

test("guards for doc tasks, page lists, links and Jira versions", () => {
  assert.ok(isDocTasksResult({ created: [{ parentKey: "PAY-1", key: "PAY-9", url: "https://x" }], skipped: [{ parentKey: "PAY-2", reason: "exists" }] }));
  assert.ok(isDocTasksResult({ created: [], skipped: [] }));
  assert.ok(!isDocTasksResult({ created: [] }));
  assert.ok(!isDocTasksResult({ created: [{ key: 5 }], skipped: [] }));

  const page = { id: "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e77", spaceId: "0192d4c1-7a3e-7c11-8a54-3f9b2d1c0e78", path: "guides/refunds.md", slug: "guides/refunds", title: "Refunds", pageType: "guide" };
  assert.ok(isPageList({ items: [page], nextCursor: null }));
  assert.ok(isPageList({ items: [] }));
  assert.ok(!isPageList({ items: [{ ...page, id: undefined }] }));
  assert.ok(!isPageList({ nextCursor: null }));

  assert.ok(isLink({ id: "l1", ticketKey: "PAY-1", targetType: "page", source: "tracker_panel", createdAt: "2026-10-18T14:05:12Z" }));
  assert.ok(!isLink({ ticketKey: "PAY-1" }));

  assert.ok(isJiraVersionList([{ id: "10000", name: "2.4.0", released: false, releaseDate: "2026-10-30" }, { name: "2.3.0", released: true, archived: false }]));
  assert.ok(isJiraVersionList([]));
  assert.ok(!isJiraVersionList([{ name: 240 }]));
  assert.ok(!isJiraVersionList({ values: [] }));
});

test("toApiError reads RFC 9457 problem bodies", () => {
  const error = toApiError(400, "Bad Request", {
    type: "https://docs.docops.example/errors/validation",
    title: "Validation failed",
    status: 400,
    detail: "The request is invalid.",
    code: "validation_failed",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    errors: [{ pointer: "/fixVersion", message: "must not be empty" }, { pointer: "/project", message: "unknown project" }],
  });
  assert.deepEqual(error, {
    status: 400,
    title: "Validation failed",
    detail: "The request is invalid. /fixVersion: must not be empty /project: unknown project",
    code: "validation_failed",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  });
});

test("toApiError falls back to the HTTP status text for non-problem bodies and clips long text", () => {
  assert.deepEqual(toApiError(502, "Bad Gateway", "<html>nginx</html>"), { status: 502, title: "Bad Gateway" });
  assert.deepEqual(toApiError(500, "", undefined), { status: 500, title: "HTTP 500" });
  assert.deepEqual(toApiError(500, undefined, { title: 42, detail: ["x"] }), { status: 500, title: "HTTP 500" });
  const long = toApiError(500, "x", { title: "t".repeat(500), detail: "d".repeat(2000) });
  assert.equal(long.title.length, 200);
  assert.equal(long.detail?.length, 500);
  assert.ok(long.title.endsWith("…"));
});

test("the glance summarizes linked pages and pull requests", () => {
  assert.equal(toPanelViewModel(ticketDocs("missing")).linkedSummary, "No linked pages or pull requests");
  assert.equal(
    toPanelViewModel(ticketDocs("stale", { pages: [{ path: "a.md", stale: true }, { path: "b.md" }], pullRequests: [{ number: 1 }] })).linkedSummary,
    "2 pages (1 stale), 1 pull request",
  );
  assert.equal(toPanelViewModel(ticketDocs("merged", { pages: [{ path: "a.md" }] })).linkedSummary, "1 page");
  assert.equal(toPanelViewModel(ticketDocs("in_review", { pullRequests: [{ number: 1 }, { number: 2 }] })).linkedSummary, "2 pull requests");
});

test("errors raised by the Jira app itself keep their own wording", () => {
  const disabled = toErrorViewModel({ status: 409, title: "DocOps is not enabled for project PAY", detail: "Ask an admin.", code: "forge_project_disabled" });
  assert.deepEqual([disabled.title, disabled.message, disabled.appearance, disabled.retryable], ["DocOps is not enabled for project PAY", "Ask an admin.", "information", false]);
  const forbidden = toErrorViewModel({ status: 403, title: "You cannot create issues in project PAY", detail: "Create issues permission is required.", code: "forge_forbidden" });
  assert.deepEqual([forbidden.title, forbidden.appearance], ["You cannot create issues in project PAY", "warning"]);
  assert.equal(toErrorViewModel({ status: 400, title: "Choose a fix version", code: "forge_bad_request" }).appearance, "error");
  const unverified = toErrorViewModel({ status: 502, title: "Your Jira permissions could not be verified", detail: "Try again.", code: "forge_jira_error" });
  assert.deepEqual([unverified.appearance, unverified.retryable], ["error", true], "a failed lookup is retryable, a denied permission is not");
  assert.equal(forbidden.retryable, false);
  assert.equal(toErrorViewModel({ status: 409, title: "No documentation space is configured", code: "forge_space_not_configured" }).appearance, "warning");
  // The same status without the marker is a DocOps error and keeps the generic wording.
  assert.equal(toErrorViewModel({ status: 403, title: "Forbidden" }).title, "You do not have access to this in DocOps");
});

// ---- rows hidden from the viewer -----------------------------------------------------------

test("summarizeItems has the same arithmetic as @docops/engine's summarizeReadiness", () => {
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647);
  for (let round = 0; round < 300; round++) {
    const size = next() % 40;
    const items = Array.from({ length: size }, (_, i) => item(`PAY-${i + 1}`, DOCS_STATUS_ORDER[next() % DOCS_STATUS_ORDER.length] as DocsStatus));
    assert.deepEqual(summarizeItems(items), summarizeReadiness(items), items.map((i) => i.docsStatus).join(","));
  }
  assert.deepEqual(summarizeItems([]), summarizeReadiness([]), "an empty list is 100% and ready");
});

test("summarizeItems counts a status it does not know without letting it touch the prototype", () => {
  const summary = summarizeItems([item("PAY-1", "needs_legal_review" as DocsStatus), item("PAY-2", "published"), item("PAY-3", "constructor" as DocsStatus), item("PAY-4", "__proto__" as DocsStatus)]);
  assert.equal(summary.total, 4);
  assert.equal(summary.byStatus["needs_legal_review"], 1);
  assert.equal(summary.byStatus["constructor"], 1);
  assert.equal(Object.getPrototypeOf(summary.byStatus), Object.prototype);
  assert.equal(Object.hasOwn(summary.byStatus, "__proto__"), true, "own data property, no pollution");
  assert.equal(summary.readyPercent, 25);
  assert.equal(summary.blockers, 0);
});

test("restrictReadiness keeps only visible rows and recomputes the totals from them", () => {
  const items = [item("PAY-1", "missing"), item("PAY-2", "stale"), item("PAY-3", "published"), item("PAY-4", "in_review"), item("PAY-5", "merged")];
  const input = deepFreeze(readiness(items, { summary: { total: 5, byStatus: { missing: 1, stale: 1, published: 1, in_review: 1, merged: 1 }, readyPercent: 40, blockers: 2, inReview: 1, ready: false } }));
  const out = restrictReadiness(input, new Set(["PAY-3", "PAY-5", "PAY-99"]));
  assert.deepEqual(out.items.map((i) => i.ticketKey), ["PAY-3", "PAY-5"]);
  assert.deepEqual(out.summary, { total: 2, byStatus: { not_required: 0, missing: 0, in_review: 0, merged: 1, published: 1, stale: 0 }, readyPercent: 100, blockers: 0, inReview: 0, ready: true });
  assert.equal(out.project, "PAY");
  assert.equal(input.items.length, 5, "the input is not touched");
  const text = JSON.stringify(out);
  for (const hidden of ["PAY-1", "PAY-2", "PAY-4"]) assert.ok(!text.includes(hidden), `${hidden} is still in the result`);
});

test("restrictReadiness returns the input as it is when nothing is hidden", () => {
  const input = readiness(mockupItems(), { summary: { ...summarize(mockupItems()), readyPercent: 99.9 } });
  assert.equal(restrictReadiness(input, new Set(input.items.map((i) => i.ticketKey))), input, "DocOps's own summary is kept");
  assert.equal(restrictReadiness(readiness([]), new Set()).items.length, 0);
});

test("a viewer who sees none of the rows gets an empty, not-hiding-anything table", () => {
  const out = restrictReadiness(readiness(mockupItems()), new Set());
  assert.deepEqual(out.items, []);
  const vm = toReadinessViewModel(out);
  assert.equal(vm.isEmpty, true);
  assert.deepEqual([vm.blockers, vm.inReview, vm.total, vm.missingKeys], [0, 0, 0, []]);
});
