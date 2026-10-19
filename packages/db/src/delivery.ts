import { uuidv7, type Finding } from "@docops/core";
import type { Queryable } from "./client.ts";

// ---------------------------------------------------------------------------- check runs & findings

export interface CheckRunInput {
  repositoryId: string;
  pullRequestNumber?: number | null | undefined;
  headSha: string;
  baseSha?: string | null | undefined;
  ref?: string | undefined;
  cliVersion?: string | undefined;
  rulesetHash?: string | undefined;
  conclusion: "success" | "neutral" | "failure" | "skipped";
  summary: Record<string, unknown>;
  findings: Finding[];
}

export interface CheckRunRow {
  id: string;
  repository_id: string;
  pull_request_number: number | null;
  head_sha: string;
  base_sha: string | null;
  source: string;
  conclusion: string;
  summary: Record<string, unknown>;
  started_at: Date;
  completed_at: Date | null;
}

/** Record a run and update the finding lifecycle; returns fingerprints dismissed earlier (suppressed by the CLI). */
export async function recordCheckRun(tx: Queryable, tenantId: string, input: CheckRunInput): Promise<{ id: string; dismissed: string[]; findingIds: string[] }> {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO check_runs (id, tenant_id, repository_id, pull_request_number, head_sha, base_sha, ref, source, cli_version, ruleset_hash, status, conclusion, summary, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'cli',$8,$9,'completed',$10,$11::jsonb,now())`,
    [id, tenantId, input.repositoryId, input.pullRequestNumber ?? null, input.headSha, input.baseSha ?? null, input.ref ?? null, input.cliVersion ?? null, input.rulesetHash ?? null, input.conclusion, JSON.stringify(input.summary)],
  );
  const findingIds: string[] = [];
  for (const f of input.findings) {
    const findingId = uuidv7();
    findingIds.push(findingId);
    await tx.query(
      `INSERT INTO findings (id, tenant_id, check_run_id, rule_id, category, severity, origin, message, file_path, line, end_line, entity_key, evidence, suggestion, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
      [findingId, tenantId, id, f.ruleId, f.category, f.severity, f.origin, f.message, f.file ?? null, f.line ?? null, f.endLine ?? null, f.entityKey ?? null, JSON.stringify(f.evidence ?? {}), f.suggestion ? JSON.stringify(f.suggestion) : null, f.fingerprint],
    );
    await tx.query(
      `INSERT INTO finding_states (tenant_id, repository_id, fingerprint, rule_id, introduced_sha)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, repository_id, fingerprint) DO UPDATE SET last_seen_at = now(),
         status = CASE WHEN finding_states.status = 'fixed' THEN 'open' ELSE finding_states.status END`,
      [tenantId, input.repositoryId, f.fingerprint, f.ruleId, input.headSha],
    );
  }
  const { rows } = await tx.query<{ fingerprint: string }>(
    "SELECT fingerprint FROM finding_states WHERE repository_id = $1 AND status IN ('dismissed','accepted_risk') AND fingerprint = ANY($2::text[])",
    [input.repositoryId, input.findings.map((f) => f.fingerprint)],
  );
  return { id, dismissed: rows.map((r) => r.fingerprint), findingIds };
}

export async function getCheckRun(tx: Queryable, id: string) {
  const { rows } = await tx.query<CheckRunRow>("SELECT id, repository_id, pull_request_number, head_sha, base_sha, source, conclusion, summary, started_at, completed_at FROM check_runs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export interface FindingRow {
  id: string;
  check_run_id: string;
  rule_id: string;
  category: string;
  severity: string;
  origin: string;
  message: string;
  file_path: string | null;
  line: number | null;
  end_line: number | null;
  entity_key: string | null;
  evidence: Record<string, unknown>;
  suggestion: Record<string, unknown> | null;
  fingerprint: string;
  state: string | null;
  dismissed_by: string | null;
  dismissal_reason: string | null;
  dismissal_note: string | null;
}

export async function listFindings(
  tx: Queryable,
  filters: { checkRunId?: string; repositoryId?: string; status?: string; category?: string; severity?: string; after?: string | null; limit: number },
): Promise<FindingRow[]> {
  const { rows } = await tx.query<FindingRow>(
    `SELECT f.id, f.check_run_id, f.rule_id, f.category, f.severity, f.origin, f.message, f.file_path, f.line, f.end_line, f.entity_key,
            f.evidence, f.suggestion, f.fingerprint, s.status AS state, s.dismissed_by, s.dismissal_reason, s.dismissal_note
     FROM findings f
     JOIN check_runs c ON c.id = f.check_run_id
     LEFT JOIN finding_states s ON s.repository_id = c.repository_id AND s.fingerprint = f.fingerprint
     WHERE ($1::uuid IS NULL OR f.check_run_id = $1::uuid)
       AND ($2::uuid IS NULL OR c.repository_id = $2::uuid)
       AND ($3::text IS NULL OR s.status = $3)
       AND ($4::text IS NULL OR f.category = $4)
       AND ($5::text IS NULL OR f.severity = $5)
       AND ($6::uuid IS NULL OR f.id > $6::uuid)
     ORDER BY f.id LIMIT $7`,
    [filters.checkRunId ?? null, filters.repositoryId ?? null, filters.status ?? null, filters.category ?? null, filters.severity ?? null, filters.after ?? null, filters.limit],
  );
  return rows;
}

export async function dismissFinding(tx: Queryable, findingId: string, input: { reason: string; note?: string | undefined; actor: string }) {
  const { rows } = await tx.query<{ fingerprint: string; status: string; dismissed_by: string; dismissal_reason: string; dismissal_note: string | null; rule_id: string }>(
    `UPDATE finding_states s SET status = 'dismissed', dismissed_by = $2, dismissal_reason = $3, dismissal_note = $4, resolved_at = now()
     FROM findings f JOIN check_runs c ON c.id = f.check_run_id
     WHERE f.id = $1 AND s.repository_id = c.repository_id AND s.fingerprint = f.fingerprint
     RETURNING s.fingerprint, s.status, s.dismissed_by, s.dismissal_reason, s.dismissal_note, s.rule_id`,
    [findingId, input.actor, input.reason, input.note ?? null],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------- builds, blobs, deployments

export interface BuildRow {
  id: string;
  space_id: string;
  version_name: string;
  audience: string;
  commit_sha: string;
  kind: string;
  status: string;
  manifest_digest: string | null;
  signature: string | null;
  page_count: number | null;
  file_count: number | null;
  total_bytes: string | number | null;
  preview_url: string | null;
  started_at: Date;
  finished_at: Date | null;
  pull_request_number: number | null;
}

const BUILD_COLUMNS = "id, space_id, version_name, audience, commit_sha, kind, status, manifest_digest, signature, page_count, file_count, total_bytes, preview_url, started_at, finished_at, pull_request_number";

export async function createBuild(
  tx: Queryable,
  tenantId: string,
  input: {
    spaceId: string;
    versionName: string;
    audience: string;
    commitSha: string;
    ref?: string | undefined;
    pullRequestNumber?: number | null | undefined;
    kind: "preview" | "branch" | "release";
    files: Array<{ path: string; digest: string; size: number; contentType: string }>;
    pageCount?: number | undefined;
    cachedPages?: number | undefined;
    createdBy: string;
    manifestDigest: string;
  },
): Promise<{ build: BuildRow; missing: string[] }> {
  const id = uuidv7();
  const { rows } = await tx.query<BuildRow>(
    `INSERT INTO builds (id, tenant_id, space_id, version_name, audience, commit_sha, ref, pull_request_number, kind, trigger, status, manifest_digest,
                         page_count, file_count, total_bytes, cached_pages, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ci','uploading',$10,$11,$12,$13,$14,$15) RETURNING ${BUILD_COLUMNS}`,
    [
      id, tenantId, input.spaceId, input.versionName, input.audience, input.commitSha, input.ref ?? null, input.pullRequestNumber ?? null, input.kind,
      input.manifestDigest, input.pageCount ?? null, input.files.length, input.files.reduce((n, f) => n + f.size, 0), input.cachedPages ?? null, input.createdBy,
    ],
  );
  for (const f of input.files) {
    await tx.query("INSERT INTO build_files (tenant_id, build_id, path, digest, content_type) VALUES ($1,$2,$3,$4,$5)", [tenantId, id, f.path, f.digest, f.contentType]);
  }
  const digests = [...new Set(input.files.map((f) => f.digest))];
  const { rows: present } = await tx.query<{ digest: string }>("SELECT digest FROM blobs WHERE digest = ANY($1::text[])", [digests]);
  const have = new Set(present.map((r) => r.digest));
  return { build: rows[0] as BuildRow, missing: digests.filter((d) => !have.has(d)) };
}

export async function recordBlob(tx: Queryable, tenantId: string, digest: string, size: number, contentType: string): Promise<boolean> {
  const { rows } = await tx.query<{ digest: string }>(
    "INSERT INTO blobs (tenant_id, digest, size_bytes, content_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING digest",
    [tenantId, digest, size, contentType],
  );
  return rows.length === 1;
}

export async function getBuild(tx: Queryable, id: string): Promise<BuildRow | null> {
  const { rows } = await tx.query<BuildRow>(`SELECT ${BUILD_COLUMNS} FROM builds WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function missingBlobsForBuild(tx: Queryable, buildId: string): Promise<string[]> {
  const { rows } = await tx.query<{ digest: string }>(
    "SELECT DISTINCT f.digest FROM build_files f LEFT JOIN blobs b ON b.digest = f.digest WHERE f.build_id = $1 AND b.digest IS NULL",
    [buildId],
  );
  return rows.map((r) => r.digest);
}

export async function finalizeBuild(tx: Queryable, buildId: string, input: { signature: string; previewUrl: string | null }): Promise<BuildRow | null> {
  const { rows } = await tx.query<BuildRow>(
    `UPDATE builds SET status = 'ready', signature = $2, preview_url = $3, finished_at = now(),
       expires_at = CASE WHEN kind = 'preview' THEN now() + interval '30 days' ELSE NULL END
     WHERE id = $1 AND status IN ('uploading','ready') RETURNING ${BUILD_COLUMNS}`,
    [buildId, input.signature, input.previewUrl],
  );
  return rows[0] ?? null;
}

export async function buildFile(tx: Queryable, buildId: string, path: string): Promise<{ digest: string; content_type: string } | null> {
  const { rows } = await tx.query<{ digest: string; content_type: string }>("SELECT digest, content_type FROM build_files WHERE build_id = $1 AND path = $2", [buildId, path]);
  return rows[0] ?? null;
}

export interface DeploymentRow {
  id: string;
  build_id: string;
  space_id: string;
  environment: string;
  version_name: string;
  audience: string;
  url: string | null;
  status: string;
  promoted_by: string;
  approved_by: string | null;
  promoted_at: Date;
}

const DEPLOYMENT_COLUMNS = "id, build_id, space_id, environment, version_name, audience, url, status, promoted_by, approved_by, promoted_at";

/** Atomic alias switch: supersede the active deployment in the slot, insert the new one. */
export async function promoteBuild(
  tx: Queryable,
  tenantId: string,
  build: BuildRow,
  input: { environment: string; promotedBy: string; approvedBy?: string | null | undefined; url: string | null },
): Promise<DeploymentRow> {
  await tx.query(
    "UPDATE deployments SET status = 'superseded' WHERE space_id = $1 AND environment = $2 AND version_name = $3 AND audience = $4 AND status = 'active'",
    [build.space_id, input.environment, build.version_name, build.audience],
  );
  const { rows } = await tx.query<DeploymentRow>(
    `INSERT INTO deployments (id, tenant_id, build_id, space_id, environment, version_name, audience, url, promoted_by, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${DEPLOYMENT_COLUMNS}`,
    [uuidv7(), tenantId, build.id, build.space_id, input.environment, build.version_name, build.audience, input.url, input.promotedBy, input.approvedBy ?? null],
  );
  return rows[0] as DeploymentRow;
}

export async function listDeployments(tx: Queryable, filters: { spaceId?: string; environment?: string; status?: string }): Promise<DeploymentRow[]> {
  const { rows } = await tx.query<DeploymentRow>(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments
     WHERE ($1::uuid IS NULL OR space_id = $1::uuid) AND ($2::text IS NULL OR environment = $2) AND ($3::text IS NULL OR status = $3)
     ORDER BY promoted_at DESC LIMIT 200`,
    [filters.spaceId ?? null, filters.environment ?? null, filters.status ?? null],
  );
  return rows;
}

export async function activeDeployment(tx: Queryable, spaceKey: string, environment: string): Promise<DeploymentRow | null> {
  const { rows } = await tx.query<DeploymentRow>(
    `SELECT d.id, d.build_id, d.space_id, d.environment, d.version_name, d.audience, d.url, d.status, d.promoted_by, d.approved_by, d.promoted_at
     FROM deployments d JOIN spaces s ON s.id = d.space_id
     WHERE s.key = $1 AND d.environment = $2 AND d.status = 'active' ORDER BY d.promoted_at DESC LIMIT 1`,
    [spaceKey, environment],
  );
  return rows[0] ?? null;
}
