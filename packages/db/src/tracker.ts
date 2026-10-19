import { uuidv7, type DocsStatus, type LinkSource } from "@docops/core";
import { computeDocsStatus, summarizeReadiness, DOCS_STATUS_ORDER } from "@docops/engine";
import type { Queryable } from "./client.ts";

export interface TicketRow {
  id: string;
  tracker: string;
  site: string;
  external_id: string;
  key: string;
  project_key: string | null;
  title: string;
  issue_type: string | null;
  status: string | null;
  docs_required: "yes" | "no" | "unknown";
  docs_status: DocsStatus | null;
  fix_versions: string[];
  parent_key: string | null;
  url: string;
}

const TICKET_COLUMNS = "id, tracker, site, external_id, key, project_key, title, issue_type, status, docs_required, docs_status, fix_versions, parent_key, url";

export interface TicketUpsert {
  tracker: "jira" | "jira_dc" | "linear" | "azure_boards" | "github";
  site: string;
  externalId: string;
  key: string;
  projectKey: string;
  title: string;
  issueType: string | null;
  status: string | null;
  statusCategory: "todo" | "in_progress" | "done" | null;
  docsRequired: "yes" | "no" | "unknown";
  fixVersions: string[];
  parentKey: string | null;
  assignee: string | null;
  url: string;
  sourceUpdatedAt: string;
}

/** Upsert the tracker mirror; older events never overwrite newer data (last-writer-wins on source time). */
export async function upsertTicket(tx: Queryable, tenantId: string, t: TicketUpsert): Promise<TicketRow> {
  const { rows } = await tx.query<TicketRow>(
    `INSERT INTO tickets (id, tenant_id, tracker, site, external_id, key, project_key, title, issue_type, status, status_category, docs_required,
                          fix_versions, parent_key, assignee, url, source_updated_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14,$15,$16,$17,now())
     ON CONFLICT (tenant_id, tracker, site, key) DO UPDATE SET
       external_id = EXCLUDED.external_id, project_key = EXCLUDED.project_key, title = EXCLUDED.title, issue_type = EXCLUDED.issue_type,
       status = EXCLUDED.status, status_category = EXCLUDED.status_category, docs_required = EXCLUDED.docs_required,
       fix_versions = EXCLUDED.fix_versions, parent_key = EXCLUDED.parent_key, assignee = EXCLUDED.assignee, url = EXCLUDED.url,
       source_updated_at = EXCLUDED.source_updated_at, synced_at = now()
     WHERE tickets.source_updated_at <= EXCLUDED.source_updated_at
     RETURNING ${TICKET_COLUMNS}`,
    [uuidv7(), tenantId, t.tracker, t.site, t.externalId, t.key, t.projectKey, t.title, t.issueType, t.status, t.statusCategory, t.docsRequired, t.fixVersions, t.parentKey, t.assignee, t.url, t.sourceUpdatedAt],
  );
  return rows[0] ?? ((await getTicketByKey(tx, t.key)) as TicketRow);
}

export async function getTicketByKey(tx: Queryable, key: string): Promise<TicketRow | null> {
  const { rows } = await tx.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE key = $1 ORDER BY source_updated_at DESC LIMIT 1`, [key]);
  return rows[0] ?? null;
}

export async function ticketsForFixVersion(tx: Queryable, project: string, fixVersion: string): Promise<TicketRow[]> {
  const { rows } = await tx.query<TicketRow>(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE project_key = $1 AND $2 = ANY(fix_versions) ORDER BY key`,
    [project, fixVersion],
  );
  return rows;
}

export async function setTicketDocsStatus(tx: Queryable, ticketId: string, status: DocsStatus): Promise<DocsStatus | null> {
  const { rows } = await tx.query<{ previous: DocsStatus | null }>(
    `UPDATE tickets t SET docs_status = $2, docs_status_updated_at = now()
     FROM (SELECT docs_status AS previous FROM tickets WHERE id = $1) prev
     WHERE t.id = $1 RETURNING prev.previous`,
    [ticketId, status],
  );
  return rows[0]?.previous ?? null;
}

// ---------------------------------------------------------------------------- pull requests

export interface PullRequestUpsert {
  repositoryId: string;
  number: number;
  title: string;
  body?: string | null | undefined;
  state: "open" | "closed" | "merged";
  author?: string | null | undefined;
  headRef?: string | null | undefined;
  headSha?: string | null | undefined;
  baseRef?: string | null | undefined;
  mergeCommitSha?: string | null | undefined;
  mergedAt?: string | null | undefined;
  url: string;
  touchesDocs: boolean;
  sourceUpdatedAt: string;
  files?: Array<{ path: string; changeType: "added" | "modified" | "removed" | "renamed"; previousPath?: string | null }> | undefined;
}

export async function upsertPullRequest(tx: Queryable, tenantId: string, pr: PullRequestUpsert): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO pull_requests (id, tenant_id, repository_id, number, title, body, state, author, head_ref, head_sha, base_ref, merge_commit_sha, merged_at, url, touches_docs, source_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (tenant_id, repository_id, number) DO UPDATE SET
       title = EXCLUDED.title, body = EXCLUDED.body, state = EXCLUDED.state, head_ref = EXCLUDED.head_ref, head_sha = EXCLUDED.head_sha,
       base_ref = EXCLUDED.base_ref, merge_commit_sha = EXCLUDED.merge_commit_sha, merged_at = EXCLUDED.merged_at,
       touches_docs = pull_requests.touches_docs OR EXCLUDED.touches_docs, source_updated_at = EXCLUDED.source_updated_at
     WHERE pull_requests.source_updated_at <= EXCLUDED.source_updated_at
     RETURNING id`,
    [uuidv7(), tenantId, pr.repositoryId, pr.number, pr.title, pr.body ?? null, pr.state, pr.author ?? null, pr.headRef ?? null, pr.headSha ?? null, pr.baseRef ?? null, pr.mergeCommitSha ?? null, pr.mergedAt ?? null, pr.url, pr.touchesDocs, pr.sourceUpdatedAt],
  );
  const id =
    rows[0]?.id ??
    (await tx.query<{ id: string }>("SELECT id FROM pull_requests WHERE repository_id = $1 AND number = $2", [pr.repositoryId, pr.number])).rows[0]?.id;
  if (id && pr.files) {
    for (const f of pr.files) {
      await tx.query(
        `INSERT INTO pull_request_files (tenant_id, pull_request_id, path, change_type, previous_path)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (pull_request_id, path) DO UPDATE SET change_type = EXCLUDED.change_type`,
        [tenantId, id, f.path, f.changeType, f.previousPath ?? null],
      );
    }
  }
  return id as string;
}

// ---------------------------------------------------------------------------- links

export interface LinkRow {
  id: string;
  ticket_key: string;
  target_type: string;
  target_id: string | null;
  target_ref: string | null;
  source: LinkSource;
  created_by: string;
  created_at: Date;
}

export async function createLink(
  tx: Queryable,
  tenantId: string,
  input: { ticketId: string; targetType: "page" | "pull_request" | "commit" | "release" | "entity"; targetId?: string | null; targetRef?: string | null; source: LinkSource; createdBy: string },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ticket_links (id, tenant_id, ticket_id, target_type, target_id, target_ref, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (ticket_id, target_type, target_id, target_ref, source) DO UPDATE SET created_by = ticket_links.created_by
     RETURNING id`,
    [uuidv7(), tenantId, input.ticketId, input.targetType, input.targetId ?? null, input.targetRef ?? null, input.source, input.createdBy],
  );
  return rows[0]?.id as string;
}

export async function listLinks(tx: Queryable, filters: { ticketKey?: string; pageId?: string; id?: string; after?: string | null; limit: number }): Promise<LinkRow[]> {
  const { rows } = await tx.query<LinkRow>(
    `SELECT l.id, t.key AS ticket_key, l.target_type, l.target_id, l.target_ref, l.source, l.created_by, l.created_at
     FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id
     WHERE ($1::text IS NULL OR t.key = $1) AND ($2::uuid IS NULL OR (l.target_type = 'page' AND l.target_id = $2::uuid))
       AND ($3::uuid IS NULL OR l.id = $3::uuid) AND ($4::uuid IS NULL OR l.id > $4::uuid)
     ORDER BY l.id LIMIT $5`,
    [filters.ticketKey ?? null, filters.pageId ?? null, filters.id ?? null, filters.after ?? null, filters.limit],
  );
  return rows;
}

export async function deleteLink(tx: Queryable, id: string): Promise<"deleted" | "derived" | "not_found"> {
  const { rows } = await tx.query<{ source: string }>("SELECT source FROM ticket_links WHERE id = $1", [id]);
  const source = rows[0]?.source;
  if (!source) return "not_found";
  if (!["tracker_panel", "api"].includes(source)) return "derived";
  await tx.query("DELETE FROM ticket_links WHERE id = $1", [id]);
  return "deleted";
}

// ---------------------------------------------------------------------------- docs status & readiness

export interface TicketDocsView {
  ticket: TicketRow;
  status: DocsStatus;
  reasons: string[];
  pages: Array<{ pageId: string; path: string; title: string; stale: boolean; published: boolean; spaceKey: string }>;
  pullRequests: Array<{ repository: string; number: number; title: string; state: "open" | "closed" | "merged"; touchesDocs: boolean; url: string }>;
  links: LinkRow[];
}

/** Gather links → PRs and pages (staleness, publication) and run the shared state machine. */
export async function ticketDocsView(tx: Queryable, ticket: TicketRow): Promise<TicketDocsView> {
  const links = await listLinks(tx, { ticketKey: ticket.key, limit: 500 });
  const { rows: prs } = await tx.query<{ full_name: string; number: number; title: string; state: "open" | "closed" | "merged"; touches_docs: boolean; url: string }>(
    `SELECT r.full_name, p.number, p.title, p.state, p.touches_docs, p.url
     FROM ticket_links l JOIN pull_requests p ON p.id = l.target_id JOIN repositories r ON r.id = p.repository_id
     WHERE l.ticket_id = $1 AND l.target_type = 'pull_request'
     GROUP BY r.full_name, p.number, p.title, p.state, p.touches_docs, p.url ORDER BY p.number`,
    [ticket.id],
  );
  const { rows: pages } = await tx.query<{ page_id: string; path: string; title: string; space_key: string; stale: boolean; published: boolean }>(
    `SELECT p.id AS page_id, p.path, p.title, s.key AS space_key,
            EXISTS (SELECT 1 FROM doc_references r JOIN entities e ON e.id = r.entity_id
                    LEFT JOIN entity_snapshots cur ON cur.entity_id = r.entity_id AND cur.superseded_at IS NULL
                    WHERE r.page_revision_id = p.current_revision_id AND r.kind <> 'generated' AND r.confidence >= 0.6
                      AND (e.removed_at_sha IS NOT NULL OR cur.fingerprint IS DISTINCT FROM r.entity_fingerprint)) AS stale,
            EXISTS (SELECT 1 FROM deployments d JOIN builds b ON b.id = d.build_id JOIN page_revisions pr ON pr.id = p.current_revision_id
                    WHERE d.space_id = p.space_id AND d.environment = 'prod' AND d.status = 'active' AND d.promoted_at >= pr.committed_at) AS published
     FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE p.deleted_at IS NULL AND (
       p.id IN (SELECT target_id FROM ticket_links WHERE ticket_id = $1 AND target_type = 'page')
       OR p.id IN (SELECT f.page_id FROM ticket_links l JOIN pull_request_files f ON f.pull_request_id = l.target_id
                   JOIN pull_requests pr ON pr.id = f.pull_request_id
                   WHERE l.ticket_id = $1 AND l.target_type = 'pull_request' AND pr.state = 'merged' AND f.page_id IS NOT NULL))
     ORDER BY p.path`,
    [ticket.id],
  );
  const result = computeDocsStatus({
    required: ticket.docs_required === "yes",
    pullRequests: prs.map((p) => ({ ref: `${p.full_name}#${p.number}`, state: p.state, touchesDocs: p.touches_docs })),
    pages: pages.map((p) => ({ path: p.path, stale: p.stale, published: p.published })),
  });
  return {
    ticket,
    status: result.status,
    reasons: result.reasons,
    pages: pages.map((p) => ({ pageId: p.page_id, path: p.path, title: p.title, stale: p.stale, published: p.published, spaceKey: p.space_key })),
    pullRequests: prs.map((p) => ({ repository: p.full_name, number: p.number, title: p.title, state: p.state, touchesDocs: p.touches_docs, url: p.url })),
    links,
  };
}

export async function readinessForFixVersion(tx: Queryable, project: string, fixVersion: string) {
  const tickets = await ticketsForFixVersion(tx, project, fixVersion);
  const items = [];
  for (const ticket of tickets) {
    const view = await ticketDocsView(tx, ticket);
    items.push({ view, docsStatus: view.status });
  }
  items.sort((a, b) => DOCS_STATUS_ORDER.indexOf(a.docsStatus) - DOCS_STATUS_ORDER.indexOf(b.docsStatus) || a.view.ticket.key.localeCompare(b.view.ticket.key));
  return { summary: summarizeReadiness(items), items };
}
