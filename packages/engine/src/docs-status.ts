import type { DocsStatus } from "@docops/core";

export interface DocsStatusInput {
  /** Resolved "Docs required" (field, label or issue-type policy). */
  required: boolean;
  /** Pull requests linked to the ticket. */
  pullRequests: ReadonlyArray<{ ref: string; state: "open" | "closed" | "merged"; touchesDocs: boolean }>;
  /** Doc pages linked to the ticket that exist on the default branch. */
  pages: ReadonlyArray<{ path: string; stale: boolean; published: boolean }>;
}

export interface DocsStatusResult {
  status: DocsStatus;
  reasons: string[];
}

/**
 * The docs-status state machine (docs/06-jira-integration.md §6). Pure: the API, CLI,
 * tracker-sync worker and Forge app all share this implementation.
 */
export function computeDocsStatus(input: DocsStatusInput): DocsStatusResult {
  const docPRs = input.pullRequests.filter((p) => p.touchesDocs);
  const open = docPRs.filter((p) => p.state === "open");
  const merged = docPRs.filter((p) => p.state === "merged");
  const stale = input.pages.filter((p) => p.stale);
  const hasDocs = docPRs.length > 0 || input.pages.length > 0;

  if (!input.required && !hasDocs) return { status: "not_required", reasons: ["Docs not required for this ticket"] };
  if (open.length > 0) return { status: "in_review", reasons: open.map((p) => `PR ${p.ref} is open and changes docs`) };
  if (stale.length > 0) {
    return { status: "stale", reasons: stale.map((p) => `${p.path} references entities that changed after it was written`) };
  }
  if (merged.length > 0 || input.pages.length > 0) {
    const allPublished = input.pages.length > 0 && input.pages.every((p) => p.published);
    return {
      status: allPublished ? "published" : "merged",
      reasons: [
        ...merged.map((p) => `PR ${p.ref} merged`),
        ...input.pages.map((p) => `${p.path} ${p.published ? "is published to production" : "is merged, not yet in production"}`),
      ],
    };
  }
  return input.required
    ? { status: "missing", reasons: ["Docs are required but no doc change is linked"] }
    : { status: "not_required", reasons: ["Docs not required for this ticket"] };
}

export interface ReadinessSummary {
  total: number;
  byStatus: Record<DocsStatus, number>;
  readyPercent: number;
  blockers: number;
  inReview: number;
  ready: boolean;
}

/** readyPercent = (published + merged + not_required) / total; blockers = missing + stale. */
export function summarizeReadiness(items: ReadonlyArray<{ docsStatus: DocsStatus }>): ReadinessSummary {
  const byStatus: Record<DocsStatus, number> = { not_required: 0, missing: 0, in_review: 0, merged: 0, published: 0, stale: 0 };
  for (const item of items) byStatus[item.docsStatus]++;
  const readyCount = byStatus.published + byStatus.merged + byStatus.not_required;
  const blockers = byStatus.missing + byStatus.stale;
  return {
    total: items.length,
    byStatus,
    readyPercent: items.length === 0 ? 100 : Math.round((readyCount / items.length) * 1000) / 10,
    blockers,
    inReview: byStatus.in_review,
    ready: blockers === 0 && byStatus.in_review === 0,
  };
}

/** Sort order used by readiness views: blockers first. */
export const DOCS_STATUS_ORDER: readonly DocsStatus[] = ["stale", "missing", "in_review", "merged", "published", "not_required"];
