import type { ParsedPage } from "@docops/markdown";

export type VariableValue = string | number | boolean;

export interface SiteOptions {
  title: string;
  /** BCP 47 language tag for `<html lang>`. */
  lang: string;
  /** Theme primary color (hex `#rgb` or `#rrggbb`); written to `assets/theme.css`. */
  primaryColor?: string;
  /** Edit link template; `{path}` is replaced by the repo-relative path of the page. */
  editUrl?: string;
  /** Absolute origin (and optional path) of the published site, e.g. `https://docs.acme.example/payments`. */
  baseUrl?: string;
}

export interface PageMeta {
  owners: string[];
  tickets: Array<{ key: string; url?: string }>;
  /** ISO date of the last review. */
  reviewed?: string;
  stale?: boolean;
}

export interface OpenApiSourceInput {
  sourceId: string;
  /** Sidebar section title, e.g. "Payments API reference". */
  title: string;
  /** Output directory relative to the site root, e.g. "reference/payments-api". */
  outDir: string;
  /** OpenAPI 3.x document (YAML or JSON). */
  content: string;
  includeInternal?: boolean;
}

export interface VersionInfo {
  name: string;
  available: Array<{ name: string; url: string }>;
}

export interface RenderSiteInput {
  site: SiteOptions;
  project: { id: string; name: string };
  /** Repo-relative docs directory, e.g. "docs" (used for edit links). */
  docsRoot: string;
  /** Pages from @docops/markdown; `page.path` is relative to the docs root. */
  pages: ParsedPage[];
  /** Snippet name -> parsed snippet. */
  snippets: Map<string, ParsedPage>;
  variables: Record<string, VariableValue>;
  openapi: OpenApiSourceInput[];
  version: VersionInfo;
  /** URL prefix ending with "/", e.g. "/" or "/payments/2.4/". */
  basePath: string;
  /** Preview build: banner, `noindex` and `Disallow: /`. */
  preview?: boolean;
  /** Ownership/review metadata keyed by `page.path`. Falls back to frontmatter when absent. */
  pageMeta?: Map<string, PageMeta>;
  /** Manifest of the previous build, for incremental statistics. */
  previousManifest?: BuildManifest;
}

export interface BuiltFile {
  /** Output path relative to the site root, POSIX separators. */
  path: string;
  content: string | Uint8Array;
  contentType: string;
  /** sha256 hex of the bytes. */
  digest: string;
  size: number;
}

export interface BuildManifest {
  schema: "docops.build.v1";
  rendererVersion: string;
  files: Array<{ path: string; digest: string; size: number; contentType: string }>;
  pages: Array<{ source: string; url: string; inputHash: string; title: string }>;
}

export type A11yRule = "a11y/img-alt" | "a11y/heading-order" | "a11y/link-text" | "a11y/table-headers" | "a11y/html-lang";

export interface A11yIssue {
  /** Page path relative to the docs root ("*" for site-wide issues). */
  page: string;
  rule: A11yRule;
  message: string;
  line?: number;
}

export interface BuildStats {
  /** Content (Markdown/MDX) pages rendered. */
  pages: number;
  /** Generated API reference pages (index, tag and operation pages). */
  referencePages: number;
  /** Content pages whose inputHash matches the previous manifest. */
  cachedPages: number;
  files: number;
  bytes: number;
}

export interface BuildResult {
  files: BuiltFile[];
  manifest: BuildManifest;
  a11y: A11yIssue[];
  stats: BuildStats;
}

export interface SearchEntry {
  url: string;
  title: string;
  headings: string[];
  /** First ~300 words of plain text. */
  text: string;
  version: string;
}
