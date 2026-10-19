import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { loadConfig, type LoadedConfig } from "@docops/config";
import { matchesAny } from "@docops/core";
import { headInfo, isGitRepo } from "@docops/git";
import { frontmatterList, listFiles, loadPages, toPosix } from "@docops/markdown";
import { renderSite, type BuildManifest } from "@docops/renderer";
import { ownersFor, parseCodeowners } from "@docops/checks";
import { DocOpsApi, PlatformError, resolveToken } from "./api-client.ts";
import { UsageError, type CliContext } from "./context.ts";

export interface BuildOptions {
  config?: string | undefined;
  out?: string | undefined;
  versionName?: string | undefined;
  audience?: string | undefined;
  basePath?: string | undefined;
  preview?: boolean | undefined;
}

export interface BuildOutcome {
  outDir: string;
  pages: number;
  referencePages: number;
  files: number;
  bytes: number;
  cachedPages: number;
  a11y: Array<{ page: string; rule: string; message: string; line?: number | undefined }>;
  loaded: LoadedConfig;
}

const MANIFEST_FILE = ".docops-manifest.json";

/** `v2.4.0` → `2.4` (versions.label "{major}.{minor}"), anything else unchanged. */
export function versionLabel(raw: string, label: string): string {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) return raw;
  return label.replace("{major}", m[1] ?? "0").replace("{minor}", m[2] ?? "0").replace("{patch}", m[3] ?? "0");
}

export async function executeBuild(ctx: CliContext, options: BuildOptions): Promise<BuildOutcome> {
  const loaded = await loadConfig(ctx.cwd, options.config ?? "docops.yaml");
  const { config } = loaded;
  const docsRoot = config.docs.root.replace(/\/$/, "");
  const docsAbs = join(ctx.cwd, docsRoot);
  const outDir = join(ctx.cwd, options.out ?? ".docops/site");
  const { pages, snippets } = await loadPages(docsAbs, { include: config.docs.include, exclude: config.docs.exclude, snippetsDir: config.docs.snippets, defaultPageType: config.docs.defaultPageType });

  const codeownersPath = ["CODEOWNERS", ".github/CODEOWNERS", `${docsRoot}/CODEOWNERS`].find((f) => existsSync(join(ctx.cwd, f)));
  const codeowners = codeownersPath ? parseCodeowners(readFileSync(join(ctx.cwd, codeownersPath), "utf8")) : [];
  const jiraSite = config.integrations.jira?.site;
  const pageMeta = new Map(
    pages.map((p) => {
      const reviewed = p.frontmatter.reviewed;
      return [
        p.path,
        {
          owners: [...new Set([...frontmatterList(p, "owners"), ...ownersFor(codeowners, `${docsRoot}/${p.path}`)])],
          tickets: frontmatterList(p, "tickets").map((key) => ({ key, url: jiraSite ? `https://${jiraSite}/browse/${key}` : undefined })),
          reviewed: typeof reviewed === "string" ? reviewed : reviewed instanceof Date ? reviewed.toISOString().slice(0, 10) : undefined,
        },
      ];
    }),
  );

  const openapi = [];
  for (const source of config.sources) {
    if (source.type !== "openapi" || source.reference?.enabled === false) continue;
    openapi.push({
      sourceId: source.id,
      title: source.reference?.title ?? source.id,
      outDir: source.reference?.outDir ?? `reference/${source.id}`,
      content: await readFile(join(ctx.cwd, source.path), "utf8"),
      includeInternal: (options.audience ?? config.docs.defaultAudience) === "internal",
    });
  }

  let previousManifest: BuildManifest | undefined;
  try {
    previousManifest = JSON.parse(await readFile(join(outDir, MANIFEST_FILE), "utf8")) as BuildManifest;
  } catch {
    previousManifest = undefined;
  }
  const version = options.versionName ? versionLabel(options.versionName, config.versions.label) : config.versions.default;
  const basePath = `/${(options.basePath ?? "/").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
  const result = await renderSite({
    site: { title: config.site.title, lang: config.site.lang, primaryColor: config.site.theme.primaryColor, editUrl: config.site.editUrl, baseUrl: config.publish.baseUrl },
    project: { id: config.project.id, name: config.project.name },
    docsRoot,
    pages,
    snippets,
    variables: config.variables,
    openapi,
    version: { name: version, available: [{ name: version, url: basePath }] },
    basePath,
    preview: options.preview ?? false,
    pageMeta,
    previousManifest,
  });

  await rm(outDir, { recursive: true, force: true });
  for (const file of result.files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  // Static assets referenced by pages (images, downloads) are copied as-is.
  const assets = (await listFiles(docsAbs, ["**/*"], [...config.docs.exclude, `${config.docs.snippets}/**`])).filter((f) => !/\.(md|mdx)$/i.test(f) && !matchesAny(f, ["**/CODEOWNERS"]));
  for (const asset of assets) {
    const target = join(outDir, asset);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(docsAbs, asset), target);
  }
  await writeFile(join(outDir, MANIFEST_FILE), JSON.stringify(result.manifest, null, 2));
  return {
    outDir,
    pages: result.stats.pages,
    referencePages: result.stats.referencePages,
    files: result.stats.files + assets.length,
    bytes: result.stats.bytes,
    cachedPages: result.stats.cachedPages,
    a11y: result.a11y,
    loaded,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

export async function walkSite(dir: string): Promise<Array<{ path: string; abs: string; digest: string; size: number; contentType: string }>> {
  const files: Array<{ path: string; abs: string; digest: string; size: number; contentType: string }> = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.name !== MANIFEST_FILE) {
        const bytes = await readFile(abs);
        files.push({ path: toPosix(relative(dir, abs)), abs, digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength, contentType: CONTENT_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream" });
      }
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface PublishOptions {
  config?: string | undefined;
  dir?: string | undefined;
  env?: string | undefined;
  kind?: "preview" | "branch" | "release" | undefined;
  buildId?: string | undefined;
  versionName?: string | undefined;
  audience?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  tenant?: string | undefined;
  pullRequestNumber?: number | undefined;
  approvedBy?: string | undefined;
}

export interface PublishOutcome {
  buildId: string;
  uploaded: number;
  reused: number;
  previewUrl: string | null;
  deployment: { environment: string; url: string | null } | null;
}

/** Content-addressed upload (only unknown digests are sent), finalize (server signs), optional promotion. */
export async function executePublish(ctx: CliContext, options: PublishOptions): Promise<PublishOutcome> {
  const apiUrl = options.apiUrl ?? ctx.env.DOCOPS_API_URL;
  if (!apiUrl) throw new UsageError("publish needs --api-url or DOCOPS_API_URL");
  const token = await resolveToken(ctx, { apiUrl, token: options.token, tenant: options.tenant });
  if (!token) throw new PlatformError(401, "no credentials: set DOCOPS_TOKEN or run in CI with OIDC");
  const api = new DocOpsApi(ctx, apiUrl, token);

  if (options.buildId) {
    if (!options.env) throw new UsageError("--build requires --env");
    const deployment = await api.request<{ environment: string; url: string | null }>("POST", "/v1/deployments", { buildId: options.buildId, environment: options.env, approvedBy: options.approvedBy });
    return { buildId: options.buildId, uploaded: 0, reused: 0, previewUrl: null, deployment };
  }

  const loaded = await loadConfig(ctx.cwd, options.config ?? "docops.yaml");
  const dir = join(ctx.cwd, options.dir ?? ".docops/site");
  if (!existsSync(dir)) throw new UsageError(`${options.dir ?? ".docops/site"} does not exist; run docops build first`);
  const files = await walkSite(dir);
  const head = (await isGitRepo(ctx.cwd)) ? await headInfo(ctx.cwd) : null;
  const kind = options.kind ?? (options.env ? (options.env === "prod" ? "release" : "branch") : "branch");
  const created = await api.request<{ build: { id: string }; missingDigests: string[] }>("POST", "/v1/builds", {
    spaceKey: loaded.config.project.id,
    versionName: options.versionName ?? loaded.config.versions.default,
    audience: options.audience ?? loaded.config.docs.defaultAudience,
    commitSha: head?.sha ?? "0".repeat(40),
    ref: head?.ref,
    pullRequestNumber: options.pullRequestNumber ?? null,
    kind,
    manifest: { files: files.map(({ path, digest, size, contentType }) => ({ path, digest, size, contentType })) },
    stats: { pageCount: files.filter((f) => f.path.endsWith(".html")).length },
  });
  const missing = new Set(created.missingDigests);
  let uploaded = 0;
  for (const file of files) {
    if (!missing.has(file.digest)) continue;
    missing.delete(file.digest);
    await api.request("PUT", `/v1/blobs/${file.digest}`, undefined, { data: new Uint8Array(await readFile(file.abs)), contentType: file.contentType });
    uploaded++;
  }
  const build = await api.request<{ id: string; previewUrl: string | null }>("POST", `/v1/builds/${created.build.id}/finalize`);
  let deployment: PublishOutcome["deployment"] = null;
  if (options.env && kind !== "preview") {
    deployment = await api.request<{ environment: string; url: string | null }>("POST", "/v1/deployments", { buildId: build.id, environment: options.env, approvedBy: options.approvedBy });
  }
  return { buildId: build.id, uploaded, reused: files.length - uploaded, previewUrl: build.previewUrl, deployment };
}
