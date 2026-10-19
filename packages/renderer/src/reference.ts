import GithubSlugger from "github-slugger";
import type { Element, ElementContent } from "hast";
import { HTTP_METHODS, loadOpenApi, refName, type OpenApiDocument } from "@docops/extractors";
import { callout, codeBlock, methodBadge, tabsGroup } from "./blocks.ts";
import type { OperationLookup, OperationRef, RenderContext } from "./context.ts";
import { h, type HChild } from "./hast.ts";
import type { TocEntry } from "./layout.ts";
import { inlineContent, renderMarkdownSource } from "./markdown.ts";
import type { NavNode } from "./nav.ts";
import { authSample, curlSample, fetchSample, mediaExample, type SampleRequest } from "./samples.ts";
import {
  asArray,
  asString,
  flatten,
  formatValue,
  nestedObject,
  refOf,
  resolve,
  schemaTypeLabel,
  schemaTypes,
  variantName,
  variants,
  type JsonObject,
} from "./schema.ts";
import { firstWords, plainText, summarize } from "./search.ts";
import type { OpenApiSourceInput } from "./types.ts";
import { href, normalizeBasePath, normalizeDir, slugify } from "./urls.ts";

/** Nested object properties are listed down to `a.b.c`. */
const MAX_PROPERTY_DEPTH = 3;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PARAMETER_LOCATIONS: Array<[string, string]> = [
  ["path", "Path parameters"],
  ["query", "Query parameters"],
  ["header", "Header parameters"],
  ["cookie", "Cookie parameters"],
];
/** Ids used by the page structure; anchors generated from descriptions avoid them. */
const RESERVED_IDS = [
  "content",
  "servers",
  "authentication",
  "operations",
  "other-operations",
  "parameters",
  "request-body",
  "responses",
  "security",
  "code-samples",
  "try-it",
];

export interface ApiOperationModel extends OperationRef {
  operationId?: string | undefined;
  slug: string;
  outPath: string;
  description?: string | undefined;
  tags: string[];
  operation: JsonObject;
  pathItem: JsonObject;
  parameters: JsonObject[];
  internal: boolean;
}

export interface ApiTagModel {
  name: string;
  slug: string;
  description?: string | undefined;
  url: string;
  outPath: string;
  operations: ApiOperationModel[];
}

export interface ApiModel {
  sourceId: string;
  title: string;
  outDir: string;
  includeInternal: boolean;
  doc: OpenApiDocument;
  url: string;
  outPath: string;
  operations: ApiOperationModel[];
  tags: ApiTagModel[];
  untagged: ApiOperationModel[];
}

export interface ReferencePage {
  kind: "index" | "tag" | "operation";
  url: string;
  outPath: string;
  title: string;
  description?: string | undefined;
  body: ElementContent[];
  toc: TocEntry[];
  footer: ElementContent[];
  articleId?: string | undefined;
  search: { headings: string[]; text: string };
}

function uniqueSegment(preferred: string, used: Set<string>): string {
  // Case-insensitive: output paths must not collide on case-insensitive file systems.
  let candidate = preferred;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${preferred}-${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function mergeParameters(doc: OpenApiDocument, pathItem: JsonObject, op: JsonObject, includeInternal: boolean): JsonObject[] {
  const byKey = new Map<string, JsonObject>();
  for (const raw of [...asArray(pathItem.parameters), ...asArray(op.parameters)]) {
    const param = resolve(doc, raw);
    if (!param || typeof param.name !== "string" || typeof param.in !== "string") continue;
    if (param["x-internal"] === true && !includeInternal) continue;
    byKey.set(`${param.in}:${param.name}`, param);
  }
  return [...byKey.values()];
}

/** Load an OpenAPI source and compute the reference page model (URLs, tags, visible operations). */
export function buildApiModel(input: OpenApiSourceInput, basePath: string): ApiModel {
  let doc: OpenApiDocument;
  try {
    doc = loadOpenApi(input.content).document;
  } catch (error) {
    throw new Error(`OpenAPI source "${input.sourceId}": ${(error as Error).message}`);
  }
  const outDir = normalizeDir(input.outDir) || `reference/${slugify(input.sourceId, "api")}`;
  if (outDir === ".." || outDir.startsWith("../")) {
    throw new Error(`OpenAPI source "${input.sourceId}": outDir "${input.outDir}" must stay inside the site`);
  }
  const base = normalizeBasePath(basePath);
  const includeInternal = input.includeInternal === true;
  const operations: ApiOperationModel[] = [];
  const usedSlugs = new Set<string>();
  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const item = resolve(doc, rawItem);
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const op = resolve(doc, item[method]);
      if (!op) continue;
      const internal = op["x-internal"] === true || item["x-internal"] === true;
      if (internal && !includeInternal) continue;
      const upper = method.toUpperCase();
      const operationId = asString(op.operationId)?.trim();
      const preferred = operationId && SAFE_SEGMENT.test(operationId) ? operationId : slugify(operationId ?? `${upper} ${path}`, "operation");
      const slug = uniqueSegment(preferred, usedSlugs);
      operations.push({
        sourceId: input.sourceId,
        method: upper,
        path,
        operationId,
        summary: asString(op.summary)?.trim(),
        description: asString(op.description),
        deprecated: op.deprecated === true,
        url: `${base}${outDir}/operations/${slug}/`,
        outPath: `${outDir}/operations/${slug}/index.html`,
        slug,
        tags: asArray(op.tags).filter((t): t is string => typeof t === "string" && t.trim() !== ""),
        operation: op,
        pathItem: item,
        parameters: mergeParameters(doc, item, op, includeInternal),
        internal,
      });
    }
  }

  const tagNames: string[] = [];
  const tagDescriptions = new Map<string, string | undefined>();
  for (const tag of doc.tags ?? []) {
    if (tag && typeof tag.name === "string" && !tagDescriptions.has(tag.name)) {
      tagNames.push(tag.name);
      tagDescriptions.set(tag.name, asString(tag.description));
    }
  }
  for (const op of operations) {
    for (const tag of op.tags) {
      if (!tagDescriptions.has(tag)) {
        tagNames.push(tag);
        tagDescriptions.set(tag, undefined);
      }
    }
  }
  const usedTagSlugs = new Set<string>();
  const tags: ApiTagModel[] = [];
  for (const name of tagNames) {
    const tagOps = operations.filter((op) => op.tags.includes(name));
    if (tagOps.length === 0) continue; // e.g. every operation of the tag is internal
    const slug = uniqueSegment(slugify(name, "tag"), usedTagSlugs);
    tags.push({
      name,
      slug,
      description: tagDescriptions.get(name),
      url: `${base}${outDir}/tags/${slug}/`,
      outPath: `${outDir}/tags/${slug}/index.html`,
      operations: tagOps,
    });
  }
  return {
    sourceId: input.sourceId,
    title: input.title?.trim() || asString(doc.info?.title) || input.sourceId,
    outDir,
    includeInternal,
    doc,
    url: `${base}${outDir}/`,
    outPath: `${outDir}/index.html`,
    operations,
    tags,
    untagged: operations.filter((op) => op.tags.length === 0),
  };
}

/** Lookup used by `<ApiOperation op="POST /v1/payments" />` and `operationId="…"`. */
export function operationIndex(models: readonly ApiModel[]): OperationLookup {
  const all = models.flatMap((m) => m.operations);
  return {
    find(query) {
      const pool = query.source ? all.filter((op) => op.sourceId === query.source) : all;
      const byId = (id: string): ApiOperationModel | undefined => pool.find((op) => op.operationId === id);
      if (query.operationId?.trim()) {
        const found = byId(query.operationId.trim());
        if (found) return found;
      }
      if (query.op?.trim()) {
        const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(query.op);
        if (match?.[1] && match[2]) {
          const method = match[1].toUpperCase();
          const path = match[2];
          const found = pool.find((op) => op.method === method && op.path === path);
          if (found) return found;
        }
        return byId(query.op.trim());
      }
      return undefined;
    },
  };
}

function operationLabel(op: ApiOperationModel): HChild[] {
  return [methodBadge(op.method), " ", op.summary ?? op.path];
}

/** Sidebar section for one API: overview, then tags with their operations. */
export function buildApiNav(model: ApiModel): NavNode {
  const opNode = (op: ApiOperationModel): NavNode => ({ label: operationLabel(op), url: op.url, children: [] });
  const children: NavNode[] = [{ label: "Overview", url: model.url, children: [] }];
  for (const tag of model.tags) children.push({ label: tag.name, url: tag.url, children: tag.operations.map(opNode) });
  for (const op of model.untagged) children.push(opNode(op));
  return { label: model.title, children };
}

// ---------------------------------------------------------------------------
// Page rendering.

interface Builder {
  ctx: RenderContext;
  model: ApiModel;
  slugger: GithubSlugger;
  tables: number;
}

function newBuilder(ctx: RenderContext, model: ApiModel): Builder {
  const slugger = new GithubSlugger();
  for (const id of RESERVED_IDS) slugger.slug(id);
  return { ctx, model, slugger, tables: 0 };
}

function markdown(b: Builder, text: string | undefined, headingOffset: number): ElementContent[] {
  if (!text?.trim()) return [];
  const { root } = renderMarkdownSource(text, b.ctx, { fromPath: "index.md", headingOffset, slugger: b.slugger });
  return root.children.filter((c): c is ElementContent => c.type === "element" || c.type === "text");
}

function markdownInline(b: Builder, text: string | undefined): ElementContent[] {
  if (!text?.trim()) return [];
  return inlineContent(renderMarkdownSource(text, b.ctx, { fromPath: "index.md", headingOffset: 3, slugger: b.slugger }).root);
}

function code(value: string): Element {
  return h("code", null, value);
}

function joined(items: HChild[], separator: string): HChild[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [separator, item]));
}

interface Row {
  name: string;
  depth: number;
  type: string;
  required: boolean;
  description?: string | undefined;
  schema: JsonObject;
  deprecated: boolean;
}

function constraintItems(b: Builder, schema: JsonObject): HChild[] {
  const doc = b.model.doc;
  const items: HChild[][] = [];
  if (schema.default !== undefined) items.push(["Default: ", code(formatValue(schema.default))]);
  if (Array.isArray(schema.enum)) items.push(["Allowed: ", ...joined(schema.enum.map((v) => code(formatValue(v))), ", ")]);
  if (schema.const !== undefined) items.push(["Value: ", code(formatValue(schema.const))]);
  const itemSchema = resolve(doc, schema.items);
  if (itemSchema && Array.isArray(itemSchema.enum)) {
    items.push(["Allowed items: ", ...joined(itemSchema.enum.map((v) => code(formatValue(v))), ", ")]);
  }
  if (typeof schema.format === "string") items.push(["Format: ", code(schema.format)]);
  const bound = (label: string, key: string): void => {
    if (typeof schema[key] === "number") items.push([`${label}: ${String(schema[key])}`]);
  };
  bound("Minimum", "minimum");
  bound("Exclusive minimum", "exclusiveMinimum");
  bound("Maximum", "maximum");
  bound("Exclusive maximum", "exclusiveMaximum");
  bound("Minimum length", "minLength");
  bound("Maximum length", "maxLength");
  bound("Minimum items", "minItems");
  bound("Maximum items", "maxItems");
  if (typeof schema.pattern === "string") items.push(["Pattern: ", code(schema.pattern)]);
  if (schema.readOnly === true) items.push(["Read-only"]);
  if (schema.writeOnly === true) items.push(["Write-only"]);
  if (items.length === 0) return [];
  return [h("ul", { className: ["constraints"] }, items.map((item) => h("li", null, item)))];
}

function tableWrap(b: Builder, caption: string, columns: string[], rows: Element[], className: string): Element {
  b.tables += 1;
  const id = `table-${b.tables}`;
  return h(
    "div",
    { className: ["table-wrap"], role: "region", tabIndex: 0, ariaLabelledBy: [id] },
    h(
      "table",
      { className: [className] },
      h("caption", { id }, caption),
      h("thead", null, h("tr", null, columns.map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", null, rows),
    ),
  );
}

const SCHEMA_COLUMNS = ["Name", "Type", "Required", "Description", "Default / allowed values"];

function schemaTable(b: Builder, caption: string, rows: Row[]): Element {
  return tableWrap(
    b,
    caption,
    SCHEMA_COLUMNS,
    rows.map((row) =>
      h(
        "tr",
        { className: [`depth-${row.depth}`] },
        h("th", { scope: "row" }, code(row.name)),
        h("td", null, row.type),
        h("td", null, row.required ? "required" : "optional"),
        h("td", null, row.deprecated ? h("strong", null, "Deprecated. ") : null, markdownInline(b, row.description)),
        h("td", null, constraintItems(b, row.schema)),
      ),
    ),
    "schema-table",
  );
}

function collectRows(
  b: Builder,
  schema: unknown,
  mode: "request" | "response",
  prefix = "",
  depth = 1,
  seen: ReadonlySet<string> = new Set(),
  rows: Row[] = [],
): Row[] {
  const doc = b.model.doc;
  const ref = refOf(schema);
  if (ref && seen.has(ref)) return rows;
  const nextSeen = ref ? new Set([...seen, ref]) : seen;
  const flat = flatten(doc, schema);
  for (const [name, propSchema] of Object.entries(flat.properties)) {
    const resolved = resolve(doc, propSchema) ?? {};
    if (resolved["x-internal"] === true && !b.model.includeInternal) continue;
    if (mode === "request" && resolved.readOnly === true) continue;
    if (mode === "response" && resolved.writeOnly === true) continue;
    rows.push({
      name: `${prefix}${name}`,
      depth,
      type: schemaTypeLabel(doc, propSchema),
      required: flat.required.includes(name),
      // OpenAPI 3.1 allows a description next to a $ref.
      description: asString((propSchema as JsonObject).description) ?? asString(resolved.description),
      schema: resolved,
      deprecated: resolved.deprecated === true,
    });
    if (depth < MAX_PROPERTY_DEPTH) {
      const nested = nestedObject(doc, propSchema);
      const nestedRef = nested ? refOf(nested.schema) : undefined;
      if (nested && !(nestedRef && nextSeen.has(nestedRef))) {
        collectRows(b, nested.schema, mode, `${prefix}${name}${nested.suffix}.`, depth + 1, nextSeen, rows);
      }
    }
  }
  return rows;
}

/** Schema of a body or response: properties table, array items, or oneOf/anyOf variants. */
function schemaSection(b: Builder, schema: unknown, label: string, mode: "request" | "response"): ElementContent[] {
  const doc = b.model.doc;
  const resolved = resolve(doc, schema);
  if (!resolved) return [];
  const out: ElementContent[] = [];
  const ref = refOf(schema);
  if (ref) out.push(h("p", { className: ["schema-name"] }, "Schema: ", code(refName(ref))));
  const alternatives = variants(resolved);
  if (alternatives && Object.keys(flatten(doc, schema).properties).length === 0) {
    const names = alternatives.list.map((v, i) => variantName(doc, v, i));
    out.push(
      h("p", null, alternatives.kind === "oneOf" ? "Exactly one of these schemas:" : "Any of these schemas:"),
      h("ul", null, names.map((name) => h("li", null, code(name)))),
    );
    alternatives.list.forEach((variant, i) => {
      const rows = collectRows(b, variant, mode);
      if (rows.length > 0) out.push(schemaTable(b, `${label}, option ${i + 1}: ${names[i] ?? ""}`, rows));
    });
    return out;
  }
  const types = schemaTypes(resolved);
  if (types.includes("array") && !types.includes("object")) {
    out.push(h("p", null, "Type: ", schemaTypeLabel(doc, schema)));
    const rows = collectRows(b, resolved.items, mode);
    if (rows.length > 0) out.push(schemaTable(b, `${label}: array items`, rows));
    return out;
  }
  const rows = collectRows(b, schema, mode);
  if (rows.length > 0) out.push(schemaTable(b, label, rows));
  else out.push(h("p", null, "Type: ", schemaTypeLabel(doc, schema)), ...(constraintItems(b, resolved) as ElementContent[]));
  return out;
}

const STATUS_TEXT: Record<string, string> = {
  "100": "Continue",
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "206": "Partial Content",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "412": "Precondition Failed",
  "413": "Content Too Large",
  "415": "Unsupported Media Type",
  "422": "Unprocessable Content",
  "428": "Precondition Required",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
  default: "Default response",
};

function statusTitle(code: string): string {
  const text = STATUS_TEXT[code] ?? (/^[1-5]XX$/i.test(code) ? `${code.charAt(0)}xx responses` : "");
  return code === "default" ? text : `${code} ${text}`.trim();
}

interface ServerInfo {
  url: string;
  description?: string | undefined;
}

function serverList(doc: OpenApiDocument, ...levels: unknown[]): ServerInfo[] {
  const declared = levels.map(asArray).find((list) => list.length > 0) ?? [];
  const out: ServerInfo[] = [];
  for (const raw of declared) {
    const server = resolve(doc, raw);
    if (!server || typeof server.url !== "string") continue;
    const vars = (server.variables ?? {}) as Record<string, { default?: unknown }>;
    const url = server.url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const value = vars[name]?.default;
      return value === undefined ? whole : String(value);
    });
    out.push({ url, description: asString(server.description) });
  }
  return out;
}

interface SchemeInfo {
  name: string;
  type: string;
  details: string;
  description?: string | undefined;
}

function schemeInfo(doc: OpenApiDocument, name: string): SchemeInfo {
  const scheme = resolve(doc, doc.components?.securitySchemes?.[name]) ?? {};
  const type = String(scheme.type ?? "unknown");
  let details = "";
  switch (type.toLowerCase()) {
    case "http": {
      const httpScheme = String(scheme.scheme ?? "").toLowerCase();
      details = httpScheme === "bearer" ? `HTTP bearer token${typeof scheme.bearerFormat === "string" ? ` (${scheme.bearerFormat})` : ""}` : `HTTP ${httpScheme || "authentication"}`;
      break;
    }
    case "apikey":
      details = `API key in ${String(scheme.in ?? "header")} "${String(scheme.name ?? "")}"`;
      break;
    case "oauth2":
      details = `OAuth 2.0 (${Object.keys((scheme.flows ?? {}) as JsonObject).join(", ") || "flows not specified"})`;
      break;
    case "openidconnect":
      details = `OpenID Connect${typeof scheme.openIdConnectUrl === "string" ? ` (${scheme.openIdConnectUrl})` : ""}`;
      break;
    case "mutualtls":
      details = "Mutual TLS";
      break;
    default:
      details = type;
  }
  return { name, type, details, description: asString(scheme.description) };
}

function securitySection(b: Builder, op: ApiOperationModel): ElementContent[] {
  const doc = b.model.doc;
  const declared = op.operation.security !== undefined ? op.operation.security : doc.security;
  const requirements = asArray(declared).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (declared === undefined) return [h("p", null, "No security requirements are declared for this operation.")];
  if (requirements.length === 0) return [h("p", null, "This operation does not require authentication.")];
  const describe = (requirement: Record<string, unknown>): HChild[] => {
    const names = Object.keys(requirement);
    if (names.length === 0) return ["No authentication (anonymous access allowed)"];
    return joined(
      names.map((name) => {
        const info = schemeInfo(doc, name);
        const scopes = asArray(requirement[name]).filter((s): s is string => typeof s === "string");
        return [code(name), ` — ${info.details}`, scopes.length > 0 ? [" (scopes: ", ...joined(scopes.map(code), ", "), ")"] : null];
      }),
      " and ",
    );
  };
  if (requirements.length === 1 && requirements[0]) return [h("p", null, "Requires ", describe(requirements[0]), ".")];
  return [h("p", null, "Requires one of:"), h("ul", null, requirements.map((r) => h("li", null, describe(r))))];
}

function operationList(ops: readonly ApiOperationModel[]): Element {
  return h(
    "ul",
    { className: ["operation-list"] },
    ops.map((op) =>
      h(
        "li",
        null,
        h(
          "a",
          { href: href(op.url) },
          methodBadge(op.method),
          " ",
          h("code", { className: ["api-path"] }, op.path),
          op.summary ? [" ", h("span", { className: ["api-summary"] }, op.summary)] : null,
        ),
        op.deprecated ? h("span", { className: ["deprecated-label"] }, " (deprecated)") : null,
      ),
    ),
  );
}

function generatedFooter(model: ApiModel): ElementContent[] {
  const version = asString(model.doc.info?.version);
  return [
    h(
      "p",
      { className: ["generated-note"] },
      "Generated from the ",
      code(model.sourceId),
      " OpenAPI document",
      version ? ` (version ${version})` : "",
      ".",
    ),
  ];
}

function firstMediaSchema(content: unknown): unknown {
  if (!content || typeof content !== "object") return undefined;
  const first = Object.values(content as Record<string, unknown>)[0];
  return first && typeof first === "object" ? (first as JsonObject).schema : undefined;
}

function parameterRows(b: Builder, params: readonly JsonObject[]): Row[] {
  const doc = b.model.doc;
  return params.map((param) => {
    const schema = param.schema ?? firstMediaSchema(param.content);
    return {
      name: String(param.name),
      depth: 1,
      type: schemaTypeLabel(doc, schema),
      required: param.in === "path" || param.required === true,
      description: asString(param.description),
      schema: resolve(doc, schema) ?? {},
      deprecated: param.deprecated === true,
    };
  });
}

function tryItSection(b: Builder, op: ApiOperationModel, servers: ServerInfo[], body: { contentType: string; example: string } | undefined): Element {
  const doc = b.model.doc;
  const field = (...children: HChild[]): Element => h("div", { className: ["field"] }, children);
  const params = op.parameters.filter((p) => p.in !== "cookie");
  const paramFields = params.map((param) => {
    const location = String(param.in);
    const name = String(param.name);
    const id = `try-it-${slugify(location)}-${slugify(name, "param")}`;
    const hintId = `${id}-hint`;
    const required = location === "path" || param.required === true;
    const schema = resolve(doc, param.schema ?? firstMediaSchema(param.content)) ?? {};
    const options = Array.isArray(schema.enum) ? schema.enum : schemaTypes(schema).includes("boolean") ? [true, false] : undefined;
    const common = { id, dataParamIn: location, dataParamName: name, required, ariaDescribedBy: [hintId] };
    const control = options
      ? h(
          "select",
          common,
          h("option", { value: "" }, required ? "Choose a value" : "Not set"),
          options.map((value) => h("option", { value: formatValue(value) }, formatValue(value))),
        )
      : h("input", { ...common, type: "text", autoComplete: ["off"], spellCheck: "false" });
    const hint = [`${location} parameter`, schemaTypeLabel(doc, param.schema ?? firstMediaSchema(param.content))];
    if (schema.default !== undefined) hint.push(`default ${formatValue(schema.default)}`);
    return field(
      h("label", { htmlFor: [id] }, name, required ? " (required)" : null),
      control,
      h("p", { id: hintId, className: ["hint"] }, hint.join(" · ")),
    );
  });
  const serverOptions = servers.length > 0 ? servers : [{ url: "/", description: "This site" }];
  return h(
    "section",
    { className: ["try-it"], dataTryIt: "", hidden: true, ariaLabelledBy: ["try-it"] },
    h("h2", { id: "try-it" }, "Try it"),
    h(
      "p",
      { className: ["hint"] },
      "Send a real request from your browser. The API must allow cross-origin requests from this site.",
    ),
    h(
      "form",
      { className: ["try-it-form"], dataMethod: op.method, dataPath: op.path },
      field(
        h("label", { htmlFor: ["try-it-server"] }, "Server"),
        h(
          "select",
          { id: "try-it-server", name: "server" },
          serverOptions.map((s) => h("option", { value: s.url }, s.description ? `${s.description} (${s.url})` : s.url)),
        ),
      ),
      field(
        h("label", { htmlFor: ["try-it-token"] }, "Bearer token"),
        h("input", {
          id: "try-it-token",
          name: "token",
          type: "password",
          autoComplete: ["off"],
          spellCheck: "false",
          ariaDescribedBy: ["try-it-token-hint"],
        }),
        h("p", { id: "try-it-token-hint", className: ["hint"] }, "Kept in memory for this tab only. It is never stored or logged."),
      ),
      paramFields.length > 0 ? h("fieldset", null, h("legend", null, "Parameters"), paramFields) : null,
      body
        ? field(
            h("label", { htmlFor: ["try-it-body"] }, `Request body (${body.contentType})`),
            h("textarea", { id: "try-it-body", name: "body", rows: 10, spellCheck: "false", dataContentType: body.contentType }, body.example),
          )
        : null,
      h("button", { type: "submit", className: ["button"] }, "Send request"),
    ),
    h("h3", { id: "try-it-response-title" }, "Response"),
    h("pre", { className: ["try-it-response"], ariaLive: "polite", ariaLabelledBy: ["try-it-response-title"], tabIndex: 0 }),
  );
}

function renderOperationPage(b: Builder, op: ApiOperationModel): ReferencePage {
  const doc = b.model.doc;
  const body: ElementContent[] = [];
  const toc: TocEntry[] = [];
  const section = (id: string, title: string): Element => {
    toc.push({ depth: 2, id, text: title });
    return h("h2", { id }, title);
  };

  body.push(h("h1", null, methodBadge(op.method), " ", h("code", { className: ["api-path"] }, op.path)));
  if (op.summary) body.push(h("p", { className: ["api-summary", "lead"] }, op.summary));
  if (op.deprecated) {
    body.push(callout("caution", "Deprecated", [h("p", null, "This operation is deprecated and may be removed in a future version.")]));
  }
  body.push(...markdown(b, op.description, 1));

  // Parameters, one table per location.
  if (op.parameters.length > 0) {
    body.push(section("parameters", "Parameters"));
    for (const [location, caption] of PARAMETER_LOCATIONS) {
      const params = op.parameters.filter((p) => p.in === location);
      if (params.length > 0) body.push(schemaTable(b, caption, parameterRows(b, params)));
    }
  }

  // Request body.
  const requestBody = resolve(doc, op.operation.requestBody);
  const requestContent = (resolve(doc, requestBody?.content) ?? {}) as Record<string, JsonObject>;
  const requestTypes = Object.keys(requestContent);
  if (requestBody) {
    body.push(section("request-body", "Request body"));
    body.push(
      h(
        "p",
        null,
        requestBody.required === true ? "Required." : "Optional.",
        requestTypes.length > 0 ? [" Content type: ", ...joined(requestTypes.map(code), ", "), "."] : null,
      ),
    );
    body.push(...markdown(b, asString(requestBody.description), 2));
    const shown = new Set<string>();
    for (const type of requestTypes) {
      const schema = requestContent[type]?.schema;
      const key = JSON.stringify(schema ?? null);
      if (shown.has(key)) continue;
      shown.add(key);
      body.push(...schemaSection(b, schema, `Request body (${type})`, "request"));
    }
  }

  // Responses.
  body.push(section("responses", "Responses"));
  const responses = (resolve(doc, op.operation.responses) ?? {}) as Record<string, unknown>;
  const codes = Object.keys(responses);
  if (codes.length === 0) body.push(h("p", null, "No responses are documented."));
  for (const status of codes) {
    const response = resolve(doc, responses[status]) ?? {};
    const id = `response-${slugify(status)}`;
    const title = statusTitle(status);
    toc.push({ depth: 3, id, text: title });
    body.push(h("h3", { id }, title));
    body.push(...markdown(b, asString(response.description), 3));
    const headers = Object.entries((resolve(doc, response.headers) ?? {}) as Record<string, unknown>);
    if (headers.length > 0) {
      const rows: Row[] = headers.map(([name, raw]) => {
        const header = resolve(doc, raw) ?? {};
        return {
          name,
          depth: 1,
          type: schemaTypeLabel(doc, header.schema),
          required: header.required === true,
          description: asString(header.description),
          schema: resolve(doc, header.schema) ?? {},
          deprecated: header.deprecated === true,
        };
      });
      body.push(schemaTable(b, `${title}: response headers`, rows));
    }
    const content = (resolve(doc, response.content) ?? {}) as Record<string, JsonObject>;
    for (const [type, media] of Object.entries(content)) {
      body.push(h("p", null, "Content type: ", code(type)));
      body.push(...schemaSection(b, media?.schema, `${title} response body (${type})`, "response"));
    }
  }

  // Security.
  body.push(section("security", "Security"));
  body.push(...securitySection(b, op));

  // Generated code samples.
  const servers = serverList(doc, op.operation.servers, op.pathItem.servers, doc.servers);
  const firstType = requestTypes[0];
  const example = firstType ? mediaExample(doc, requestContent[firstType]) : undefined;
  const required = (location: string): string[] =>
    op.parameters.filter((p) => p.in === location && p.required === true).map((p) => String(p.name));
  const request: SampleRequest = {
    method: op.method,
    path: op.path,
    serverUrl: servers[0]?.url ?? "{baseUrl}",
    query: required("query"),
    headers: required("header"),
    auth: authSample(doc, op.operation.security !== undefined ? op.operation.security : doc.security),
    body: firstType && example !== undefined ? { contentType: firstType, value: example } : undefined,
  };
  body.push(section("code-samples", "Code samples"));
  body.push(
    tabsGroup(
      [
        { label: "curl", children: [codeBlock(curlSample(request), "bash")] },
        { label: "JavaScript", children: [codeBlock(fetchSample(request), "javascript")] },
      ],
      3,
      "code-group",
    ),
  );

  // Try it (progressive enhancement; hidden until the script enables it).
  const bodyExample =
    firstType && example !== undefined
      ? { contentType: firstType, example: typeof example === "string" ? example : JSON.stringify(example, null, 2) }
      : requestBody && firstType
        ? { contentType: firstType, example: "" }
        : undefined;
  body.push(tryItSection(b, op, servers, bodyExample));

  const title = op.summary ?? `${op.method} ${op.path}`;
  const text = plainText(body);
  return {
    kind: "operation",
    url: op.url,
    outPath: op.outPath,
    title,
    description: summarize(op.summary ? `${op.method} ${op.path}: ${op.summary}` : `${op.method} ${op.path}`),
    body,
    toc,
    footer: generatedFooter(b.model),
    articleId: `op-${op.slug}`,
    search: { headings: toc.map((t) => t.text), text: firstWords(text) },
  };
}

function renderIndexPage(b: Builder): ReferencePage {
  const { model } = b;
  const doc = model.doc;
  const body: ElementContent[] = [];
  const toc: TocEntry[] = [];
  const section = (id: string, title: string): Element => {
    toc.push({ depth: 2, id, text: title });
    return h("h2", { id }, title);
  };
  const apiTitle = asString(doc.info?.title) ?? model.title;
  body.push(h("h1", null, apiTitle));
  const version = asString(doc.info?.version);
  body.push(
    h(
      "p",
      { className: ["api-meta"] },
      version ? ["Version ", code(version)] : null,
      version && doc.openapi ? " · " : null,
      doc.openapi ? ["OpenAPI ", String(doc.openapi)] : null,
    ),
  );
  const intro = markdown(b, asString(doc.info?.description), 1);
  body.push(...intro);

  const servers = serverList(doc, doc.servers);
  if (servers.length > 0) {
    body.push(section("servers", "Servers"));
    body.push(h("ul", { className: ["server-list"] }, servers.map((s) => h("li", null, code(s.url), s.description ? ` — ${s.description}` : null))));
  }

  const schemeNames = Object.keys(doc.components?.securitySchemes ?? {});
  if (schemeNames.length > 0) {
    body.push(section("authentication", "Authentication"));
    const rows = schemeNames.map((name) => {
      const info = schemeInfo(doc, name);
      return h(
        "tr",
        null,
        h("th", { scope: "row" }, code(name)),
        h("td", null, info.type),
        h("td", null, info.details),
        h("td", null, markdownInline(b, info.description)),
      );
    });
    body.push(tableWrap(b, "Security schemes", ["Name", "Type", "Details", "Description"], rows, "schema-table"));
  }

  for (const tag of model.tags) {
    body.push(section(`tag-${tag.slug}`, tag.name));
    body.push(...markdown(b, tag.description, 2));
    body.push(operationList(tag.operations));
  }
  if (model.untagged.length > 0) {
    body.push(section("other-operations", model.tags.length > 0 ? "Other operations" : "Operations"));
    body.push(operationList(model.untagged));
  }
  if (model.operations.length === 0) body.push(h("p", null, "This API has no public operations."));

  return {
    kind: "index",
    url: model.url,
    outPath: model.outPath,
    title: model.title,
    description: summarize(plainText(intro) || apiTitle),
    body,
    toc,
    footer: generatedFooter(model),
    search: { headings: toc.map((t) => t.text), text: firstWords(plainText(body)) },
  };
}

function renderTagPage(b: Builder, tag: ApiTagModel): ReferencePage {
  const intro = markdown(b, tag.description, 1);
  const body: ElementContent[] = [
    h("h1", null, tag.name),
    h("p", { className: ["api-meta"] }, h("a", { href: href(b.model.url) }, b.model.title)),
    ...intro,
    operationList(tag.operations),
  ];
  return {
    kind: "tag",
    url: tag.url,
    outPath: tag.outPath,
    title: `${tag.name} · ${b.model.title}`,
    description: summarize(plainText(intro) || `${tag.name} operations`),
    body,
    toc: [],
    footer: generatedFooter(b.model),
    search: { headings: tag.operations.map((op) => op.summary ?? `${op.method} ${op.path}`), text: firstWords(plainText(body)) },
  };
}

/** Index, tag and operation pages for one OpenAPI source. */
export function renderApiReference(model: ApiModel, ctx: RenderContext): ReferencePage[] {
  const pages: ReferencePage[] = [renderIndexPage(newBuilder(ctx, model))];
  for (const tag of model.tags) pages.push(renderTagPage(newBuilder(ctx, model), tag));
  for (const op of model.operations) pages.push(renderOperationPage(newBuilder(ctx, model), op));
  return pages;
}
