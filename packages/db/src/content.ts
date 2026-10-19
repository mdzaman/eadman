import { uuidv7 } from "@docops/core";
import type { Queryable } from "./client.ts";

export interface RepositoryRow {
  id: string;
  provider: string;
  full_name: string;
  default_branch: string;
  web_url: string | null;
  config_path: string;
  status: string;
  last_indexed_sha: string | null;
  last_indexed_at: Date | null;
}

const REPO_COLUMNS = "id, provider, full_name, default_branch, web_url, config_path, status, last_indexed_sha, last_indexed_at";

export async function upsertRepository(
  tx: Queryable,
  tenantId: string,
  input: { provider: string; fullName: string; defaultBranch?: string; webUrl?: string | null; configPath?: string; externalId?: string | null },
): Promise<RepositoryRow> {
  const { rows } = await tx.query<RepositoryRow>(
    `INSERT INTO repositories (id, tenant_id, provider, full_name, default_branch, web_url, config_path, external_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, provider, full_name) DO UPDATE
       SET default_branch = COALESCE(EXCLUDED.default_branch, repositories.default_branch),
           web_url = COALESCE(EXCLUDED.web_url, repositories.web_url),
           status = 'active'
     RETURNING ${REPO_COLUMNS}`,
    [uuidv7(), tenantId, input.provider, input.fullName, input.defaultBranch ?? "main", input.webUrl ?? null, input.configPath ?? "docops.yaml", input.externalId ?? null],
  );
  return rows[0] as RepositoryRow;
}

export async function findRepository(tx: Queryable, provider: string, fullName: string): Promise<RepositoryRow | null> {
  const { rows } = await tx.query<RepositoryRow>(`SELECT ${REPO_COLUMNS} FROM repositories WHERE provider = $1 AND full_name = $2`, [provider, fullName]);
  return rows[0] ?? null;
}

export async function getRepository(tx: Queryable, id: string): Promise<RepositoryRow | null> {
  const { rows } = await tx.query<RepositoryRow>(`SELECT ${REPO_COLUMNS} FROM repositories WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listRepositories(tx: Queryable, after: string | null, limit: number): Promise<RepositoryRow[]> {
  const { rows } = await tx.query<RepositoryRow>(
    `SELECT ${REPO_COLUMNS} FROM repositories WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`,
    [after, limit],
  );
  return rows;
}

export interface SpaceRow {
  id: string;
  key: string;
  name: string;
  repository_id: string | null;
  docs_root: string;
  default_audience: string;
  base_url: string | null;
}

const SPACE_COLUMNS = "id, key, name, repository_id, docs_root, default_audience, base_url";

export async function listSpaces(tx: Queryable, after: string | null, limit: number): Promise<SpaceRow[]> {
  const { rows } = await tx.query<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`, [after, limit]);
  return rows;
}

export async function getSpace(tx: Queryable, idOrKey: string): Promise<SpaceRow | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrKey);
  const { rows } = await tx.query<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE ${byId ? "id = $1::uuid" : "key = $1"}`, [idOrKey]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------- snapshot apply

export interface SnapshotInput {
  commitSha: string;
  committedAt?: string | undefined;
  ref?: string | undefined;
  spaceKey: string;
  spaceName?: string | undefined;
  docsRoot?: string | undefined;
  sources: Array<{ key: string; format: string; path: string; extractor?: string | undefined; extractorVersion?: string | undefined }>;
  pages: Array<{
    path: string;
    title: string;
    pageType?: string | undefined;
    contentHash: string;
    frontmatter?: Record<string, unknown> | undefined;
    headings?: unknown[] | undefined;
    wordCount?: number | undefined;
    tickets?: string[] | undefined;
    reviewedOn?: string | undefined;
    references?: Array<{ entityKey: string; kind: string; line?: number | null; confidence?: number; entityFingerprint: string }> | undefined;
  }>;
  entities: Array<{ key: string; kind: string; name: string; sourceKey: string; parentKey?: string | null; visibility?: string; fingerprint: string; attributes?: Record<string, unknown>; surfaceForms?: string[] }>;
}

export interface ApplySnapshotResult {
  spaceId: string;
  pages: number;
  entities: number;
  references: number;
  changedEntities: number;
}

const PAGE_TYPES = new Set(["guide", "how_to", "tutorial", "concept", "reference", "generated_reference", "runbook", "adr", "postmortem", "release_notes", "onboarding", "snippet", "other"]);
const SOURCE_FORMATS = new Set(["openapi", "asyncapi", "graphql", "protobuf", "jsonschema", "typescript", "python", "java", "go", "csharp", "rust", "terraform", "cloudformation", "helm", "kubernetes", "sql", "custom"]);

/**
 * Upsert the derived content graph for a space from a CLI snapshot of the default branch.
 * Entity history only records fingerprint changes; references store the fingerprint
 * the page was written against (staleness = mismatch with the current snapshot).
 */
export async function applySnapshot(
  tx: Queryable,
  tenantId: string,
  repositoryId: string,
  snapshot: SnapshotInput,
  options: { jiraSite?: string | undefined } = {},
): Promise<ApplySnapshotResult> {
  const committedAt = snapshot.committedAt ?? new Date().toISOString();
  const { rows: spaceRows } = await tx.query<{ id: string }>(
    `INSERT INTO spaces (id, tenant_id, repository_id, key, name, docs_root)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name, repository_id = EXCLUDED.repository_id, docs_root = EXCLUDED.docs_root
     RETURNING id`,
    [uuidv7(), tenantId, repositoryId, snapshot.spaceKey, snapshot.spaceName ?? snapshot.spaceKey, snapshot.docsRoot ?? "docs"],
  );
  const spaceId = spaceRows[0]?.id as string;

  // Sources and entities.
  const sourceIds = new Map<string, string>();
  for (const source of snapshot.sources) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO entity_sources (id, tenant_id, repository_id, source_key, format, path, extractor, extractor_version, last_snapshot_sha)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (repository_id, source_key) DO UPDATE SET format = EXCLUDED.format, path = EXCLUDED.path,
         extractor = EXCLUDED.extractor, extractor_version = EXCLUDED.extractor_version, last_snapshot_sha = EXCLUDED.last_snapshot_sha
       RETURNING id`,
      [uuidv7(), tenantId, repositoryId, source.key, SOURCE_FORMATS.has(source.format) ? source.format : "custom", source.path, source.extractor ?? source.format, source.extractorVersion ?? "0", snapshot.commitSha],
    );
    sourceIds.set(source.key, rows[0]?.id as string);
  }

  const entityIds = new Map<string, string>();
  let changedEntities = 0;
  for (const e of snapshot.entities) {
    const sourceId = sourceIds.get(e.sourceKey);
    if (!sourceId) continue;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO entities (id, tenant_id, source_id, key, kind, name, visibility, first_seen_sha)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (source_id, key) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, visibility = EXCLUDED.visibility, removed_at_sha = NULL
       RETURNING id`,
      [uuidv7(), tenantId, sourceId, e.key, e.kind, e.name, e.visibility === "internal" || e.visibility === "deprecated" ? e.visibility : "public", snapshot.commitSha],
    );
    const entityId = rows[0]?.id as string;
    entityIds.set(e.key, entityId);
    const { rows: current } = await tx.query<{ id: string; fingerprint: string }>(
      "SELECT id, fingerprint FROM entity_snapshots WHERE entity_id = $1 AND superseded_at IS NULL",
      [entityId],
    );
    if (current[0]?.fingerprint === e.fingerprint) continue;
    if (current[0]) {
      await tx.query("UPDATE entity_snapshots SET superseded_at = $2 WHERE id = $1", [current[0].id, committedAt]);
      changedEntities++;
    }
    await tx.query(
      `INSERT INTO entity_snapshots (id, tenant_id, entity_id, fingerprint, attributes, surface_forms, introduced_sha, introduced_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::text[],$7,$8) ON CONFLICT (entity_id, introduced_sha) DO UPDATE
       SET fingerprint = EXCLUDED.fingerprint, attributes = EXCLUDED.attributes, superseded_at = NULL`,
      [uuidv7(), tenantId, entityId, e.fingerprint, JSON.stringify(e.attributes ?? {}), e.surfaceForms ?? [], snapshot.commitSha, committedAt],
    );
  }
  for (const e of snapshot.entities) {
    if (!e.parentKey) continue;
    const parent = entityIds.get(e.parentKey);
    if (parent) await tx.query("UPDATE entities SET parent_id = $2 WHERE id = $1", [entityIds.get(e.key), parent]);
  }
  // Entities that disappeared from these sources were removed at this commit.
  const sourceList = [...sourceIds.values()];
  if (sourceList.length > 0) {
    await tx.query(
      "UPDATE entities SET removed_at_sha = $3 WHERE source_id = ANY($1::uuid[]) AND removed_at_sha IS NULL AND NOT (key = ANY($2::text[]))",
      [sourceList, snapshot.entities.map((e) => e.key), snapshot.commitSha],
    );
  }

  // Pages, revisions and references.
  let references = 0;
  const seenPages: string[] = [];
  for (const page of snapshot.pages) {
    const pageType = PAGE_TYPES.has(page.pageType ?? "") ? page.pageType : "other";
    const slug = page.path.replace(/\.(md|mdx)$/, "").replace(/(^|\/)index$/, "");
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO pages (id, tenant_id, space_id, path, slug, title, page_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (space_id, path) DO UPDATE SET title = EXCLUDED.title, page_type = EXCLUDED.page_type, deleted_at = NULL
       RETURNING id`,
      [uuidv7(), tenantId, spaceId, page.path, slug, page.title, pageType],
    );
    const pageId = rows[0]?.id as string;
    seenPages.push(pageId);
    const { rows: revRows } = await tx.query<{ id: string }>(
      `INSERT INTO page_revisions (id, tenant_id, page_id, commit_sha, blob_sha, content_hash, title, frontmatter, headings, word_count, reviewed_on, committed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::date,$12)
       ON CONFLICT (page_id, blob_sha) DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
      [
        uuidv7(), tenantId, pageId, snapshot.commitSha, page.contentHash, page.contentHash, page.title,
        JSON.stringify(page.frontmatter ?? {}), JSON.stringify(page.headings ?? []), page.wordCount ?? 0, page.reviewedOn ?? null, committedAt,
      ],
    );
    const revisionId = revRows[0]?.id as string;
    await tx.query("UPDATE pages SET current_revision_id = $2 WHERE id = $1", [pageId, revisionId]);
    // References are immutable per revision: an unchanged page keeps the fingerprints it was
    // written against (that is what makes it stale later). New matches are added.
    for (const ref of page.references ?? []) {
      const entityId = entityIds.get(ref.entityKey);
      if (!entityId) continue;
      await tx.query(
        `INSERT INTO doc_references (id, tenant_id, page_revision_id, entity_id, kind, line, confidence, entity_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [uuidv7(), tenantId, revisionId, entityId, ref.kind, ref.line ?? null, ref.confidence ?? 1, ref.entityFingerprint],
      );
      references++;
    }
    for (const key of page.tickets ?? []) {
      const ticketId = await ensureTicketStub(tx, tenantId, key, options.jiraSite ?? "jira.local");
      await tx.query(
        `INSERT INTO ticket_links (id, tenant_id, ticket_id, target_type, target_id, source, created_by)
         VALUES ($1,$2,$3,'page',$4,'frontmatter','snapshot') ON CONFLICT DO NOTHING`,
        [uuidv7(), tenantId, ticketId, pageId],
      );
    }
  }
  await tx.query("UPDATE pages SET deleted_at = now() WHERE space_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))", [spaceId, seenPages]);
  await tx.query("UPDATE repositories SET last_indexed_sha = $2, last_indexed_at = now() WHERE id = $1", [repositoryId, snapshot.commitSha]);
  await tx.query(
    `INSERT INTO versions (id, tenant_id, space_id, name, git_ref, commit_sha, kind, status, is_default, published_at)
     VALUES ($1,$2,$3,'latest',$4,$5,'branch','published',true,now())
     ON CONFLICT (space_id, name) DO UPDATE SET commit_sha = EXCLUDED.commit_sha, git_ref = EXCLUDED.git_ref`,
    [uuidv7(), tenantId, spaceId, snapshot.ref ?? "refs/heads/main", snapshot.commitSha],
  );
  return { spaceId, pages: snapshot.pages.length, entities: snapshot.entities.length, references, changedEntities };
}

export async function ensureTicketStub(tx: Queryable, tenantId: string, key: string, site: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO tickets (id, tenant_id, tracker, site, external_id, key, project_key, title, url, source_updated_at)
     VALUES ($1,$2,'jira',$3,$4,$4,$5,$4,$6,'epoch')
     ON CONFLICT (tenant_id, tracker, site, key) DO UPDATE SET key = EXCLUDED.key
     RETURNING id`,
    [uuidv7(), tenantId, site, key, key.split("-")[0], `https://${site}/browse/${key}`],
  );
  return rows[0]?.id as string;
}

// ---------------------------------------------------------------------------- read models

export interface PageSummaryRow {
  id: string;
  space_id: string;
  path: string;
  slug: string;
  title: string;
  page_type: string;
  audience: string[];
}

export async function listPages(tx: Queryable, spaceId: string, filters: { q?: string; pageType?: string; after?: string | null; limit: number }): Promise<PageSummaryRow[]> {
  const { rows } = await tx.query<PageSummaryRow>(
    `SELECT id, space_id, path, slug, title, page_type, audience FROM pages
     WHERE space_id = $1 AND deleted_at IS NULL
       AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR path ILIKE '%' || $2 || '%')
       AND ($3::text IS NULL OR page_type = $3)
       AND ($4::uuid IS NULL OR id > $4::uuid)
     ORDER BY id LIMIT $5`,
    [spaceId, filters.q ?? null, filters.pageType ?? null, filters.after ?? null, filters.limit],
  );
  return rows;
}

export async function findPageByPath(tx: Queryable, spaceKey: string, path: string): Promise<PageSummaryRow | null> {
  const { rows } = await tx.query<PageSummaryRow>(
    `SELECT p.id, p.space_id, p.path, p.slug, p.title, p.page_type, p.audience FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE s.key = $1 AND p.path = $2 AND p.deleted_at IS NULL`,
    [spaceKey, path],
  );
  return rows[0] ?? null;
}

export async function getPage(tx: Queryable, pageId: string) {
  const { rows } = await tx.query<PageSummaryRow & { revision_id: string; commit_sha: string; content_hash: string; frontmatter: Record<string, unknown>; headings: unknown[]; word_count: number; reviewed_on: Date | null; committed_at: Date }>(
    `SELECT p.id, p.space_id, p.path, p.slug, p.title, p.page_type, p.audience,
            r.id AS revision_id, r.commit_sha, r.content_hash, r.frontmatter, r.headings, r.word_count, r.reviewed_on, r.committed_at
     FROM pages p JOIN page_revisions r ON r.id = p.current_revision_id
     WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [pageId],
  );
  return rows[0] ?? null;
}

export interface PageReferenceRow {
  entity_id: string;
  key: string;
  kind: string;
  reference_kind: string;
  line: number | null;
  stale: boolean;
}

/** References of a page's current revision, with staleness (written-against fingerprint != current). */
export async function pageReferences(tx: Queryable, pageId: string): Promise<PageReferenceRow[]> {
  const { rows } = await tx.query<PageReferenceRow>(
    `SELECT e.id AS entity_id, e.key, e.kind, r.kind AS reference_kind, r.line,
            (e.removed_at_sha IS NOT NULL OR (cur.fingerprint IS NOT NULL AND cur.fingerprint <> r.entity_fingerprint)) AS stale
     FROM pages p
     JOIN doc_references r ON r.page_revision_id = p.current_revision_id
     JOIN entities e ON e.id = r.entity_id
     LEFT JOIN entity_snapshots cur ON cur.entity_id = e.id AND cur.superseded_at IS NULL
     WHERE p.id = $1 AND r.kind <> 'generated'
     ORDER BY r.line NULLS FIRST, e.key`,
    [pageId],
  );
  return rows;
}

export async function stalePageIds(tx: Queryable, pageIds: readonly string[]): Promise<Set<string>> {
  if (pageIds.length === 0) return new Set();
  const { rows } = await tx.query<{ id: string }>(
    `SELECT DISTINCT p.id FROM pages p
     JOIN doc_references r ON r.page_revision_id = p.current_revision_id
     JOIN entities e ON e.id = r.entity_id
     LEFT JOIN entity_snapshots cur ON cur.entity_id = r.entity_id AND cur.superseded_at IS NULL
     WHERE p.id = ANY($1::uuid[]) AND r.kind <> 'generated' AND r.confidence >= 0.6
       AND (e.removed_at_sha IS NOT NULL OR cur.fingerprint IS DISTINCT FROM r.entity_fingerprint)`,
    [pageIds],
  );
  return new Set(rows.map((r) => r.id));
}

export interface EntityRow {
  id: string;
  key: string;
  kind: string;
  name: string;
  source_key: string;
  parent_key: string | null;
  visibility: string;
  fingerprint: string | null;
  attributes: Record<string, unknown> | null;
  documented: boolean;
}

export async function listEntities(
  tx: Queryable,
  filters: { spaceId?: string | undefined; kind?: string | undefined; q?: string | undefined; documented?: boolean | undefined; after?: string | null; limit: number; id?: string | undefined },
): Promise<EntityRow[]> {
  const { rows } = await tx.query<EntityRow>(
    `SELECT e.id, e.key, e.kind, e.name, s.source_key, pe.key AS parent_key, e.visibility, cur.fingerprint, cur.attributes,
            EXISTS (SELECT 1 FROM doc_references r JOIN pages p ON p.current_revision_id = r.page_revision_id
                    WHERE r.entity_id = e.id AND r.kind <> 'generated' AND r.confidence >= 0.6 AND p.deleted_at IS NULL) AS documented
     FROM entities e
     JOIN entity_sources s ON s.id = e.source_id
     LEFT JOIN entities pe ON pe.id = e.parent_id
     LEFT JOIN entity_snapshots cur ON cur.entity_id = e.id AND cur.superseded_at IS NULL
     WHERE e.removed_at_sha IS NULL
       AND ($1::uuid IS NULL OR s.repository_id = (SELECT repository_id FROM spaces WHERE id = $1::uuid))
       AND ($2::text IS NULL OR e.kind = $2)
       AND ($3::text IS NULL OR e.key ILIKE '%' || $3 || '%' OR e.name ILIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR e.id > $4::uuid)
       AND ($6::uuid IS NULL OR e.id = $6::uuid)
     ORDER BY e.id LIMIT $5`,
    [filters.spaceId ?? null, filters.kind ?? null, filters.q ?? null, filters.after ?? null, filters.limit, filters.id ?? null],
  );
  return filters.documented === undefined ? rows : rows.filter((r) => r.documented === filters.documented);
}

export async function entityReferencedBy(tx: Queryable, entityId: string) {
  const { rows } = await tx.query<{ page_id: string; path: string; kind: string; line: number | null; stale: boolean }>(
    `SELECT p.id AS page_id, p.path, r.kind, r.line,
            (e.removed_at_sha IS NOT NULL OR (cur.fingerprint IS NOT NULL AND cur.fingerprint <> r.entity_fingerprint)) AS stale
     FROM doc_references r
     JOIN entities e ON e.id = r.entity_id
     JOIN pages p ON p.current_revision_id = r.page_revision_id AND p.deleted_at IS NULL
     LEFT JOIN entity_snapshots cur ON cur.entity_id = r.entity_id AND cur.superseded_at IS NULL
     WHERE r.entity_id = $1 ORDER BY p.path, r.line`,
    [entityId],
  );
  return rows;
}

/** Coverage per kind for a space (docs/03-data-model.md §4, L1 + L2). */
export async function coverageForSpace(tx: Queryable, spaceId: string, kind?: string) {
  const { rows } = await tx.query<{ kind: string; public_entities: number; documented_l1: number; documented_l2: number }>(
    `SELECT e.kind,
            count(*)::int AS public_entities,
            count(*) FILTER (WHERE coalesce(cur.attributes->>'description', cur.attributes->>'summary', '') <> '')::int AS documented_l1,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM doc_references r JOIN pages p ON p.current_revision_id = r.page_revision_id
              WHERE r.entity_id = e.id AND r.kind <> 'generated' AND r.confidence >= 0.6 AND p.deleted_at IS NULL AND p.space_id = $1))::int AS documented_l2
     FROM entities e
     JOIN entity_sources s ON s.id = e.source_id
     JOIN spaces sp ON sp.repository_id = s.repository_id AND sp.id = $1
     LEFT JOIN entity_snapshots cur ON cur.entity_id = e.id AND cur.superseded_at IS NULL
     WHERE e.visibility = 'public' AND e.removed_at_sha IS NULL AND ($2::text IS NULL OR e.kind = $2)
     GROUP BY e.kind ORDER BY e.kind`,
    [spaceId, kind ?? null],
  );
  return rows;
}
