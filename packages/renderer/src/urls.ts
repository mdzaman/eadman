import { posix } from "node:path";
import { classifyUrl } from "@docops/markdown";

const PAGE_EXT = /\.mdx?$/i;

/** Normalize a URL prefix so it starts and ends with "/" (full `https://` prefixes are kept). */
export function normalizeBasePath(basePath: string | undefined): string {
  let base = (basePath ?? "/").trim();
  if (base === "") return "/";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return base.endsWith("/") ? base : `${base}/`;
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  return base.replace(/\/{2,}/g, "/");
}

/**
 * Prefix that page links are rendered against. Each page's HTML then gets it replaced with the path
 * back to the site root ("./", "../../"), so one signed build works wherever it is mounted: at "/",
 * under /sites/<tenant>/<space>/<env>/ when promoted from dev to prod, in a preview or on a file share.
 */
export const LINK_BASE = "/__docops_base__/";

/** Path from an output file back to the site root: "index.html" -> "./", "guides/a/index.html" -> "../../". */
export function rootPrefix(outPath: string): string {
  const depth = outPath.split("/").length - 1;
  return depth === 0 ? "./" : "../".repeat(depth);
}

/** Replace the link placeholder with `base`: a page's root prefix, or the public base path for absolute URLs. */
export function withLinkBase(text: string, base: string): string {
  return text.split(LINK_BASE).join(base);
}

/** Normalize a repo-relative directory ("./docs/" -> "docs", "." -> ""). */
export function normalizeDir(dir: string | undefined): string {
  const cleaned = posix.normalize((dir ?? "").replace(/\\/g, "/").trim() || ".");
  return cleaned === "." || cleaned === "/" ? "" : cleaned.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

/** URL path of a page relative to the base path: "guides/a.md" -> "guides/a/", "index.md" -> "", "a/index.md" -> "a/". */
export function pageSlugPath(pagePath: string): string {
  const p = pagePath.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(PAGE_EXT, "");
  if (p === "index" || p === "") return "";
  if (p.endsWith("/index")) return p.slice(0, -"index".length);
  return `${p}/`;
}

/**
 * Pretty URL of a page under `basePath`:
 * "guides/payments.md" -> `${basePath}guides/payments/`, "index.md" -> basePath, "a/index.md" -> `${basePath}a/`.
 */
export function pageUrl(pagePath: string, basePath: string): string {
  return `${normalizeBasePath(basePath)}${pageSlugPath(pagePath)}`;
}

/** Output file of a page: "guides/payments.md" -> "guides/payments/index.html". */
export function pageOutputPath(pagePath: string): string {
  return `${pageSlugPath(pagePath)}index.html`;
}

/** Encode a site URL path for use in an `href` (keeps `/`, `#`, `?`, `%XX`). */
export function href(url: string): string {
  return encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
}

/** Only allow http(s), mailto and relative URLs in hrefs built from configuration. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return undefined;
  return trimmed;
}

export function isExternalHref(url: string): boolean {
  return /^(https?:)?\/\//i.test(url.trim());
}

export interface LinkContext {
  basePath: string;
  /** Repo-relative docs root (normalized), used to map repo-absolute links like `/docs/a.md`. */
  docsRoot: string;
}

/**
 * Resolve a URL written in a Markdown file (`fromPath`, relative to the docs root):
 * links to `.md`/`.mdx` become pretty page URLs under the base path; other relative
 * paths (images, files) are emitted under the base path; external, anchor and
 * other-scheme URLs are returned unchanged.
 */
export function resolveDocUrl(url: string, fromPath: string, ctx: LinkContext): string {
  if (!url || classifyUrl(url) !== "internal") return url;
  const cutAt = [url.indexOf("?"), url.indexOf("#")].filter((i) => i >= 0);
  const cut = cutAt.length > 0 ? Math.min(...cutAt) : -1;
  const rawPath = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? "" : url.slice(cut);
  if (rawPath === "") return url;
  let path = rawPath;
  try {
    path = decodeURI(rawPath);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  let target: string;
  if (path.startsWith("/")) {
    const stripped = path.replace(/^\/+/, "");
    const root = normalizeDir(ctx.docsRoot);
    if (root && (stripped === root || stripped.startsWith(`${root}/`))) target = stripped.slice(root.length + 1);
    else if (PAGE_EXT.test(stripped)) target = stripped;
    else return url; // a site-absolute path that is not a page: leave it alone
  } else {
    target = posix.join(posix.dirname(fromPath), path);
  }
  const normalized = posix.normalize(target || ".");
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) return url;
  const clean = normalized === "." || normalized === "./" ? "" : normalized.replace(/^\.\//, "");
  if (PAGE_EXT.test(clean)) return `${pageUrl(clean, ctx.basePath)}${suffix}`;
  const trailing = path.endsWith("/") && clean !== "" && !clean.endsWith("/") ? "/" : "";
  return `${normalizeBasePath(ctx.basePath)}${clean}${trailing}${suffix}`;
}

/** Absolute URL for a site path, given the configured `site.baseUrl`. */
export function absoluteUrl(path: string, baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const prefix = parsed.pathname.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const full = prefix && (p === `${prefix}/` || p.startsWith(`${prefix}/`)) ? p : `${prefix}${p}`;
  return `${parsed.origin}${href(full)}`;
}

/** Lowercase ASCII slug ("POST /v1/payments/{id}" -> "post-v1-payments-id"). */
export function slugify(value: string, fallback = "item"): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}
