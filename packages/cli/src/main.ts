import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { docTestFindings, formatReport, REPORT_FORMATS, runChecks, runDocTests, type ReportFormat } from "@docops/checks";
import { ConfigError, loadConfig } from "@docops/config";
import { DocOpsError, DOCOPS_VERSION, gateBlocked } from "@docops/core";
import { buildReferenceIndex, buildSnapshot, computeDocsStatus, describeChange, diffEntities, summarizeReadiness } from "@docops/engine";
import { changedFiles, fileReaderAt, isGitRepo, mergeBase, resolveRef } from "@docops/git";
import { listFiles, loadPages, syncIncludes, toPosix } from "@docops/markdown";
import { parseDocument } from "yaml";
import { DocOpsApi, PlatformError, resolveToken } from "./api-client.ts";
import { executeBuild, executePublish, walkSite } from "./build.ts";
import { executeCheck, parseReports, writeReports } from "./check.ts";
import { defaultContext, err, EXIT, out, UsageError, type CliContext } from "./context.ts";
import { configTemplate, GITHUB_WORKFLOW, GITLAB_PIPELINE, PAGE_TEMPLATES, renderTemplate } from "./templates.ts";

const GLOBAL_OPTIONS = {
  cwd: { type: "string", short: "C" },
  config: { type: "string", short: "c" },
  format: { type: "string" },
  report: { type: "string", multiple: true },
  output: { type: "string", short: "o" },
  offline: { type: "boolean" },
  "api-url": { type: "string" },
  token: { type: "string" },
  tenant: { type: "string" },
  "no-color": { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  verbose: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const satisfies ParseArgsConfig["options"];

type Options = Record<string, string | boolean | string[] | undefined>;

interface Command {
  summary: string;
  usage: string;
  options?: ParseArgsConfig["options"];
  run: (ctx: CliContext, opts: Options, args: string[]) => Promise<number>;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

async function emit(ctx: CliContext, opts: Options, text: string): Promise<void> {
  const file = str(opts.output);
  if (file) await writeFile(join(ctx.cwd, file), text);
  else out(ctx, text);
}

function formatOf(ctx: CliContext, opts: Options, allowed: readonly string[] = ["text", "json"]): string {
  const format = str(opts.format) ?? "text";
  if (!allowed.includes(format)) throw new UsageError(`--format must be one of ${allowed.join(", ")}`);
  return format;
}

// ---------------------------------------------------------------------------- commands

const commands: Record<string, Command> = {
  init: {
    summary: "Create docops.yaml, a docs skeleton and a CI workflow",
    usage: "docops init [--provider github|gitlab] [--force]",
    options: { provider: { type: "string" }, force: { type: "boolean" } },
    run: async (ctx, opts) => {
      const created: string[] = [];
      const write = async (path: string, content: string) => {
        const abs = join(ctx.cwd, path);
        if (existsSync(abs) && !opts.force) return;
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        created.push(path);
      };
      const id = basename(ctx.cwd).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").padEnd(2, "x").slice(0, 63);
      const specs = (await listFiles(ctx.cwd, ["**/openapi.{yaml,yml,json}", "**/*.openapi.{yaml,yml,json}"], ["**/node_modules/**", "**/.docops/**"])).slice(0, 5);
      await write("docops.yaml", configTemplate(id, basename(ctx.cwd), specs.map((p, i) => ({ id: i === 0 ? "api" : `api-${i + 1}`, path: p }))));
      await write("docs/index.md", renderTemplate("concept", basename(ctx.cwd), ctx.now().toISOString().slice(0, 10)));
      const provider = str(opts.provider) ?? (existsSync(join(ctx.cwd, ".gitlab-ci.yml")) ? "gitlab" : "github");
      if (provider === "github") await write(".github/workflows/docs.yml", GITHUB_WORKFLOW);
      else if (provider === "gitlab") await write("docops.gitlab-ci.yml", GITLAB_PIPELINE);
      out(ctx, created.length ? `Created ${created.join(", ")}` : "Nothing to do: files already exist (use --force to overwrite)");
      if (specs.length) out(ctx, `Detected API specs: ${specs.join(", ")}`);
      return EXIT.OK;
    },
  },

  config: {
    summary: "Validate docops.yaml against its JSON Schema",
    usage: "docops config validate",
    run: async (ctx, opts, args) => {
      if (args[0] !== "validate") throw new UsageError("usage: docops config validate");
      const loaded = await loadConfig(ctx.cwd, str(opts.config) ?? "docops.yaml");
      if (formatOf(ctx, opts) === "json") out(ctx, JSON.stringify({ valid: true, digest: loaded.digest, config: loaded.config }, null, 2));
      else out(ctx, `${loaded.path} is valid (project ${loaded.config.project.id}, ${loaded.config.sources.length} source(s))`);
      return EXIT.OK;
    },
  },

  extract: {
    summary: "Extract pages and entities; print a snapshot",
    usage: "docops extract [--upload]",
    options: { upload: { type: "boolean" } },
    run: async (ctx, opts) => {
      const loaded = await loadConfig(ctx.cwd, str(opts.config) ?? "docops.yaml");
      const result = await runChecks({ repoRoot: ctx.cwd, loaded, only: ["none"] });
      const snapshot = buildSnapshot({
        repository: { provider: "github", fullName: loaded.config.project.repository ?? `local/${loaded.config.project.id}` },
        commitSha: "0".repeat(40),
        spaceKey: loaded.config.project.id,
        spaceName: loaded.config.project.name,
        docsRoot: loaded.config.docs.root,
        configDigest: loaded.digest,
        sources: result.sources,
        pages: result.pages,
        entities: result.headEntities,
        references: result.headRefs,
      });
      if (opts.upload) {
        const apiUrl = str(opts["api-url"]) ?? ctx.env.DOCOPS_API_URL;
        if (!apiUrl) throw new UsageError("--upload needs --api-url or DOCOPS_API_URL");
        const token = await resolveToken(ctx, { apiUrl, token: str(opts.token), tenant: str(opts.tenant) });
        if (!token) throw new PlatformError(401, "no credentials");
        await new DocOpsApi(ctx, apiUrl, token).request("POST", "/v1/snapshots", snapshot);
      }
      await emit(ctx, opts, JSON.stringify(snapshot, null, 2));
      return EXIT.OK;
    },
  },

  check: {
    summary: "Run quality gates (links, coverage, schema change, drift, …)",
    usage: "docops check [--base <ref>] [--only <groups>] [--fail-on error|warning|never] [--changed-only] [--upload] [--report fmt=file]",
    options: {
      base: { type: "string" },
      only: { type: "string" },
      "fail-on": { type: "string" },
      "changed-only": { type: "boolean" },
      upload: { type: "boolean" },
      waived: { type: "boolean" },
      pr: { type: "string" },
      "fail-on-platform-error": { type: "boolean" },
    },
    run: async (ctx, opts) => {
      const format = formatOf(ctx, opts, REPORT_FORMATS) as ReportFormat;
      const reports = parseReports((opts.report as string[] | undefined) ?? []);
      const failOn = str(opts["fail-on"]);
      if (failOn && !["error", "warning", "never"].includes(failOn)) throw new UsageError("--fail-on must be error, warning or never");
      const outcome = await executeCheck(ctx, {
        config: str(opts.config),
        base: str(opts.base),
        only: str(opts.only)?.split(",").map((s) => s.trim()).filter(Boolean),
        failOn: failOn as "error" | "warning" | "never" | undefined,
        changedOnly: Boolean(opts["changed-only"]),
        upload: Boolean(opts.upload),
        waived: Boolean(opts.waived) || ctx.env.DOCOPS_WAIVED === "true",
        offline: Boolean(opts.offline),
        apiUrl: str(opts["api-url"]),
        token: str(opts.token),
        tenant: str(opts.tenant),
        pullRequestNumber: num(opts.pr),
        failOnPlatformError: Boolean(opts["fail-on-platform-error"]),
      });
      if (outcome.platformWarning) err(ctx, `warning: ${outcome.platformWarning}`);
      await writeReports(ctx, outcome.report, reports);
      if (!(opts.quiet && reports.length > 0)) await emit(ctx, opts, formatReport(outcome.report, format, { color: ctx.color && !opts["no-color"] && !opts.output }));
      return outcome.exitCode;
    },
  },

  diff: {
    summary: "Show entity changes between refs and the pages they affect",
    usage: "docops diff --base <ref> [--format text|json|markdown]",
    options: { base: { type: "string" } },
    run: async (ctx, opts) => {
      const baseRef = str(opts.base);
      if (!baseRef) throw new UsageError("diff requires --base <ref>");
      if (!(await isGitRepo(ctx.cwd))) throw new UsageError("diff requires a git repository");
      const format = formatOf(ctx, opts, ["text", "json", "markdown"]);
      const loaded = await loadConfig(ctx.cwd, str(opts.config) ?? "docops.yaml");
      const resolved = await resolveRef(ctx.cwd, baseRef).catch(() => "");
      if (!resolved) throw new UsageError(`base ref ${baseRef} not found`);
      const mb = (await mergeBase(ctx.cwd, resolved)) ?? resolved;
      const head = await runChecks({ repoRoot: ctx.cwd, loaded, only: ["none"] });
      const base = await runChecks({ repoRoot: ctx.cwd, loaded, readHead: fileReaderAt(ctx.cwd, mb), only: ["none"] });
      const changes = diffEntities(base.headEntities, head.headEntities);
      const baseRefs = buildReferenceIndex(head.pages, base.headEntities, { mentions: loaded.config.checks.drift.mentions });
      const impacted = changes.map((c) => ({ change: c, pages: [...new Set((baseRefs.byEntity.get(c.key) ?? []).map((r) => r.pagePath))].sort() }));
      const changedSet = await changedFiles(ctx.cwd, mb);
      if (format === "json") {
        await emit(ctx, opts, JSON.stringify({ base: { ref: baseRef, sha: mb }, changedFiles: [...changedSet].sort(), changes: impacted.map(({ change, pages }) => ({ key: change.key, type: change.type, renamedTo: change.renamedTo, breaking: change.breaking, userVisible: change.userVisible, deltas: change.deltas, pages })) }, null, 2));
      } else {
        const lines = impacted.map(({ change, pages }) => {
          const marker = change.type === "added" ? "+" : change.type === "removed" ? "-" : change.type === "renamed" ? "→" : "~";
          return `${format === "markdown" ? "- " : ""}${marker} ${describeChange(change)}${change.breaking ? " [breaking]" : ""}${pages.length ? `\n    ${format === "markdown" ? "  " : ""}pages: ${pages.join(", ")}` : ""}`;
        });
        await emit(ctx, opts, lines.length ? lines.join("\n") : "No entity changes.");
      }
      return EXIT.OK;
    },
  },

  coverage: {
    summary: "Coverage per entity kind and undocumented entities",
    usage: "docops coverage [--min <pct>] [--kind <kind>]",
    options: { min: { type: "string" }, kind: { type: "string" } },
    run: async (ctx, opts) => {
      const loaded = await loadConfig(ctx.cwd, str(opts.config) ?? "docops.yaml");
      if (str(opts.kind)) loaded.config.checks.coverage.kinds = [str(opts.kind) as string];
      const { coverage } = await runChecks({ repoRoot: ctx.cwd, loaded, only: ["none"] });
      if (formatOf(ctx, opts) === "json") await emit(ctx, opts, JSON.stringify(coverage, null, 2));
      else {
        const rows = coverage.byKind.map((k) => `${k.kind.padEnd(16)} L2 ${String(k.percentL2).padStart(5)}% (${k.documentedL2}/${k.publicEntities})   L1 ${String(k.percentL1).padStart(5)}%`);
        const missing = coverage.undocumented.map((u) => `  - ${u.key}`);
        await emit(ctx, opts, [...rows, `${"total".padEnd(16)} L2 ${String(coverage.totals.percentL2).padStart(5)}% (${coverage.totals.documentedL2}/${coverage.totals.publicEntities})`, ...(missing.length ? ["Undocumented:", ...missing] : [])].join("\n"));
      }
      const min = num(opts.min);
      return min !== undefined && coverage.totals.percentL2 < min ? EXIT.GATE_FAILED : EXIT.OK;
    },
  },

  build: {
    summary: "Render the static site (pages + generated API reference)",
    usage: "docops build [--out .docops/site] [--version-name v2.4.0] [--audience public] [--base-path /] [--preview]",
    options: { out: { type: "string" }, "version-name": { type: "string" }, audience: { type: "string" }, "base-path": { type: "string" }, preview: { type: "boolean" } },
    run: async (ctx, opts) => {
      const result = await executeBuild(ctx, { config: str(opts.config), out: str(opts.out), versionName: str(opts["version-name"]), audience: str(opts.audience), basePath: str(opts["base-path"]), preview: Boolean(opts.preview) });
      for (const issue of result.a11y) err(ctx, `warning a11y ${issue.rule} ${result.loaded.config.docs.root}/${issue.page}${issue.line ? `:${issue.line}` : ""} ${issue.message}`);
      if (formatOf(ctx, opts) === "json") out(ctx, JSON.stringify({ outDir: relative(ctx.cwd, result.outDir), pages: result.pages, referencePages: result.referencePages, files: result.files, bytes: result.bytes, cachedPages: result.cachedPages, a11y: result.a11y }, null, 2));
      else out(ctx, `Built ${result.pages} pages + ${result.referencePages} reference pages (${result.files} files, ${(result.bytes / 1024).toFixed(1)} KiB, ${result.cachedPages} unchanged) → ${relative(ctx.cwd, result.outDir)}`);
      return EXIT.OK;
    },
  },

  preview: {
    summary: "Build and serve the site locally",
    usage: "docops preview [--port 4321]",
    options: { port: { type: "string" }, out: { type: "string" } },
    run: async (ctx, opts) => {
      const outDir = str(opts.out) ?? ".docops/site";
      await executeBuild(ctx, { config: str(opts.config), out: outDir, preview: true });
      const root = join(ctx.cwd, outDir);
      const port = num(opts.port) ?? 4321;
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
      createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
        if (!file.startsWith(root)) return void res.writeHead(400).end();
        try {
          const body = await readFile(existsSync(file) ? file : join(file, "index.html"));
          res.writeHead(200, { "content-type": types[extname(file)] ?? "text/html; charset=utf-8" }).end(body);
        } catch {
          res.writeHead(404).end("Not found");
        }
      }).listen(port, () => out(ctx, `Serving ${outDir} at http://localhost:${port}/`));
      return new Promise(() => {});
    },
  },

  publish: {
    summary: "Upload a build (content-addressed) and optionally promote it",
    usage: "docops publish [--dir .docops/site] [--env dev|staging|prod] [--kind preview|branch|release] [--build <id> --env prod] [--dotenv file]",
    options: { dir: { type: "string" }, env: { type: "string" }, kind: { type: "string" }, build: { type: "string" }, "version-name": { type: "string" }, audience: { type: "string" }, pr: { type: "string" }, "approved-by": { type: "string" }, dotenv: { type: "string" } },
    run: async (ctx, opts) => {
      const kind = str(opts.kind);
      if (kind && !["preview", "branch", "release"].includes(kind)) throw new UsageError("--kind must be preview, branch or release");
      const result = await executePublish(ctx, {
        config: str(opts.config),
        dir: str(opts.dir),
        env: str(opts.env),
        kind: kind as "preview" | "branch" | "release" | undefined,
        buildId: str(opts.build),
        versionName: str(opts["version-name"]),
        audience: str(opts.audience),
        apiUrl: str(opts["api-url"]),
        token: str(opts.token),
        tenant: str(opts.tenant),
        pullRequestNumber: num(opts.pr),
        approvedBy: str(opts["approved-by"]),
      });
      const dotenv = str(opts.dotenv);
      if (dotenv) await writeFile(join(ctx.cwd, dotenv), `DOCOPS_BUILD_ID=${result.buildId}\n${result.previewUrl ? `DOCOPS_PREVIEW_URL=${result.previewUrl}\n` : ""}${result.deployment?.url ? `DOCOPS_URL=${result.deployment.url}\n` : ""}`);
      if (formatOf(ctx, opts) === "json") out(ctx, JSON.stringify(result, null, 2));
      else {
        out(ctx, `Build ${result.buildId}: uploaded ${result.uploaded} file(s), reused ${result.reused}`);
        if (result.previewUrl) out(ctx, `Preview: ${result.previewUrl}`);
        if (result.deployment) out(ctx, `Promoted to ${result.deployment.environment}: ${result.deployment.url ?? ""}`);
      }
      return EXIT.OK;
    },
  },

  readiness: {
    summary: "Release readiness for a Jira fix version",
    usage: "docops readiness --project PAY --fix-version 2.4.0 [--tickets tickets.json]",
    options: { project: { type: "string" }, "fix-version": { type: "string" }, tickets: { type: "string" } },
    run: async (ctx, opts) => {
      const project = str(opts.project);
      const fixVersion = str(opts["fix-version"]);
      if (!project || !fixVersion) throw new UsageError("readiness requires --project and --fix-version");
      let summary: { readyPercent: number; blockers: number; ready: boolean };
      let items: Array<{ ticketKey: string; docsStatus: string; reasons: string[] }>;
      const ticketsFile = str(opts.tickets);
      if (ticketsFile || opts.offline) {
        // Offline mode: tickets from a file, docs links from page frontmatter only.
        const tickets = JSON.parse(await readFile(join(ctx.cwd, ticketsFile ?? "tickets.json"), "utf8")) as Array<{ key: string; docsRequired?: boolean; fixVersions?: string[]; pullRequests?: Array<{ ref: string; state: "open" | "closed" | "merged"; touchesDocs: boolean }> }>;
        const loaded = await loadConfig(ctx.cwd, str(opts.config) ?? "docops.yaml");
        const { pages } = await loadPages(join(ctx.cwd, loaded.config.docs.root), { include: loaded.config.docs.include, exclude: loaded.config.docs.exclude, snippetsDir: loaded.config.docs.snippets, defaultPageType: loaded.config.docs.defaultPageType });
        items = tickets
          .filter((t) => (t.fixVersions ?? [fixVersion]).includes(fixVersion) && t.key.startsWith(`${project}-`))
          .map((t) => {
            const linked = pages.filter((p) => (Array.isArray(p.frontmatter.tickets) ? p.frontmatter.tickets : []).includes(t.key)).map((p) => ({ path: p.path, stale: false, published: false }));
            const status = computeDocsStatus({ required: t.docsRequired ?? true, pullRequests: t.pullRequests ?? [], pages: linked });
            return { ticketKey: t.key, docsStatus: status.status, reasons: status.reasons };
          });
        summary = summarizeReadiness(items.map((i) => ({ docsStatus: i.docsStatus as never })));
      } else {
        const apiUrl = str(opts["api-url"]) ?? ctx.env.DOCOPS_API_URL;
        if (!apiUrl) throw new UsageError("readiness needs --api-url/DOCOPS_API_URL, or --tickets <file> for offline mode");
        const token = await resolveToken(ctx, { apiUrl, token: str(opts.token), tenant: str(opts.tenant) });
        if (!token) throw new PlatformError(401, "no credentials");
        const r = await new DocOpsApi(ctx, apiUrl, token).request<{ summary: typeof summary; items: typeof items }>("GET", `/v1/readiness?tracker=jira&project=${encodeURIComponent(project)}&fixVersion=${encodeURIComponent(fixVersion)}`);
        summary = r.summary;
        items = r.items;
      }
      if (formatOf(ctx, opts) === "json") out(ctx, JSON.stringify({ project, fixVersion, summary, items }, null, 2));
      else {
        out(ctx, `${project} ${fixVersion}: ${summary.readyPercent}% ready · ${summary.blockers} blocker(s) · ${summary.ready ? "READY" : "NOT READY"}`);
        for (const i of items) out(ctx, `  ${i.ticketKey.padEnd(10)} ${i.docsStatus.padEnd(13)} ${i.reasons[0] ?? ""}`);
      }
      return summary.ready ? EXIT.OK : EXIT.GATE_FAILED;
    },
  },

  link: {
    summary: "Add or remove a ticket link in page frontmatter",
    usage: "docops link <TICKET-KEY> <page.md> [--remove]",
    options: { remove: { type: "boolean" } },
    run: async (ctx, opts, args) => {
      const [key, file] = args;
      if (!key || !file || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new UsageError("usage: docops link PAY-123 docs/guides/page.md [--remove]");
      const abs = join(ctx.cwd, file);
      const source = await readFile(abs, "utf8");
      const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
      const doc = parseDocument(match?.[1] ?? "");
      const tickets = ((doc.get("tickets") as { toJSON?: () => unknown } | undefined)?.toJSON?.() as string[] | undefined) ?? [];
      const next = opts.remove ? tickets.filter((t) => t !== key) : [...new Set([...tickets, key])];
      if (next.length) doc.set("tickets", doc.createNode(next, { flow: true }));
      else doc.delete("tickets");
      const fm = `---\n${doc.toString().trimEnd()}\n---\n`;
      await writeFile(abs, match ? source.replace(match[0], fm) : `${fm}\n${source}`);
      out(ctx, `${opts.remove ? "Unlinked" : "Linked"} ${key} ${opts.remove ? "from" : "to"} ${file}`);
      return EXIT.OK;
    },
  },

  new: {
    summary: "Create a page from a template",
    usage: `docops new <${Object.keys(PAGE_TEMPLATES).join("|")}> <path.md> [--title "…"]`,
    options: { title: { type: "string" }, owner: { type: "string", multiple: true } },
    run: async (ctx, opts, args) => {
      const [template, file] = args;
      if (!template || !file || !PAGE_TEMPLATES[template]) throw new UsageError(`usage: docops new <${Object.keys(PAGE_TEMPLATES).join("|")}> <path.md>`);
      const abs = join(ctx.cwd, file);
      if (existsSync(abs)) throw new UsageError(`${file} already exists`);
      const title = str(opts.title) ?? basename(file, extname(file)).replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, renderTemplate(template, title, ctx.now().toISOString().slice(0, 10), { owners: (opts.owner as string[] | undefined) ?? [] }));
      out(ctx, `Created ${file} from the ${template} template`);
      return EXIT.OK;
    },
  },

  sync: {
    summary: "Rewrite docops:include blocks from their source files",
    usage: "docops sync [--check]",
    options: { check: { type: "boolean" } },
    run: async (ctx, opts) => {
      const loaded = await loadConfig(ctx.cwd, str(opts.config) ?? "docops.yaml");
      const docsAbs = join(ctx.cwd, loaded.config.docs.root);
      let stale = 0;
      for (const file of await listFiles(docsAbs, loaded.config.docs.include, loaded.config.docs.exclude)) {
        const abs = join(docsAbs, file);
        const original = await readFile(abs, "utf8");
        if (!original.includes("docops:include")) continue;
        const result = await syncIncludes(abs, original);
        for (const inc of result.includes.filter((i) => !i.upToDate)) {
          stale++;
          out(ctx, `${opts.check ? "stale" : "updated"}: ${toPosix(relative(ctx.cwd, abs))}:${inc.line} ← ${inc.path}`);
        }
        if (!opts.check && result.content !== original) await writeFile(abs, result.content);
      }
      if (stale === 0) out(ctx, "All include blocks are up to date.");
      return opts.check && stale > 0 ? EXIT.GATE_FAILED : EXIT.OK;
    },
  },

  test: {
    summary: "Run doc tests (fenced blocks marked `test`)",
    usage: "docops test [--timeout 30000]",
    options: { timeout: { type: "string" } },
    run: async (ctx, opts) => {
      const loaded = await loadConfig(ctx.cwd, str(opts.config) ?? "docops.yaml");
      const { config } = loaded;
      const { pages } = await loadPages(join(ctx.cwd, config.docs.root), { include: config.docs.include, exclude: config.docs.exclude, snippetsDir: config.docs.snippets, defaultPageType: config.docs.defaultPageType });
      const results = await runDocTests(pages, { languages: config.checks.docTests.languages, timeoutMs: num(opts.timeout) ?? config.checks.docTests.timeoutMs, variables: config.variables, env: ctx.env });
      const findings = docTestFindings(results, config.docs.root, config.checks.docTests.level === "off" ? "block" : config.checks.docTests.level);
      if (formatOf(ctx, opts) === "json") out(ctx, JSON.stringify({ results, findings }, null, 2));
      else {
        for (const r of results) out(ctx, `${r.passed ? "✓" : "✖"} ${config.docs.root}/${r.page}:${r.line} (${r.lang}, ${r.durationMs} ms)${r.reason ? ` ${r.reason}` : ""}`);
        out(ctx, `${results.filter((r) => r.passed).length}/${results.length} doc tests passed`);
      }
      return gateBlocked(findings, "error") ? EXIT.GATE_FAILED : EXIT.OK;
    },
  },

  whoami: {
    summary: "Show the authenticated principal",
    usage: "docops whoami",
    run: async (ctx, opts) => {
      const apiUrl = str(opts["api-url"]) ?? ctx.env.DOCOPS_API_URL;
      if (!apiUrl) throw new UsageError("whoami needs --api-url or DOCOPS_API_URL");
      const token = await resolveToken(ctx, { apiUrl, token: str(opts.token), tenant: str(opts.tenant) });
      if (!token) throw new PlatformError(401, "no credentials");
      const me = await new DocOpsApi(ctx, apiUrl, token).request<{ principalType: string; principalId: string; tenant: { slug: string }; scopes: string[] }>("GET", "/v1/me");
      out(ctx, formatOf(ctx, opts) === "json" ? JSON.stringify(me, null, 2) : `${me.principalType} ${me.principalId} @ ${me.tenant.slug} (scopes: ${me.scopes.join(" ")})`);
      return EXIT.OK;
    },
  },

  site: {
    summary: "List the files of a built site with their content digests",
    usage: "docops site [--dir .docops/site]",
    options: { dir: { type: "string" } },
    run: async (ctx, opts) => {
      const files = await walkSite(join(ctx.cwd, str(opts.dir) ?? ".docops/site"));
      out(ctx, formatOf(ctx, opts) === "json" ? JSON.stringify(files.map(({ abs: _abs, ...f }) => f), null, 2) : files.map((f) => `${f.digest.slice(0, 12)}  ${String(f.size).padStart(8)}  ${f.path}`).join("\n"));
      return EXIT.OK;
    },
  },
};

function help(): string {
  const width = Math.max(...Object.keys(commands).map((c) => c.length));
  return [
    `docops ${DOCOPS_VERSION}: docs that never drift from the code`,
    "",
    "Usage: docops <command> [options]",
    "",
    "Commands:",
    ...Object.entries(commands).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    "",
    "Global options: -C/--cwd <dir>, -c/--config <file>, --format <fmt>, --report <fmt>=<file>, -o/--output <file>,",
    "                --offline, --api-url <url>, --token <token>, --tenant <slug>, --no-color, -q, -v, --version, --help",
    "Exit codes: 0 ok · 1 gate failed · 2 usage/config error · 3 internal error · 4 platform error (fail-closed)",
  ].join("\n");
}

/** CLI entry point; returns the process exit code (docs/05-cli-and-ci.md §3). */
export async function main(argv: string[], ctx: CliContext = defaultContext()): Promise<number> {
  const name = argv.find((a) => !a.startsWith("-"));
  const command = name ? commands[name] : undefined;
  try {
    if (!name || !command) {
      if (argv.includes("--version")) {
        out(ctx, DOCOPS_VERSION);
        return EXIT.OK;
      }
      out(ctx, help());
      return name ? EXIT.USAGE : EXIT.OK;
    }
    const { values, positionals } = parseArgs({
      args: argv.filter((a, i) => !(a === name && i === argv.indexOf(name))),
      options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      out(ctx, `${command.summary}\n\nUsage: ${command.usage}`);
      return EXIT.OK;
    }
    const cwd = typeof values.cwd === "string" ? join(ctx.cwd, values.cwd) : ctx.cwd;
    const runCtx: CliContext = { ...ctx, cwd, color: ctx.color && !values["no-color"] };
    return await command.run(runCtx, values as Options, positionals);
  } catch (error) {
    if (error instanceof ConfigError) {
      err(ctx, error.message);
      return EXIT.USAGE;
    }
    if (error instanceof UsageError || (error as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (error as { code?: string }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      err(ctx, `error: ${(error as Error).message}\n\nUsage: ${command?.usage ?? "docops <command>"}`);
      return EXIT.USAGE;
    }
    if (error instanceof PlatformError) {
      err(ctx, `error: ${error.message}`);
      return EXIT.PLATFORM;
    }
    if (error instanceof DocOpsError) {
      err(ctx, `error: ${error.message}`);
      return EXIT.USAGE;
    }
    err(ctx, `internal error: ${(error as Error).stack ?? error}`);
    return EXIT.INTERNAL;
  }
}

export function listCommands(): string[] {
  return Object.keys(commands);
}

