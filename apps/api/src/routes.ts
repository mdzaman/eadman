import { badRequest, conflict, DocOpsError, forbidden, notFound, ROLES, uuidv7, type Finding, type Role } from "@docops/core";
import {
  activeDeployment,
  applySnapshot,
  coverageForSpace,
  createApiToken,
  createBuild,
  createLink,
  deleteLink,
  dismissFinding,
  ensureTicketStub,
  entityReferencedBy,
  event,
  finalizeBuild,
  findPageByPath,
  findRepository,
  getBuild,
  getCheckRun,
  getPage,
  getRepository,
  getSpace,
  getTicketByKey,
  listAudit,
  listDeployments,
  listEntities,
  listFindings,
  listLinks,
  listPages,
  listRepositories,
  listSpaces,
  markProcessed,
  missingBlobsForBuild,
  pageReferences,
  promoteBuild,
  readinessForFixVersion,
  recordBlob,
  recordCheckRun,
  ticketDocsView,
  upsertRepository,
  upsertTicket,
  verifyAuditChain,
  writeOutbox,
  type BuildRow,
  type DeploymentRow,
  type FindingRow,
  type LinkRow,
  type Queryable,
  type RepositoryRow,
  type SnapshotInput,
  type TicketRow,
} from "@docops/db";
import { docTaskFields, fixVersionJql, ticketFromIssue } from "@docops/jira";
import { audit, inTenant, iso, jsonBody, nextCursor, oneOf, pageParams, requireAccess, str, uuidParam, type Ctx, type Principal } from "./context.ts";
import { manifestDigest, previewToken } from "./security.ts";

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** OpenAPI-style path, e.g. /v1/spaces/{spaceId}. */
  path: string;
  operationId: string;
  auth: "token" | "none";
  handler: (c: Ctx) => Promise<Response>;
}

const UUID = /^[0-9a-f-]{36}$/;
const KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/;

// ---------------------------------------------------------------------------- serializers

const repositoryJson = (r: RepositoryRow) => ({
  id: r.id,
  provider: r.provider,
  fullName: r.full_name,
  defaultBranch: r.default_branch,
  webUrl: r.web_url,
  configPath: r.config_path,
  status: r.status,
  lastIndexedSha: r.last_indexed_sha,
  lastIndexedAt: iso(r.last_indexed_at),
});

const findingJson = (f: FindingRow) => ({
  id: f.id,
  ruleId: f.rule_id,
  category: f.category,
  severity: f.severity,
  origin: f.origin,
  message: f.message,
  file: f.file_path,
  line: f.line,
  endLine: f.end_line,
  entityKey: f.entity_key,
  evidence: f.evidence,
  suggestion: f.suggestion,
  fingerprint: f.fingerprint,
  state: { fingerprint: f.fingerprint, status: f.state ?? "open", dismissedBy: f.dismissed_by, dismissalReason: f.dismissal_reason, dismissalNote: f.dismissal_note },
});

const buildJson = (b: BuildRow) => ({
  id: b.id,
  spaceId: b.space_id,
  versionName: b.version_name,
  audience: b.audience,
  commitSha: b.commit_sha,
  kind: b.kind,
  status: b.status,
  manifestDigest: b.manifest_digest,
  signature: b.signature,
  pageCount: b.page_count,
  fileCount: b.file_count,
  totalBytes: b.total_bytes === null ? null : Number(b.total_bytes),
  previewUrl: b.preview_url,
  startedAt: iso(b.started_at),
  finishedAt: iso(b.finished_at),
});

const deploymentJson = (d: DeploymentRow) => ({
  id: d.id,
  buildId: d.build_id,
  spaceId: d.space_id,
  environment: d.environment,
  versionName: d.version_name,
  audience: d.audience,
  url: d.url,
  status: d.status,
  promotedBy: d.promoted_by,
  approvedBy: d.approved_by,
  promotedAt: iso(d.promoted_at),
});

const linkJson = (l: LinkRow) => ({
  id: l.id,
  ticketKey: l.ticket_key,
  targetType: l.target_type,
  targetId: l.target_id,
  targetRef: l.target_ref,
  source: l.source,
  createdBy: l.created_by,
  createdAt: iso(l.created_at),
});

function siteUrl(c: Ctx, p: Principal, spaceKey: string, environment: string, path = ""): string {
  return `${c.get("deps").config.publicUrl}/sites/${p.tenantSlug}/${spaceKey}/${environment}/${path}`;
}

async function pageUrl(tx: Queryable, c: Ctx, p: Principal, spaceKey: string, pagePath: string): Promise<string | null> {
  const prod = await activeDeployment(tx, spaceKey, "prod");
  if (!prod) return null;
  const slug = pagePath.replace(/\.(md|mdx)$/, "").replace(/(^|\/)index$/, "");
  return siteUrl(c, p, spaceKey, "prod", slug ? `${slug}/` : "");
}

async function repositoryFor(tx: Queryable, p: Principal, repo: unknown): Promise<RepositoryRow> {
  const r = (repo ?? {}) as { provider?: string; fullName?: string };
  if (!r.provider || !r.fullName) throw badRequest("repository.provider and repository.fullName are required", [{ pointer: "/repository", message: "is required" }]);
  if (p.repository && p.repository !== r.fullName) throw forbidden(`This CI token is bound to ${p.repository}`);
  return (await findRepository(tx, r.provider, r.fullName)) ?? (await upsertRepository(tx, p.tenantId, { provider: r.provider, fullName: r.fullName }));
}

async function resolveTicket(tx: Queryable, c: Ctx, p: Principal, key: string): Promise<TicketRow | null> {
  const existing = await getTicketByKey(tx, key);
  if (existing && existing.title !== existing.key) return existing;
  const jira = c.get("deps").jira?.(p.tenantId);
  const issue = jira ? await jira.getIssue(key) : null;
  if (issue && jira) return upsertTicket(tx, p.tenantId, ticketFromIssue(issue, jira.site, { issueTypes: ["Story", "Bug"] }));
  return existing;
}

async function ticketDocsJson(tx: Queryable, c: Ctx, p: Principal, ticket: TicketRow) {
  const view = await ticketDocsView(tx, ticket);
  return {
    ticket: { key: ticket.key, title: ticket.title, status: ticket.status, docsRequired: ticket.docs_required, fixVersions: ticket.fix_versions, url: ticket.url },
    docsStatus: view.status,
    reasons: view.reasons,
    links: view.links.map(linkJson),
    pages: await Promise.all(view.pages.map(async (pg) => ({ pageId: pg.pageId, path: pg.path, title: pg.title, url: await pageUrl(tx, c, p, pg.spaceKey, pg.path), stale: pg.stale }))),
    pullRequests: view.pullRequests,
  };
}

// ---------------------------------------------------------------------------- routes

export const routes: RouteDef[] = [
  // Identity --------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/v1/me",
    operationId: "getMe",
    auth: "token",
    handler: async (c) => {
      const p = c.get("principal");
      const tenant = await inTenant(c, async (tx) => (await tx.query<{ id: string; slug: string; name: string; region: string }>("SELECT id, slug, name, region FROM tenants WHERE id = $1", [p.tenantId])).rows[0]);
      return c.json({
        principalType: p.principalType,
        principalId: p.principalId,
        tenant,
        scopes: p.scopes,
        roles: p.bindings.map((b) => ({ role: b.role, scopeType: b.scopeType, scopeId: b.scopeId })),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/api-tokens",
    operationId: "listApiTokens",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "docs:read", "token.manage", { ownedByPrincipal: true });
      const { after, limit } = pageParams(c);
      const own = !p.bindings.some((b) => b.role === "org_owner" || b.role === "org_admin");
      const rows = await inTenant(c, async (tx) =>
        (
          await tx.query<{ id: string; name: string; token_prefix: string; principal_type: string; scopes: string[]; expires_at: Date | null; last_used_at: Date | null; created_at: Date }>(
            `SELECT id, name, token_prefix, principal_type, scopes, expires_at, last_used_at, created_at FROM api_tokens
             WHERE revoked_at IS NULL AND ($1::uuid IS NULL OR id > $1::uuid) AND (NOT $3 OR principal_id = $4::uuid) ORDER BY id LIMIT $2`,
            [after, limit, own, p.principalId],
          )
        ).rows,
      );
      return c.json({
        items: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.token_prefix, principalType: r.principal_type, scopes: r.scopes, expiresAt: iso(r.expires_at), lastUsedAt: iso(r.last_used_at), createdAt: iso(r.created_at) })),
        nextCursor: nextCursor(rows, limit),
      });
    },
  },
  {
    method: "POST",
    path: "/v1/api-tokens",
    operationId: "createApiToken",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "admin", "token.manage", { ownedByPrincipal: true });
      const body = await jsonBody(c);
      const name = str(body, "name", { required: true, max: 100 }) as string;
      const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
      if (scopes.length === 0) throw badRequest("scopes must be a non-empty array", [{ pointer: "/scopes", message: "is required" }]);
      const escalation = scopes.find((s) => !p.scopes.includes(s) && !p.scopes.includes("admin"));
      if (escalation) throw forbidden(`Cannot grant scope ${escalation} you do not hold`);
      const days = Math.min(365, Math.max(1, Number(body.expiresInDays ?? 90)));
      const created = await inTenant(c, async (tx) => {
        const token = await createApiToken(tx, { tenantId: p.tenantId, principalType: p.principalType, principalId: p.principalId, name, scopes, expiresInDays: days });
        await audit(tx, c, { action: "token.created", resource: { type: "api_token", id: token.id }, outcome: "success", details: { name, scopes } });
        return token;
      });
      return c.json({ id: created.id, name, prefix: created.prefix, principalType: p.principalType, scopes, expiresAt: created.expiresAt, lastUsedAt: null, createdAt: new Date().toISOString(), token: created.secret }, 201);
    },
  },
  {
    method: "DELETE",
    path: "/v1/api-tokens/{tokenId}",
    operationId: "revokeApiToken",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "docs:read", "token.manage", { ownedByPrincipal: true });
      const id = uuidParam(c, "tokenId");
      const admin = p.bindings.some((b) => b.role === "org_owner" || b.role === "org_admin");
      const revoked = await inTenant(c, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND ($2 OR principal_id = $3::uuid) RETURNING id",
          [id, admin, p.principalId],
        );
        if (rows.length > 0) await audit(tx, c, { action: "token.revoked", resource: { type: "api_token", id }, outcome: "success" });
        return rows.length > 0;
      });
      if (!revoked) throw notFound("API token");
      return c.body(null, 204);
    },
  },
  {
    method: "GET",
    path: "/v1/role-bindings",
    operationId: "listRoleBindings",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "space.members");
      const { after, limit } = pageParams(c);
      const rows = await inTenant(c, async (tx) =>
        (
          await tx.query<{ id: string; principal_type: string; principal_id: string; role: string; scope_type: string; scope_id: string | null; created_by: string; created_at: Date }>(
            `SELECT id, principal_type, principal_id, role, scope_type, scope_id, created_by, created_at FROM role_bindings
             WHERE ($1::text IS NULL OR scope_type = $1) AND ($2::uuid IS NULL OR scope_id = $2::uuid) AND ($3::uuid IS NULL OR id > $3::uuid)
             ORDER BY id LIMIT $4`,
            [c.req.query("scopeType") ?? null, c.req.query("scopeId") ?? null, after, limit],
          )
        ).rows,
      );
      return c.json({
        items: rows.map((r) => ({ id: r.id, principalType: r.principal_type, principalId: r.principal_id, role: r.role, scopeType: r.scope_type, scopeId: r.scope_id, createdBy: r.created_by, createdAt: iso(r.created_at) })),
        nextCursor: nextCursor(rows, limit),
      });
    },
  },
  {
    method: "POST",
    path: "/v1/role-bindings",
    operationId: "createRoleBinding",
    auth: "token",
    handler: async (c) => {
      const body = await jsonBody(c);
      const scopeType = oneOf(body.scopeType, ["org", "space", "page"] as const, "scopeType");
      const scopeId = scopeType === "org" ? null : (str(body, "scopeId", { required: true, pattern: UUID }) as string);
      const p = requireAccess(c, "admin", scopeType === "org" ? "org.members" : "space.members", { spaceId: scopeId ?? undefined });
      const role = oneOf(body.role, ROLES, "role") as Role;
      if (role === "org_owner" && !p.bindings.some((b) => b.role === "org_owner")) throw forbidden("Only an org owner can grant org_owner");
      const principalType = oneOf(body.principalType, ["user", "group", "service_account"] as const, "principalType");
      const principalId = str(body, "principalId", { required: true, pattern: UUID }) as string;
      const row = await inTenant(c, async (tx) => {
        const { rows } = await tx.query<{ id: string; created_at: Date }>(
          `INSERT INTO role_bindings (id, tenant_id, principal_type, principal_id, role, scope_type, scope_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id, created_at`,
          [uuidv7(), p.tenantId, principalType, principalId, role, scopeType, scopeId, `${p.principalType}:${p.principalId}`],
        );
        if (!rows[0]) throw conflict("Role binding already exists");
        await audit(tx, c, { action: "role.granted", resource: { type: "role_binding", id: rows[0].id }, outcome: "success", details: { role, scopeType, scopeId, principalType, principalId } });
        return rows[0];
      });
      return c.json({ id: row.id, principalType, principalId, role, scopeType, scopeId, createdBy: `${p.principalType}:${p.principalId}`, createdAt: iso(row.created_at) }, 201);
    },
  },
  {
    method: "DELETE",
    path: "/v1/role-bindings/{bindingId}",
    operationId: "deleteRoleBinding",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "admin", "org.members");
      const id = uuidParam(c, "bindingId");
      const deleted = await inTenant(c, async (tx) => {
        const { rows } = await tx.query<{ id: string }>("DELETE FROM role_bindings WHERE id = $1 RETURNING id", [id]);
        if (rows[0]) await audit(tx, c, { action: "role.revoked", resource: { type: "role_binding", id }, outcome: "success" });
        return rows.length > 0;
      });
      if (!deleted) throw notFound("Role binding");
      return c.body(null, 204);
    },
  },

  // Repositories & snapshots ----------------------------------------------------------------
  {
    method: "GET",
    path: "/v1/repositories",
    operationId: "listRepositories",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const { after, limit } = pageParams(c);
      const rows = await inTenant(c, (tx) => listRepositories(tx, after, limit));
      return c.json({ items: rows.map(repositoryJson), nextCursor: nextCursor(rows, limit) });
    },
  },
  {
    method: "POST",
    path: "/v1/repositories",
    operationId: "connectRepository",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "admin", "integration.manage");
      const body = await jsonBody(c);
      const provider = oneOf(body.provider, ["github", "gitlab", "bitbucket", "azure_devops", "local"] as const, "provider");
      const fullName = str(body, "fullName", { required: true, pattern: /^[^/\s]+\/\S+$/ }) as string;
      const repo = await inTenant(c, async (tx) => {
        if (await findRepository(tx, provider, fullName)) throw conflict(`${fullName} is already connected`);
        const created = await upsertRepository(tx, p.tenantId, { provider, fullName, defaultBranch: str(body, "defaultBranch"), webUrl: str(body, "webUrl"), configPath: str(body, "configPath") });
        await audit(tx, c, { action: "repository.connected", resource: { type: "repository", id: created.id }, outcome: "success", details: { provider, fullName } });
        return created;
      });
      return c.json(repositoryJson(repo), 201);
    },
  },
  {
    method: "GET",
    path: "/v1/repositories/{repositoryId}",
    operationId: "getRepository",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const repo = await inTenant(c, (tx) => getRepository(tx, uuidParam(c, "repositoryId")));
      if (!repo) throw notFound("Repository");
      return c.json(repositoryJson(repo));
    },
  },
  {
    method: "POST",
    path: "/v1/snapshots",
    operationId: "uploadSnapshot",
    auth: "token",
    handler: async (c) => {
      const body = await jsonBody<SnapshotInput & { repository: unknown }>(c);
      if (typeof body.commitSha !== "string" || !Array.isArray(body.pages) || !Array.isArray(body.entities) || typeof body.spaceKey !== "string") {
        throw badRequest("commitSha, spaceKey, pages and entities are required");
      }
      const p = requireAccess(c, "checks:write", "checks.write");
      const deps = c.get("deps");
      const result = await inTenant(c, async (tx) => {
        const repo = await repositoryFor(tx, p, body.repository);
        await deps.blobs.putJson(`snapshots/${p.tenantId}/${repo.id}/${body.commitSha}`, body);
        const ref = body.ref ?? "";
        const isDefault = ref === repo.default_branch || ref === `refs/heads/${repo.default_branch}`;
        if (!isDefault) {
          const space = await getSpace(tx, body.spaceKey);
          return { spaceId: space?.id ?? null, pages: body.pages.length, entities: body.entities.length, references: body.pages.reduce((n, pg) => n + (pg.references?.length ?? 0), 0), changedEntities: 0 };
        }
        const jira = deps.jira?.(p.tenantId);
        const applied = await applySnapshot(tx, p.tenantId, repo.id, body, { jiraSite: jira?.site });
        await audit(tx, c, { action: "snapshot.applied", resource: { type: "repository", id: repo.id }, outcome: "success", details: { commitSha: body.commitSha, pages: applied.pages, changedEntities: applied.changedEntities } });
        return applied;
      });
      return c.json(result, 202);
    },
  },
  {
    method: "GET",
    path: "/v1/repositories/{repositoryId}/snapshots/{commitSha}",
    operationId: "getSnapshot",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "docs:read", "page.read");
      const repoId = uuidParam(c, "repositoryId");
      const sha = c.req.param("commitSha") ?? "";
      if (!/^[0-9a-f]{7,64}$/.test(sha)) throw notFound("Snapshot");
      const repo = await inTenant(c, (tx) => getRepository(tx, repoId));
      if (!repo) throw notFound("Repository");
      const snapshot = await c.get("deps").blobs.getJson(`snapshots/${p.tenantId}/${repoId}/${sha}`);
      if (!snapshot) throw notFound("Snapshot");
      return c.json(snapshot);
    },
  },

  // Content ---------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/v1/spaces",
    operationId: "listSpaces",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const { after, limit } = pageParams(c);
      const rows = await inTenant(c, (tx) => listSpaces(tx, after, limit));
      return c.json({
        items: rows.map((s) => ({ id: s.id, key: s.key, name: s.name, repositoryId: s.repository_id, docsRoot: s.docs_root, defaultAudience: s.default_audience, baseUrl: s.base_url })),
        nextCursor: nextCursor(rows, limit),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/spaces/{spaceId}",
    operationId: "getSpace",
    auth: "token",
    handler: async (c) => {
      const spaceId = uuidParam(c, "spaceId");
      requireAccess(c, "docs:read", "page.read", { spaceId });
      const s = await inTenant(c, (tx) => getSpace(tx, spaceId));
      if (!s) throw notFound("Space");
      return c.json({ id: s.id, key: s.key, name: s.name, repositoryId: s.repository_id, docsRoot: s.docs_root, defaultAudience: s.default_audience, baseUrl: s.base_url });
    },
  },
  {
    method: "GET",
    path: "/v1/spaces/{spaceId}/versions",
    operationId: "listVersions",
    auth: "token",
    handler: async (c) => {
      const spaceId = uuidParam(c, "spaceId");
      requireAccess(c, "docs:read", "page.read", { spaceId });
      const rows = await inTenant(c, async (tx) =>
        (
          await tx.query<{ id: string; name: string; git_ref: string; commit_sha: string; kind: string; status: string; is_default: boolean; published_at: Date | null }>(
            "SELECT id, name, git_ref, commit_sha, kind, status, is_default, published_at FROM versions WHERE space_id = $1 ORDER BY published_at DESC NULLS LAST",
            [spaceId],
          )
        ).rows,
      );
      return c.json({ items: rows.map((v) => ({ id: v.id, name: v.name, gitRef: v.git_ref, commitSha: v.commit_sha, kind: v.kind, status: v.status, isDefault: v.is_default, publishedAt: iso(v.published_at) })) });
    },
  },
  {
    method: "GET",
    path: "/v1/spaces/{spaceId}/pages",
    operationId: "listPages",
    auth: "token",
    handler: async (c) => {
      const spaceId = uuidParam(c, "spaceId");
      requireAccess(c, "docs:read", "page.read", { spaceId });
      const { after, limit } = pageParams(c);
      const rows = await inTenant(c, (tx) => listPages(tx, spaceId, { q: c.req.query("q"), pageType: c.req.query("pageType"), after, limit }));
      return c.json({ items: rows.map((r) => ({ id: r.id, spaceId: r.space_id, path: r.path, slug: r.slug, title: r.title, pageType: r.page_type, audience: r.audience })), nextCursor: nextCursor(rows, limit) });
    },
  },
  {
    method: "GET",
    path: "/v1/pages/{pageId}",
    operationId: "getPage",
    auth: "token",
    handler: async (c) => {
      const pageId = uuidParam(c, "pageId");
      const page = await inTenant(c, (tx) => getPage(tx, pageId));
      if (!page) throw notFound("Page");
      requireAccess(c, "docs:read", "page.read", { spaceId: page.space_id, pageId });
      const fm = page.frontmatter ?? {};
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
      return c.json({
        id: page.id,
        spaceId: page.space_id,
        path: page.path,
        slug: page.slug,
        title: page.title,
        pageType: page.page_type,
        audience: page.audience,
        revision: {
          id: page.revision_id,
          commitSha: page.commit_sha,
          contentHash: page.content_hash,
          frontmatter: fm,
          headings: page.headings,
          wordCount: page.word_count,
          reviewedOn: page.reviewed_on ? new Date(page.reviewed_on).toISOString().slice(0, 10) : null,
          committedAt: iso(page.committed_at),
        },
        owners: list(fm.owners),
        ticketKeys: list(fm.tickets),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/pages/{pageId}/graph",
    operationId: "getPageGraph",
    auth: "token",
    handler: async (c) => {
      const pageId = uuidParam(c, "pageId");
      const result = await inTenant(c, async (tx) => {
        const page = await getPage(tx, pageId);
        if (!page) throw notFound("Page");
        requireAccess(c, "docs:read", "page.read", { spaceId: page.space_id, pageId });
        const refs = await pageReferences(tx, pageId);
        const links = await listLinks(tx, { pageId, limit: 200 });
        const tickets = [];
        for (const key of [...new Set(links.map((l) => l.ticket_key))]) {
          const t = await getTicketByKey(tx, key);
          if (t) tickets.push({ key: t.key, title: t.title, docsStatus: t.docs_status, linkSource: links.find((l) => l.ticket_key === key)?.source, url: t.url });
        }
        const fm = page.frontmatter ?? {};
        return {
          page: { id: page.id, spaceId: page.space_id, path: page.path, slug: page.slug, title: page.title, pageType: page.page_type, audience: page.audience },
          entities: refs.map((r) => ({ key: r.key, kind: r.kind, referenceKind: r.reference_kind, line: r.line, stale: r.stale })),
          tickets,
          owners: Array.isArray(fm.owners) ? fm.owners : [],
        };
      });
      return c.json(result);
    },
  },
  {
    method: "GET",
    path: "/v1/spaces/{spaceId}/coverage",
    operationId: "getCoverage",
    auth: "token",
    handler: async (c) => {
      const spaceId = uuidParam(c, "spaceId");
      requireAccess(c, "docs:read", "page.read", { spaceId });
      const kind = c.req.query("kind");
      const { rows, undocumented } = await inTenant(c, async (tx) => ({
        rows: await coverageForSpace(tx, spaceId, kind),
        undocumented: (await listEntities(tx, { spaceId, kind, documented: false, limit: 200 })).filter((e) => e.visibility === "public"),
      }));
      const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 1000) / 10);
      const counts = (r: { public_entities: number; documented_l1: number; documented_l2: number }) => ({
        publicEntities: r.public_entities,
        documentedL1: r.documented_l1,
        documentedL2: r.documented_l2,
        percentL1: pct(r.documented_l1, r.public_entities),
        percentL2: pct(r.documented_l2, r.public_entities),
      });
      const total = rows.reduce((a, r) => ({ public_entities: a.public_entities + r.public_entities, documented_l1: a.documented_l1 + r.documented_l1, documented_l2: a.documented_l2 + r.documented_l2 }), { public_entities: 0, documented_l1: 0, documented_l2: 0 });
      return c.json({
        spaceId,
        version: "latest",
        generatedAt: new Date().toISOString(),
        totals: counts(total),
        byKind: rows.map((r) => ({ kind: r.kind, ...counts(r) })),
        undocumented: undocumented.map((e) => ({ key: e.key, kind: e.kind })),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/entities",
    operationId: "listEntities",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const { after, limit } = pageParams(c);
      const documented = c.req.query("documented");
      const spaceId = c.req.query("spaceId");
      if (spaceId && !UUID.test(spaceId)) throw badRequest("spaceId must be a uuid");
      const rows = await inTenant(c, (tx) =>
        listEntities(tx, { spaceId, kind: c.req.query("kind"), q: c.req.query("q"), documented: documented === undefined ? undefined : documented === "true", after, limit }),
      );
      return c.json({
        items: rows.map((e) => ({ id: e.id, key: e.key, kind: e.kind, name: e.name, sourceKey: e.source_key, parentKey: e.parent_key, visibility: e.visibility, fingerprint: e.fingerprint, attributes: e.attributes, documented: e.documented })),
        nextCursor: nextCursor(rows, limit),
      });
    },
  },
  {
    method: "GET",
    path: "/v1/entities/{entityId}",
    operationId: "getEntity",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const id = uuidParam(c, "entityId");
      const result = await inTenant(c, async (tx) => {
        const [e] = await listEntities(tx, { id, limit: 1 });
        if (!e) throw notFound("Entity");
        const refs = await entityReferencedBy(tx, id);
        return {
          id: e.id, key: e.key, kind: e.kind, name: e.name, sourceKey: e.source_key, parentKey: e.parent_key, visibility: e.visibility, fingerprint: e.fingerprint, attributes: e.attributes, documented: e.documented,
          referencedBy: refs.map((r) => ({ pageId: r.page_id, path: r.path, kind: r.kind, line: r.line, stale: r.stale })),
        };
      });
      return c.json(result);
    },
  },

  // Checks ----------------------------------------------------------------------------------
  {
    method: "POST",
    path: "/v1/check-runs",
    operationId: "createCheckRun",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "checks:write", "checks.write");
      const body = await jsonBody(c);
      const headSha = str(body, "headSha", { required: true, pattern: /^[0-9a-f]{7,64}$/ }) as string;
      const conclusion = oneOf(body.conclusion, ["success", "neutral", "failure", "skipped"] as const, "conclusion");
      const findings = Array.isArray(body.findings) ? (body.findings as Finding[]) : [];
      if (findings.length > 5000) throw badRequest("at most 5000 findings per check run");
      findings.forEach((f, i) => {
        if (typeof f?.ruleId !== "string" || typeof f.message !== "string" || typeof f.fingerprint !== "string" || !["info", "warning", "error"].includes(f.severity)) {
          throw badRequest("invalid finding", [{ pointer: `/findings/${i}`, message: "ruleId, severity, message and fingerprint are required" }]);
        }
      });
      const summary = (body.summary ?? {}) as Record<string, unknown>;
      const out = await inTenant(c, async (tx) => {
        const repo = await repositoryFor(tx, p, body.repository);
        const prNumber = typeof body.pullRequestNumber === "number" ? body.pullRequestNumber : null;
        const run = await recordCheckRun(tx, p.tenantId, {
          repositoryId: repo.id,
          pullRequestNumber: prNumber,
          headSha,
          baseSha: typeof body.baseSha === "string" ? body.baseSha : null,
          ref: str(body, "ref"),
          cliVersion: str(body, "cliVersion"),
          rulesetHash: str(body, "rulesetHash"),
          conclusion,
          summary,
          findings: findings.map((f) => ({ ...f, origin: f.origin ?? "deterministic", evidence: f.evidence ?? {} })),
        });
        const json = {
          id: run.id, repositoryId: repo.id, headSha, baseSha: body.baseSha ?? null, pullRequestNumber: prNumber, source: "cli", conclusion, summary,
          findingsCount: findings.length, dismissedFingerprints: run.dismissed, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        };
        await writeOutbox(tx, event(p.tenantId, "docops.check.completed", json, `repositories/${repo.id}/check-runs/${run.id}`), `${p.tenantId}:${repo.id}`);
        if (findings.some((f) => f.category === "drift")) {
          await writeOutbox(tx, event(p.tenantId, "docops.drift.detected", { checkRunId: run.id, repository: repo.full_name, pullRequestNumber: prNumber, findings: findings.filter((f) => f.category === "drift") }), `${p.tenantId}:${repo.id}`);
        }
        await audit(tx, c, { action: "check.recorded", resource: { type: "check_run", id: run.id }, outcome: "success", details: { conclusion, findings: findings.length, headSha } });
        return json;
      });
      return c.json(out, 201);
    },
  },
  {
    method: "GET",
    path: "/v1/check-runs/{checkRunId}",
    operationId: "getCheckRun",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const id = uuidParam(c, "checkRunId");
      const out = await inTenant(c, async (tx) => {
        const run = await getCheckRun(tx, id);
        if (!run) throw notFound("Check run");
        const findings = await listFindings(tx, { checkRunId: id, limit: 200 });
        return {
          id: run.id, repositoryId: run.repository_id, headSha: run.head_sha, baseSha: run.base_sha, pullRequestNumber: run.pull_request_number, source: run.source,
          conclusion: run.conclusion, summary: run.summary, findingsCount: findings.length, startedAt: iso(run.started_at), completedAt: iso(run.completed_at),
          findings: findings.map(findingJson),
        };
      });
      return c.json(out);
    },
  },
  {
    method: "GET",
    path: "/v1/findings",
    operationId: "listFindings",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const { after, limit } = pageParams(c);
      const repositoryId = c.req.query("repositoryId");
      if (repositoryId && !UUID.test(repositoryId)) throw badRequest("repositoryId must be a uuid");
      const rows = await inTenant(c, (tx) =>
        listFindings(tx, { repositoryId, status: c.req.query("status"), category: c.req.query("category"), severity: c.req.query("severity"), after, limit }),
      );
      return c.json({ items: rows.map(findingJson), nextCursor: nextCursor(rows, limit) });
    },
  },
  {
    method: "POST",
    path: "/v1/findings/{findingId}/dismiss",
    operationId: "dismissFinding",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "docs:write", "finding.dismiss");
      const id = uuidParam(c, "findingId");
      const body = await jsonBody(c);
      const reason = oneOf(body.reason, ["false_positive", "wont_fix", "not_applicable", "other"] as const, "reason");
      const note = str(body, "note", { max: 2000 });
      const state = await inTenant(c, async (tx) => {
        const s = await dismissFinding(tx, id, { reason, note, actor: `${p.principalType}:${p.principalId}` });
        if (!s) throw notFound("Finding");
        await audit(tx, c, { action: "finding.dismissed", resource: { type: "finding", id }, outcome: "success", reason, details: { fingerprint: s.fingerprint, ruleId: s.rule_id, note } });
        return s;
      });
      return c.json({ fingerprint: state.fingerprint, status: state.status, dismissedBy: state.dismissed_by, dismissalReason: state.dismissal_reason, dismissalNote: state.dismissal_note });
    },
  },

  // Builds & deployments --------------------------------------------------------------------
  {
    method: "POST",
    path: "/v1/builds",
    operationId: "createBuild",
    auth: "token",
    handler: async (c) => {
      const body = await jsonBody(c);
      const kind = oneOf(body.kind, ["preview", "branch", "release"] as const, "kind");
      const p = requireAccess(c, "builds:write", kind === "preview" ? "preview.publish" : "deployment.promote.nonprod");
      const spaceKey = str(body, "spaceKey", { required: true, pattern: /^[a-z0-9][a-z0-9-]{1,62}$/ }) as string;
      const files = ((body.manifest as { files?: unknown } | undefined)?.files ?? []) as Array<{ path: string; digest: string; size: number; contentType: string }>;
      if (!Array.isArray(files) || files.length === 0 || files.length > 100_000) throw badRequest("manifest.files must contain 1..100000 entries");
      files.forEach((f, i) => {
        if (typeof f.path !== "string" || f.path.includes("..") || f.path.startsWith("/") || !/^[a-f0-9]{64}$/.test(String(f.digest)) || typeof f.size !== "number" || typeof f.contentType !== "string") {
          throw badRequest("invalid manifest entry", [{ pointer: `/manifest/files/${i}`, message: "path, digest (sha256), size and contentType are required; no absolute or parent paths" }]);
        }
      });
      const stats = (body.stats ?? {}) as { pageCount?: number; cachedPages?: number };
      const out = await inTenant(c, async (tx) => {
        let space = await getSpace(tx, spaceKey);
        if (!space) {
          await tx.query("INSERT INTO spaces (id, tenant_id, key, name) VALUES ($1,$2,$3,$3)", [uuidv7(), p.tenantId, spaceKey]);
          space = await getSpace(tx, spaceKey);
        }
        const { build, missing } = await createBuild(tx, p.tenantId, {
          spaceId: space!.id,
          versionName: str(body, "versionName", { max: 64 }) ?? "latest",
          audience: str(body, "audience", { max: 32 }) ?? "internal",
          commitSha: str(body, "commitSha", { required: true, pattern: /^[0-9a-f]{7,64}$/ }) as string,
          ref: str(body, "ref"),
          pullRequestNumber: typeof body.pullRequestNumber === "number" ? body.pullRequestNumber : null,
          kind,
          files,
          pageCount: stats.pageCount,
          cachedPages: stats.cachedPages,
          createdBy: `${p.principalType}:${p.principalId}`,
          manifestDigest: manifestDigest(files),
        });
        await audit(tx, c, { action: "build.created", resource: { type: "build", id: build.id }, outcome: "success", details: { kind, files: files.length, missing: missing.length } });
        return { build: buildJson(build), missingDigests: missing };
      });
      return c.json(out, 201);
    },
  },
  {
    method: "PUT",
    path: "/v1/blobs/{digest}",
    operationId: "uploadBlob",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "builds:write", "preview.publish");
      const digest = c.req.param("digest") ?? "";
      if (!/^[a-f0-9]{64}$/.test(digest)) throw badRequest("digest must be a sha256 hex string");
      const deps = c.get("deps");
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > deps.config.maxBlobBytes) return c.json({ type: "https://docs.docops.example/errors/too-large", title: "Blob exceeds the size limit", status: 413 }, 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > deps.config.maxBlobBytes) return c.json({ type: "https://docs.docops.example/errors/too-large", title: "Blob exceeds the size limit", status: 413 }, 413);
      await deps.blobs.put(p.tenantId, digest, bytes);
      const created = await inTenant(c, (tx) => recordBlob(tx, p.tenantId, digest, bytes.byteLength, c.req.header("content-type") ?? "application/octet-stream"));
      return c.body(null, created ? 201 : 200);
    },
  },
  {
    method: "GET",
    path: "/v1/builds/{buildId}",
    operationId: "getBuild",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const b = await inTenant(c, (tx) => getBuild(tx, uuidParam(c, "buildId")));
      if (!b) throw notFound("Build");
      return c.json(buildJson(b));
    },
  },
  {
    method: "POST",
    path: "/v1/builds/{buildId}/finalize",
    operationId: "finalizeBuild",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "builds:write", "preview.publish");
      const id = uuidParam(c, "buildId");
      const deps = c.get("deps");
      const out = await inTenant(c, async (tx) => {
        const build = await getBuild(tx, id);
        if (!build) throw notFound("Build");
        const missing = await missingBlobsForBuild(tx, id);
        if (missing.length > 0) throw new DocOpsError("blobs_missing", `${missing.length} blob(s) not uploaded yet`, 409);
        const space = await getSpace(tx, build.space_id);
        let previewUrl: string | null = null;
        if (build.kind === "preview") {
          const env = build.pull_request_number ? `preview-pr-${build.pull_request_number}` : `preview-${build.commit_sha.slice(0, 7)}`;
          const token = previewToken(deps.config.previewSecret, `${p.tenantSlug}/${space!.key}/${env}`);
          previewUrl = `${siteUrl(c, p, space!.key, env)}?pt=${encodeURIComponent(token)}`;
          const finalized = await finalizeBuild(tx, id, { signature: deps.signer.sign(build.manifest_digest ?? ""), previewUrl });
          await promoteBuild(tx, p.tenantId, finalized!, { environment: env, promotedBy: `${p.principalType}:${p.principalId}`, url: previewUrl });
          await writeOutbox(tx, event(p.tenantId, "docops.preview.ready", { buildId: id, repository: space!.key, pullRequestNumber: build.pull_request_number, url: previewUrl }), `${p.tenantId}:${space!.id}`);
        }
        const ready = previewUrl ? await getBuild(tx, id) : await finalizeBuild(tx, id, { signature: deps.signer.sign(build.manifest_digest ?? ""), previewUrl: null });
        await writeOutbox(tx, event(p.tenantId, "docops.build.succeeded", buildJson(ready!)), `${p.tenantId}:${build.space_id}`);
        await audit(tx, c, { action: "build.finalized", resource: { type: "build", id }, outcome: "success", details: { manifestDigest: build.manifest_digest } });
        return buildJson(ready!);
      });
      return c.json(out);
    },
  },
  {
    method: "GET",
    path: "/v1/deployments",
    operationId: "listDeployments",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const spaceId = c.req.query("spaceId");
      if (spaceId && !UUID.test(spaceId)) throw badRequest("spaceId must be a uuid");
      const rows = await inTenant(c, (tx) => listDeployments(tx, { spaceId, environment: c.req.query("environment"), status: c.req.query("status") }));
      return c.json({ items: rows.map(deploymentJson) });
    },
  },
  {
    method: "POST",
    path: "/v1/deployments",
    operationId: "createDeployment",
    auth: "token",
    handler: async (c) => {
      const body = await jsonBody(c);
      const environment = str(body, "environment", { required: true, pattern: /^[a-z][a-z0-9-]{0,40}$/ }) as string;
      const buildId = str(body, "buildId", { required: true, pattern: UUID }) as string;
      const isProd = environment === "prod" || environment === "production";
      const p = requireAccess(c, "deployments:write", isProd ? "deployment.promote.prod" : "deployment.promote.nonprod");
      if (p.environments && p.environments.length > 0 && !p.environments.includes(environment)) throw forbidden(`This token may not deploy to ${environment}`);
      const deps = c.get("deps");
      const out = await inTenant(c, async (tx) => {
        const build = await getBuild(tx, buildId);
        if (!build) throw notFound("Build");
        if (build.status !== "ready") throw conflict("Build is not finalized");
        // Threat T07: only a build whose manifest signature verifies can be promoted.
        if (!deps.signer.verify(build.manifest_digest ?? "", build.signature)) {
          await audit(tx, c, { action: "deployment.promoted", resource: { type: "build", id: buildId }, outcome: "denied", reason: "signature verification failed" });
          throw new DocOpsError("signature_invalid", "Build signature does not verify; refusing to promote", 409);
        }
        const space = await getSpace(tx, build.space_id);
        const deployment = await promoteBuild(tx, p.tenantId, build, {
          environment,
          promotedBy: `${p.principalType}:${p.principalId}`,
          approvedBy: str(body, "approvedBy") ?? null,
          url: siteUrl(c, p, space!.key, environment),
        });
        await writeOutbox(tx, event(p.tenantId, "docops.deployment.promoted", deploymentJson(deployment), `spaces/${space!.key}/environments/${environment}`), `${p.tenantId}:${space!.id}`);
        await audit(tx, c, { action: "deployment.promoted", resource: { type: "deployment", id: deployment.id }, outcome: "success", details: { buildId, environment, manifestDigest: build.manifest_digest } });
        return deploymentJson(deployment);
      });
      return c.json(out, 201);
    },
  },

  // Tracker ---------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/v1/tickets/{ticketKey}/docs",
    operationId: "getTicketDocs",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "readiness:read", "readiness.read");
      const key = c.req.param("ticketKey") ?? "";
      if (!KEY.test(key)) throw notFound("Ticket");
      const out = await inTenant(c, async (tx, p) => {
        const ticket = await resolveTicket(tx, c, p, key);
        if (!ticket) throw notFound("Ticket");
        return ticketDocsJson(tx, c, p, ticket);
      });
      return c.json(out);
    },
  },
  {
    method: "GET",
    path: "/v1/links",
    operationId: "listLinks",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "readiness:read", "readiness.read");
      const { after, limit } = pageParams(c);
      const pageId = c.req.query("pageId");
      if (pageId && !UUID.test(pageId)) throw badRequest("pageId must be a uuid");
      const rows = await inTenant(c, (tx) => listLinks(tx, { ticketKey: c.req.query("ticketKey"), pageId, after, limit }));
      return c.json({ items: rows.map(linkJson), nextCursor: nextCursor(rows, limit) });
    },
  },
  {
    method: "POST",
    path: "/v1/links",
    operationId: "createLink",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "links:write", "link.manage");
      const body = await jsonBody(c);
      const ticketKey = str(body, "ticketKey", { required: true, pattern: KEY }) as string;
      const targetType = oneOf(body.targetType, ["page", "pull_request", "release", "entity"] as const, "targetType");
      const out = await inTenant(c, async (tx) => {
        let targetId = str(body, "targetId", { pattern: UUID }) ?? null;
        if (targetType === "page" && !targetId) {
          const spaceKey = str(body, "spaceKey", { required: true }) as string;
          const pagePath = str(body, "pagePath", { required: true }) as string;
          const page = await findPageByPath(tx, spaceKey, pagePath);
          if (!page) throw notFound(`Page ${spaceKey}/${pagePath}`);
          targetId = page.id;
        }
        if (!targetId) throw badRequest("targetId is required", [{ pointer: "/targetId", message: "is required" }]);
        const ticket = (await resolveTicket(tx, c, p, ticketKey)) ?? (await getTicketByKey(tx, ticketKey));
        const ticketId = ticket?.id ?? (await ensureTicketStub(tx, p.tenantId, ticketKey, c.get("deps").jira?.(p.tenantId)?.site ?? "jira.local"));
        const source = p.authMethod === "forge_fit" ? "tracker_panel" : "api";
        const id = await createLink(tx, p.tenantId, { ticketId, targetType, targetId, source, createdBy: `${p.principalType}:${p.principalId}` });
        await writeOutbox(tx, event(p.tenantId, "docops.ticket.links_changed", { ticketKey }, `tickets/${ticketKey}`), `${p.tenantId}:${ticketKey}`);
        await audit(tx, c, { action: "link.created", resource: { type: "ticket_link", id }, outcome: "success", details: { ticketKey, targetType, targetId, source } });
        const [link] = await listLinks(tx, { id, limit: 1 });
        return linkJson(link!);
      });
      return c.json(out, 201);
    },
  },
  {
    method: "DELETE",
    path: "/v1/links/{linkId}",
    operationId: "deleteLink",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "links:write", "link.manage");
      const id = uuidParam(c, "linkId");
      const result = await inTenant(c, async (tx, p) => {
        const [link] = await listLinks(tx, { id, limit: 1 });
        const outcome = await deleteLink(tx, id);
        if (outcome === "deleted" && link) {
          await writeOutbox(tx, event(p.tenantId, "docops.ticket.links_changed", { ticketKey: link.ticket_key }), `${p.tenantId}:${link.ticket_key}`);
          await audit(tx, c, { action: "link.deleted", resource: { type: "ticket_link", id }, outcome: "success" });
        }
        return outcome;
      });
      if (result === "not_found") throw notFound("Link");
      if (result === "derived") throw new DocOpsError("link_derived", "This link comes from Git (frontmatter, PR or commit); change the source instead", 409);
      return c.body(null, 204);
    },
  },
  {
    method: "GET",
    path: "/v1/readiness",
    operationId: "getReadiness",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "readiness:read", "readiness.read");
      const project = c.req.query("project") ?? "";
      const fixVersion = c.req.query("fixVersion") ?? "";
      if (!/^[A-Z][A-Z0-9_]+$/.test(project) || !fixVersion) throw badRequest("project and fixVersion are required");
      const tracker = c.req.query("tracker") ?? "jira";
      const out = await inTenant(c, async (tx, p) => {
        // Refresh the mirror from Jira when an integration is configured (≤60 s staleness in production via webhooks).
        const jira = c.get("deps").jira?.(p.tenantId);
        let dataAsOf = new Date().toISOString();
        if (jira) {
          for (const issue of await jira.searchJql(fixVersionJql(project, fixVersion), ["summary", "status", "issuetype", "fixVersions", "labels", "parent", "updated"])) {
            await upsertTicket(tx, p.tenantId, ticketFromIssue(issue, jira.site, { issueTypes: ["Story", "Bug"] }));
          }
        } else {
          const { rows } = await tx.query<{ synced_at: Date | null }>("SELECT min(synced_at) AS synced_at FROM tickets WHERE project_key = $1", [project]);
          dataAsOf = iso(rows[0]?.synced_at) ?? dataAsOf;
        }
        const { summary, items } = await readinessForFixVersion(tx, project, fixVersion);
        return {
          tracker,
          project,
          fixVersion,
          generatedAt: new Date().toISOString(),
          dataAsOf,
          summary,
          items: items.map(({ view }) => ({
            ticketKey: view.ticket.key,
            title: view.ticket.title,
            issueType: view.ticket.issue_type,
            status: view.ticket.status,
            docsRequired: view.ticket.docs_required,
            docsStatus: view.status,
            reasons: view.reasons,
            pages: view.pages.map((pg) => pg.path),
            pullRequests: view.pullRequests.map((pr) => pr.number),
            url: view.ticket.url,
          })),
        };
      });
      return c.json(out);
    },
  },
  {
    method: "POST",
    path: "/v1/readiness/doc-tasks",
    operationId: "createDocTasks",
    auth: "token",
    handler: async (c) => {
      const p = requireAccess(c, "links:write", "readiness.doc_tasks");
      const body = await jsonBody(c);
      const project = str(body, "project", { required: true, pattern: /^[A-Z][A-Z0-9_]+$/ }) as string;
      const fixVersion = str(body, "fixVersion", { required: true, max: 100 }) as string;
      const jira = c.get("deps").jira?.(p.tenantId);
      if (!jira) throw new DocOpsError("integration_missing", "No Jira integration is configured for this tenant", 409);
      const requested = Array.isArray(body.ticketKeys) ? body.ticketKeys.filter((k): k is string => typeof k === "string" && KEY.test(k)) : null;
      const out = await inTenant(c, async (tx) => {
        const { items } = await readinessForFixVersion(tx, project, fixVersion);
        const created: Array<{ parentKey: string; key: string; url: string }> = [];
        const skipped: Array<{ parentKey: string; reason: string }> = [];
        for (const { view } of items) {
          const key = view.ticket.key;
          if (requested ? !requested.includes(key) : view.status !== "missing") continue;
          if (view.status !== "missing") {
            skipped.push({ parentKey: key, reason: `docs status is ${view.status}` });
            continue;
          }
          if (!(await markProcessed(tx, "doc-task", `${p.tenantId}:${key}:${fixVersion}`))) {
            skipped.push({ parentKey: key, reason: "a doc task was already created" });
            continue;
          }
          const task = await jira.createIssue(docTaskFields({ key, summary: view.ticket.title }, project, str(body, "issueType") ?? "Sub-task"));
          created.push({ parentKey: key, key: task.key, url: `https://${jira.site}/browse/${task.key}` });
        }
        await audit(tx, c, { action: "readiness.doc_tasks_created", resource: { type: "fix_version", id: `${project}/${fixVersion}` }, outcome: "success", details: { created: created.map((x) => x.key), skipped: skipped.length } });
        return { created, skipped };
      });
      return c.json(out);
    },
  },

  // AI suggestions (decisions only; generation runs in workers) -----------------------------
  {
    method: "GET",
    path: "/v1/suggestions",
    operationId: "listSuggestions",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const { after, limit } = pageParams(c);
      const rows = await inTenant(c, async (tx) => (await tx.query<SuggestionRow>(`${SUGGESTION_SELECT} WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2) AND ($3::uuid IS NULL OR id > $3::uuid) ORDER BY id LIMIT $4`, [c.req.query("status") ?? null, c.req.query("kind") ?? null, after, limit])).rows);
      return c.json({ items: rows.map(suggestionJson), nextCursor: nextCursor(rows, limit) });
    },
  },
  {
    method: "GET",
    path: "/v1/suggestions/{suggestionId}",
    operationId: "getSuggestion",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "docs:read", "page.read");
      const id = uuidParam(c, "suggestionId");
      const row = await inTenant(c, async (tx) => (await tx.query<SuggestionRow>(`${SUGGESTION_SELECT} WHERE id = $1`, [id])).rows[0]);
      if (!row) throw notFound("Suggestion");
      return c.json(suggestionJson(row));
    },
  },
  { method: "POST", path: "/v1/suggestions/{suggestionId}/accept", operationId: "acceptSuggestion", auth: "token", handler: (c) => decideSuggestion(c, "accept") },
  { method: "POST", path: "/v1/suggestions/{suggestionId}/reject", operationId: "rejectSuggestion", auth: "token", handler: (c) => decideSuggestion(c, "reject") },

  // Governance ------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/v1/audit-events",
    operationId: "listAuditEvents",
    auth: "token",
    handler: async (c) => {
      requireAccess(c, "audit:read", "audit.read");
      const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
      const cursor = c.req.query("cursor");
      const afterSeq = cursor ? Number(Buffer.from(cursor, "base64url").toString()) : undefined;
      const records = await inTenant(c, (tx) =>
        listAudit(tx, { action: c.req.query("action"), actorId: c.req.query("actorId"), resourceType: c.req.query("resourceType"), since: c.req.query("since"), until: c.req.query("until"), afterSeq, limit }),
      );
      const contiguous = !c.req.query("action") && !c.req.query("actorId") && !c.req.query("resourceType");
      const broken = contiguous ? verifyAuditChain(records) : null;
      return c.json({
        items: records,
        nextCursor: records.length === limit ? Buffer.from(String(records[records.length - 1]!.seq)).toString("base64url") : null,
        chain: { verified: contiguous ? broken === null : false, firstBrokenSeq: broken },
      });
    },
  },
];

// ---------------------------------------------------------------------------- suggestions helpers

interface SuggestionRow {
  id: string;
  kind: string;
  status: string;
  finding_id: string | null;
  page_id: string | null;
  patch: string | null;
  output: Record<string, unknown>;
  confidence: string | number | null;
  provider: string;
  model: string;
  prompt_template: string;
  prompt_version: string;
  input_refs: Array<{ type: string; id: string; contentHash: string }>;
  validation: Record<string, unknown>;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
}

const SUGGESTION_SELECT = `SELECT id, kind, status, finding_id, page_id, patch, output, confidence, provider, model, prompt_template, prompt_version,
  input_refs, validation, created_at, decided_by, decided_at FROM ai_suggestions`;

function suggestionJson(r: SuggestionRow) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    findingId: r.finding_id,
    pageId: r.page_id,
    pullRequestNumber: null,
    patch: r.patch,
    output: r.output,
    confidence: r.confidence === null ? null : Number(r.confidence),
    provenance: { provider: r.provider, model: r.model, promptTemplate: r.prompt_template, promptVersion: r.prompt_version, inputs: r.input_refs },
    validation: r.validation,
    createdAt: iso(r.created_at),
    decidedBy: r.decided_by,
    decidedAt: iso(r.decided_at),
  };
}

async function decideSuggestion(c: Ctx, decision: "accept" | "reject"): Promise<Response> {
  const p = requireAccess(c, "docs:write", "suggestion.decide");
  const id = uuidParam(c, "suggestionId");
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const edited = typeof body.editedPatch === "string" && body.editedPatch.length > 0;
  const status = decision === "reject" ? "rejected" : edited ? "edited" : "accepted";
  const row = await inTenant(c, async (tx) => {
    const { rows } = await tx.query<SuggestionRow>(
      `UPDATE ai_suggestions SET status = $2, decided_by = $3, decided_at = now(), patch = COALESCE($4, patch)
       WHERE id = $1 AND status = 'proposed' RETURNING id, kind, status, finding_id, page_id, patch, output, confidence, provider, model,
       prompt_template, prompt_version, input_refs, validation, created_at, decided_by, decided_at`,
      [id, status, `${p.principalType}:${p.principalId}`, edited ? body.editedPatch : null],
    );
    if (!rows[0]) {
      const exists = (await tx.query("SELECT 1 FROM ai_suggestions WHERE id = $1", [id])).rows.length > 0;
      if (exists) throw conflict("Suggestion was already decided");
      throw notFound("Suggestion");
    }
    await writeOutbox(tx, event(p.tenantId, "docops.suggestion.decided", suggestionJson(rows[0])), `${p.tenantId}:${id}`);
    await audit(tx, c, { action: decision === "reject" ? "ai.suggestion_rejected" : "ai.suggestion_accepted", resource: { type: "ai_suggestion", id }, outcome: "success", details: { status, note: typeof body.note === "string" ? body.note.slice(0, 500) : null } });
    return rows[0];
  });
  return c.json(suggestionJson(row));
}
