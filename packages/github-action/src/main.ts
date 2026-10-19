import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatGithubCommands, formatMarkdown, formatSarif, STICKY_MARKER } from "@docops/checks";
import { executeBuild, executeCheck, executePublish, EXIT, type CliContext } from "@docops/cli";
import { loadConfig } from "@docops/config";
import { diffLineRanges, lineInRanges, mergeBase, resolveRef } from "@docops/git";
import {
  annotationsFromFindings,
  appendStepSummary,
  getBooleanInput,
  getInput,
  GitHubClient,
  pullRequestFromEvent,
  setOutput,
  type PullRequestContext,
} from "@docops/github";

export interface ActionDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  stdout?: { write(s: string): boolean };
  stderr?: { write(s: string): boolean };
  now?: () => Date;
}

/**
 * docops/action entry point (runs.using: node24). Calls the CLI library directly, then
 * reports where developers look: annotations, a sticky PR comment, inline ```suggestion
 * comments on diff lines, the job summary, SARIF, and step outputs.
 */
export async function run(deps: ActionDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchImpl = deps.fetch ?? fetch;
  const workspace = join(env.GITHUB_WORKSPACE ?? process.cwd(), getInput("working-directory", env) || ".");
  const ctx: CliContext = { cwd: workspace, env, stdout, stderr, fetch: fetchImpl, color: false, now: deps.now ?? (() => new Date()) };
  const command = getInput("command", env) || "check";
  const apiUrl = getInput("api-url", env) || env.DOCOPS_API_URL || undefined;
  const config = getInput("config", env) || "docops.yaml";
  let event: unknown = null;
  try {
    event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : null;
  } catch {
    event = null;
  }
  const pr = pullRequestFromEvent(event, env.GITHUB_REPOSITORY);
  const ghToken = getInput("github-token", env) || env.GITHUB_TOKEN || "";
  const github = ghToken ? new GitHubClient({ token: ghToken, baseUrl: env.GITHUB_API_URL, fetch: fetchImpl }) : null;

  try {
    if (command === "build") {
      const built = await executeBuild(ctx, { config, versionName: getInput("version", env) || undefined });
      stdout.write(`Built ${built.pages} pages and ${built.referencePages} reference pages\n`);
      return EXIT.OK;
    }
    if (command === "publish") {
      const environment = getInput("environment", env) || "dev";
      await executeBuild(ctx, { config, versionName: getInput("version", env) || undefined });
      const result = await executePublish(ctx, { config, env: environment, kind: environment === "prod" ? "release" : "branch", apiUrl, versionName: getInput("version", env) || undefined });
      setOutput("conclusion", "success", env);
      stdout.write(`Published build ${result.buildId} to ${environment}: ${result.deployment?.url ?? ""}\n`);
      return EXIT.OK;
    }
    if (command !== "check") {
      stderr.write(`::error::Unknown command "${command}" (expected check, build or publish)\n`);
      return EXIT.USAGE;
    }
    return await check(ctx, { env, pr, github, apiUrl, config, stdout });
  } catch (error) {
    stderr.write(`::error title=DocOps::${String((error as Error).message).replace(/\n/g, "%0A")}\n`);
    return EXIT.INTERNAL;
  }
}

async function check(
  ctx: CliContext,
  args: { env: NodeJS.ProcessEnv; pr: PullRequestContext | null; github: GitHubClient | null; apiUrl: string | undefined; config: string; stdout: { write(s: string): boolean } },
): Promise<number> {
  const { env, pr, github, apiUrl, config, stdout } = args;
  const loaded = await loadConfig(ctx.cwd, config);
  const base = getInput("base", env) || (pr ? `origin/${pr.baseRef}` : undefined);
  const failOn = (getInput("fail-on", env) || undefined) as "error" | "warning" | "never" | undefined;
  const waived = Boolean(pr?.labels.includes(loaded.config.checks.schemaChange.waiverLabel));
  const outcome = await executeCheck(ctx, { config, base, failOn, upload: Boolean(apiUrl), apiUrl, pullRequestNumber: pr?.number, waived });
  const report = outcome.report;
  if (outcome.platformWarning) stdout.write(`::warning title=DocOps platform::${outcome.platformWarning}\n`);

  let previewUrl: string | null = null;
  if (getBooleanInput("preview", false, env) && apiUrl) {
    await executeBuild(ctx, { config, preview: true, out: ".docops/preview" });
    const published = await executePublish(ctx, { config, dir: ".docops/preview", kind: "preview", apiUrl, pullRequestNumber: pr?.number });
    previewUrl = published.previewUrl;
  }

  const sarifPath = getInput("sarif", env);
  if (sarifPath) {
    await writeFile(join(ctx.cwd, sarifPath), formatSarif(report));
    setOutput("sarif-file", sarifPath, env);
  }

  const serverUrl = env.GITHUB_SERVER_URL ?? "https://github.com";
  const headSha = pr?.headSha || outcome.headSha || env.GITHUB_SHA || "";
  const markdown = formatMarkdown(report, { previewUrl: previewUrl ?? undefined, fileUrlPrefix: env.GITHUB_REPOSITORY && headSha ? `${serverUrl}/${env.GITHUB_REPOSITORY}/blob/${headSha}/` : undefined });
  appendStepSummary(markdown, env);

  const annotations = getBooleanInput("annotations", true, env);
  if (github && pr) {
    if (annotations) {
      await github.createCheckRun({
        owner: pr.owner,
        repo: pr.repo,
        name: "DocOps",
        headSha,
        conclusion: report.summary.gate.blocked ? "failure" : report.summary.counts.warning > 0 ? "neutral" : "success",
        title: report.summary.gate.blocked ? `${report.summary.counts.error} blocking finding(s)` : "Docs gates passed",
        summary: markdown,
        annotations: annotationsFromFindings(report.findings),
        detailsUrl: previewUrl ?? undefined,
      });
    }
    if (getBooleanInput("comment", true, env)) {
      await github.upsertStickyComment(pr.owner, pr.repo, pr.number, markdown, STICKY_MARKER);
      // One-click suggestions only where GitHub accepts them: lines inside this PR's diff hunks.
      if (base) {
        const resolved = await resolveRef(ctx.cwd, base).catch(() => "");
        const mb = resolved ? ((await mergeBase(ctx.cwd, resolved)) ?? resolved) : null;
        const hunks = mb ? await diffLineRanges(ctx.cwd, mb) : new Map();
        const existing = new Set((await github.listReviewComments(pr.owner, pr.repo, pr.number)).map((c) => /docops:fp:([0-9a-f]+)/.exec(c.body)?.[1]).filter(Boolean));
        for (const f of report.findings) {
          if (!f.file || !f.suggestion?.replacement || !f.suggestion.line || existing.has(f.fingerprint)) continue;
          if (!lineInRanges(hunks, f.file, f.suggestion.line)) continue;
          try {
            await github.createSuggestion({ owner: pr.owner, repo: pr.repo, pullNumber: pr.number, commitId: headSha, path: f.file, line: f.suggestion.line, replacement: f.suggestion.replacement, note: `**${f.ruleId}**: ${f.message}`, fingerprint: f.fingerprint });
          } catch (error) {
            stdout.write(`::warning title=DocOps::Could not post suggestion on ${f.file}:${f.suggestion.line}: ${(error as Error).message}\n`);
          }
        }
      }
    }
  } else if (annotations) {
    stdout.write(formatGithubCommands(report));
  }

  setOutput("conclusion", report.summary.gate.blocked ? "failure" : report.summary.counts.warning > 0 ? "neutral" : "success", env);
  setOutput("errors", report.summary.counts.error, env);
  setOutput("warnings", report.summary.counts.warning, env);
  setOutput("coverage", report.summary.coverage?.percentL2 ?? 100, env);
  if (previewUrl) setOutput("preview-url", previewUrl, env);
  if (report.summary.gate.blocked) stdout.write(`::error title=DocOps gate::${report.summary.gate.reasons.join("; ")}\n`);
  return outcome.exitCode;
}

// Direct execution (node dist/index.js in the runner); importing the module never runs it.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run();
}
