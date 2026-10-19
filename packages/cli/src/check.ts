import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatReport, REPORT_FORMATS, runChecks, type ReportFormat, type RunChecksResult } from "@docops/checks";
import { loadConfig, type LoadedConfig } from "@docops/config";
import { gateBlocked, sortFindings, type CheckReport } from "@docops/core";
import { buildSnapshot } from "@docops/engine";
import { changedFiles, fileReaderAt, headInfo, isGitRepo, mergeBase, remoteFullName, resolveRef } from "@docops/git";
import { DocOpsApi, PlatformError, resolveToken } from "./api-client.ts";
import { EXIT, UsageError, type CliContext } from "./context.ts";

export interface CheckOptions {
  config?: string | undefined;
  base?: string | undefined;
  only?: string[] | undefined;
  failOn?: "error" | "warning" | "never" | undefined;
  changedOnly?: boolean | undefined;
  upload?: boolean | undefined;
  waived?: boolean | undefined;
  offline?: boolean | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  tenant?: string | undefined;
  pullRequestNumber?: number | undefined;
  failOnPlatformError?: boolean | undefined;
}

export interface CheckOutcome {
  report: CheckReport;
  result: RunChecksResult;
  loaded: LoadedConfig;
  exitCode: number;
  repository: string;
  headSha: string | null;
  baseSha: string | null;
  platformWarning?: string | undefined;
}

/** `docops check` as a library call: shared by the CLI and the GitHub Action. */
export async function executeCheck(ctx: CliContext, options: CheckOptions): Promise<CheckOutcome> {
  const loaded = await loadConfig(ctx.cwd, options.config ?? "docops.yaml");
  const inGit = await isGitRepo(ctx.cwd);
  let base: { ref: string; sha: string | null; read: (p: string) => Promise<string | null> } | undefined;
  let changed: Set<string> | undefined;
  if (options.base) {
    if (!inGit) throw new UsageError("--base requires a git repository");
    const resolved = await resolveRef(ctx.cwd, options.base).catch(() => "");
    if (!resolved) throw new UsageError(`base ref ${options.base} not found (fetch it first, e.g. git fetch origin main)`);
    const mb = (await mergeBase(ctx.cwd, resolved)) ?? resolved;
    base = { ref: options.base, sha: mb, read: fileReaderAt(ctx.cwd, mb) };
    changed = await changedFiles(ctx.cwd, mb);
  }
  const head = inGit ? await headInfo(ctx.cwd) : null;
  const repository = loaded.config.project.repository ?? (inGit ? await remoteFullName(ctx.cwd) : null) ?? `local/${loaded.config.project.id}`;

  const result = await runChecks({
    repoRoot: ctx.cwd,
    loaded,
    head: { ref: head?.ref ?? "WORKTREE", sha: head?.sha ?? null },
    base,
    changedFiles: changed,
    waived: options.waived,
    only: options.only,
    failOn: options.failOn,
    now: ctx.now(),
  });
  let report = result.report;
  if (options.changedOnly && changed) {
    report = { ...report, findings: report.findings.filter((f) => !f.file || changed.has(f.file) || f.category === "schema" || f.category === "coverage") };
  }

  let platformWarning: string | undefined;
  const apiUrl = options.apiUrl ?? ctx.env.DOCOPS_API_URL;
  if (options.upload && !options.offline) {
    try {
      if (!apiUrl) throw new PlatformError(0, "no API URL (set --api-url or DOCOPS_API_URL)");
      const token = await resolveToken(ctx, { apiUrl, token: options.token, tenant: options.tenant });
      if (!token) throw new PlatformError(401, "no credentials (set DOCOPS_TOKEN or run in CI with OIDC)");
      const api = new DocOpsApi(ctx, apiUrl, token);
      const repo = { provider: "github", fullName: repository };
      const headSha = head?.sha ?? "0".repeat(40);
      await api.request("POST", "/v1/snapshots", buildSnapshot({
        repository: repo,
        commitSha: headSha,
        ref: head?.ref,
        committedAt: head?.committedAt,
        spaceKey: loaded.config.project.id,
        spaceName: loaded.config.project.name,
        docsRoot: loaded.config.docs.root,
        configDigest: loaded.digest,
        sources: result.sources,
        pages: result.pages,
        entities: result.headEntities,
        references: result.headRefs,
      }));
      const run = await api.request<{ dismissedFingerprints?: string[] }>("POST", "/v1/check-runs", {
        repository: repo,
        headSha,
        baseSha: base?.sha ?? null,
        ref: head?.ref,
        pullRequestNumber: options.pullRequestNumber ?? null,
        cliVersion: report.tool.version,
        conclusion: report.summary.gate.blocked ? "failure" : "success",
        summary: report.summary,
        findings: report.findings,
      });
      const dismissed = new Set(run.dismissedFingerprints ?? []);
      if (dismissed.size > 0) {
        const findings = sortFindings(report.findings.filter((f) => !dismissed.has(f.fingerprint)));
        const failOn = options.failOn ?? loaded.config.checks.failOn;
        const counts = { error: 0, warning: 0, info: 0 };
        for (const f of findings) counts[f.severity]++;
        report = { ...report, findings, summary: { ...report.summary, counts, gate: { blocked: gateBlocked(findings, failOn), reasons: report.summary.gate.reasons } } };
      }
    } catch (error) {
      platformWarning = `DocOps platform unavailable: ${(error as Error).message}`;
      if (options.failOnPlatformError) {
        return { report, result, loaded, exitCode: EXIT.PLATFORM, repository, headSha: head?.sha ?? null, baseSha: base?.sha ?? null, platformWarning };
      }
    }
  }
  return {
    report,
    result,
    loaded,
    exitCode: report.summary.gate.blocked ? EXIT.GATE_FAILED : EXIT.OK,
    repository,
    headSha: head?.sha ?? null,
    baseSha: base?.sha ?? null,
    platformWarning,
  };
}

/** Parse `--report fmt=path` values. */
export function parseReports(values: readonly string[]): Array<{ format: ReportFormat; path: string }> {
  return values.map((v) => {
    const [format, ...rest] = v.split("=");
    const path = rest.join("=");
    if (!REPORT_FORMATS.includes(format as ReportFormat) || !path) throw new UsageError(`--report expects <format>=<file> with format in ${REPORT_FORMATS.join(", ")}`);
    return { format: format as ReportFormat, path };
  });
}

export async function writeReports(ctx: CliContext, report: CheckReport, reports: Array<{ format: ReportFormat; path: string }>): Promise<void> {
  for (const r of reports) await writeFile(join(ctx.cwd, r.path), formatReport(report, r.format, { color: false }));
}
