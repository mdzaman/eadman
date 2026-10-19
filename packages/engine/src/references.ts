import type { DocReference, EntityDefinition } from "@docops/core";
import { frontmatterList, type ParsedPage } from "@docops/markdown";

export type MentionMode = "contextual" | "strict" | "off";

export interface ReferenceIndexOptions {
  mentions?: MentionMode;
  /** sourceKey -> route prefix of generated reference pages (docops.yaml sources[].reference.outDir). */
  referenceOutDirs?: Map<string, string>;
}

export interface UnresolvedReference {
  pagePath: string;
  ref: string;
  line: number;
}

export interface ReferenceIndex {
  references: DocReference[];
  unresolved: UnresolvedReference[];
  /** pagePath -> references, for quick lookups. */
  byPage: Map<string, DocReference[]>;
  /** entityKey -> references. */
  byEntity: Map<string, DocReference[]>;
}

const HTTP_METHOD = "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)";

/**
 * Generic surface forms (`amount`, `limit`, `Payment`) only count as references when the
 * surrounding context already references a related entity (docs/07-ai-design.md §3.3).
 */
export function isDistinctive(form: string): boolean {
  if (/[/._\-{}:\s]/.test(form) || /\d/.test(form)) return true;
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(form)) return true;
  if ((form.match(/[A-Z]/g) ?? []).length >= 2) return true;
  return form.length >= 12;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateRegExp(path: string): RegExp {
  const pattern = path
    .split("/")
    .map((segment) => (/^\{[^}]+\}$/.test(segment) ? "[^/]+" : escapeRegExp(segment)))
    .join("/");
  return new RegExp(`^${pattern}/?$`);
}

function literalSegments(path: string): number {
  return path.split("/").filter((s) => s && !s.startsWith("{")).length;
}

interface OperationInfo {
  entity: EntityDefinition;
  method: string;
  path: string;
  matcher: RegExp;
  requestSchema?: string | undefined;
}

class EntityLookup {
  readonly byKey = new Map<string, EntityDefinition>();
  readonly bySurface = new Map<string, EntityDefinition[]>();
  readonly operations: OperationInfo[] = [];
  readonly byOperationId = new Map<string, EntityDefinition[]>();
  readonly childrenOf = new Map<string, EntityDefinition[]>();

  constructor(entities: readonly EntityDefinition[]) {
    for (const e of entities) {
      this.byKey.set(e.key, e);
      for (const form of e.surfaceForms) {
        const list = this.bySurface.get(form) ?? [];
        list.push(e);
        this.bySurface.set(form, list);
      }
      if (e.parentKey) {
        const list = this.childrenOf.get(e.parentKey) ?? [];
        list.push(e);
        this.childrenOf.set(e.parentKey, list);
      }
      if (e.kind === "api.operation") {
        const method = String(e.attributes.method ?? "");
        const path = String(e.attributes.path ?? "");
        const body = e.attributes.requestBody as { schema?: { ref?: string } } | undefined;
        this.operations.push({ entity: e, method, path, matcher: templateRegExp(path), requestSchema: body?.schema?.ref });
        const opId = e.attributes.operationId;
        if (typeof opId === "string") {
          const list = this.byOperationId.get(opId) ?? [];
          list.push(e);
          this.byOperationId.set(opId, list);
        }
      }
    }
  }

  /** Resolve a user-written reference: full key, `src:METHOD /path`, `src#operationId`, `METHOD /path`. */
  resolve(ref: string): EntityDefinition[] {
    const trimmed = ref.trim();
    const direct = this.byKey.get(trimmed);
    if (direct) return [direct];
    const hash = /^([\w-]+)#(\w+)$/.exec(trimmed);
    if (hash) return (this.byOperationId.get(hash[2] ?? "") ?? []).filter((e) => e.sourceKey === hash[1]);
    const shorthand = new RegExp(`^(?:([\\w-]+):)?${HTTP_METHOD}\\s+(\\S+)$`).exec(trimmed);
    if (shorthand) {
      const [, source, method, path] = shorthand;
      return this.operations
        .filter((o) => o.method === method && o.path === path && (!source || o.entity.sourceKey === source))
        .map((o) => o.entity);
    }
    const kindPrefixed = /^([a-z]+\.[a-z]+):([\w-]+):(.+)$/.exec(trimmed);
    if (kindPrefixed) return [];
    return [];
  }

  /** Operations matching an HTTP method + concrete or templated path. Best literal match wins. */
  matchOperation(method: string, path: string): EntityDefinition[] {
    const clean = path.split("?")[0]?.split("#")[0] ?? path;
    const candidates = this.operations.filter((o) => o.method === method && (o.path === clean || o.matcher.test(clean)));
    if (candidates.length <= 1) return candidates.map((c) => c.entity);
    const best = Math.max(...candidates.map((c) => literalSegments(c.path)));
    return candidates.filter((c) => literalSegments(c.path) === best).map((c) => c.entity);
  }

  requestSchemaOf(op: EntityDefinition): string | undefined {
    return this.operations.find((o) => o.entity.key === op.key)?.requestSchema;
  }
}

/** Find HTTP requests in a code block: curl, fetch(), and raw HTTP request lines. */
export function findHttpRequests(code: string): Array<{ method: string; path: string; lineOffset: number }> {
  const results: Array<{ method: string; path: string; lineOffset: number }> = [];
  const lines = code.split("\n");
  const pathFromUrl = (url: string): string | null => {
    const withoutVars = url.replace(/^\{\{\s*[\w.]+\s*\}\}/, "").replace(/^\$\{?[\w.]+\}?/, "");
    const m = /^(?:https?:\/\/[^/\s'"]+)?(\/[^\s'"`?#]*)/.exec(withoutVars);
    return m?.[1] ?? null;
  };
  // Join backslash continuations for curl.
  for (let i = 0; i < lines.length; i++) {
    let statement = lines[i] ?? "";
    const start = i;
    while (statement.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      statement = `${statement.trimEnd().slice(0, -1)} ${lines[++i] ?? ""}`;
    }
    const raw = new RegExp(`^\\s*${HTTP_METHOD}\\s+(\\/\\S*)\\s+HTTP\\/`).exec(statement);
    if (raw?.[1] && raw[2]) {
      results.push({ method: raw[1], path: raw[2], lineOffset: start });
      continue;
    }
    if (/\bcurl\b/.test(statement)) {
      const explicit = /(?:-X|--request)\s+["']?([A-Z]+)/.exec(statement)?.[1];
      const hasBody = /\s(?:-d|--data(?:-raw|-binary)?|--json|-F|--form)\b/.test(statement);
      const urlToken = /(?:^|\s)["']?((?:https?:\/\/|\{\{\s*[\w.]+\s*\}\}|\$\{?[\w.]+\}?)[^\s'"]*)/.exec(statement.replace(/\bcurl\b/, ""))?.[1];
      const path = urlToken ? pathFromUrl(urlToken) : null;
      if (path) results.push({ method: explicit ?? (hasBody ? "POST" : "GET"), path, lineOffset: start });
      continue;
    }
    const fetchCall = /\bfetch\(\s*[`"']([^`"']+)[`"']/.exec(statement);
    if (fetchCall?.[1]) {
      const path = pathFromUrl(fetchCall[1].replace(/\$\{[^}]+\}/, ""));
      const rest = lines.slice(start, Math.min(lines.length, start + 8)).join("\n");
      const method = /method:\s*["'](\w+)["']/.exec(rest)?.[1]?.toUpperCase() ?? "GET";
      if (path) results.push({ method, path, lineOffset: start });
    }
  }
  return results;
}

function pushRef(index: ReferenceIndex, ref: DocReference): void {
  const key = `${ref.pagePath}|${ref.entityKey}|${ref.kind}|${ref.line ?? ""}`;
  const existing = index.byPage.get(ref.pagePath) ?? [];
  if (existing.some((r) => `${r.pagePath}|${r.entityKey}|${r.kind}|${r.line ?? ""}` === key)) return;
  existing.push(ref);
  index.byPage.set(ref.pagePath, existing);
  const byEntity = index.byEntity.get(ref.entityKey) ?? [];
  byEntity.push(ref);
  index.byEntity.set(ref.entityKey, byEntity);
  index.references.push(ref);
}

function lineOfText(source: string, needle: string, fallback: number): number {
  const at = source.indexOf(needle);
  return at < 0 ? fallback : source.slice(0, at).split("\n").length;
}

/**
 * Build the reference index: which pages describe which entities, how, and where.
 * Pass the entity set the pages should be checked against (base entities for drift,
 * head entities for coverage).
 */
export function buildReferenceIndex(
  pages: readonly ParsedPage[],
  entities: readonly EntityDefinition[],
  options: ReferenceIndexOptions = {},
): ReferenceIndex {
  const mode = options.mentions ?? "contextual";
  const lookup = new EntityLookup(entities);
  const index: ReferenceIndex = { references: [], unresolved: [], byPage: new Map(), byEntity: new Map() };
  const ref = (page: ParsedPage, e: EntityDefinition, kind: DocReference["kind"], line: number | undefined, confidence: number, matchedText?: string) =>
    pushRef(index, { pagePath: page.path, entityKey: e.key, kind, line, confidence, entityFingerprint: e.fingerprint, matchedText });

  for (const page of pages) {
    // Context sets for resolving generic mentions: entity keys referenced per section and per page.
    const sectionContext = new Map<number, Set<string>>();
    const pageContext = new Set<string>();
    const addContext = (section: number | undefined, e: EntityDefinition) => {
      pageContext.add(e.key);
      for (const k of e.related ?? []) pageContext.add(k);
      if (section === undefined) return;
      const set = sectionContext.get(section) ?? new Set<string>();
      set.add(e.key);
      for (const k of e.related ?? []) set.add(k);
      sectionContext.set(section, set);
    };

    // 1. Explicit references from frontmatter.
    for (const raw of frontmatterList(page, "entities")) {
      const resolved = lookup.resolve(raw);
      const line = lineOfText(page.source, raw, 1);
      if (resolved.length === 0) {
        index.unresolved.push({ pagePath: page.path, ref: raw, line });
        continue;
      }
      for (const e of resolved) {
        ref(page, e, "explicit", line, 1);
        addContext(undefined, e);
      }
    }

    // 2. Links to generated reference pages.
    for (const link of page.links) {
      if (link.kind !== "internal") continue;
      for (const [sourceKey, outDir] of options.referenceOutDirs ?? []) {
        const m = new RegExp(`${escapeRegExp(outDir.replace(/^\/|\/$/g, ""))}/operations/([\\w.-]+)`).exec(link.url);
        if (!m?.[1]) continue;
        for (const e of (lookup.byOperationId.get(m[1]) ?? []).filter((x) => x.sourceKey === sourceKey)) {
          ref(page, e, "link", link.line, 1);
          addContext(link.section, e);
        }
      }
    }

    // 3. Code samples: HTTP requests and JSON body keys.
    for (const block of page.codeBlocks) {
      for (const request of findHttpRequests(block.value)) {
        const line = block.line + 1 + request.lineOffset;
        for (const op of lookup.matchOperation(request.method, request.path)) {
          ref(page, op, "code_sample", line, 0.9, `${request.method} ${request.path}`);
          addContext(block.section, op);
          const schemaName = lookup.requestSchemaOf(op);
          const bodyProps = [
            ...(schemaName ? lookup.childrenOf.get(`api.schema:${op.sourceKey}:${schemaName}`) ?? [] : []),
            ...(lookup.childrenOf.get(op.key) ?? []).filter((c) => c.kind === "api.property"),
          ];
          block.value.split("\n").forEach((text, offset) => {
            for (const m of text.matchAll(/["']([A-Za-z_][\w-]*)["']\s*:/g)) {
              const prop = bodyProps.find((p) => p.name === m[1]);
              if (prop) ref(page, prop, "code_sample", block.line + 1 + offset, 0.9, m[1]);
            }
          });
        }
      }
    }

    if (mode === "off") continue;

    // 4. Distinctive mentions in inline code (and code blocks), then generic ones in context.
    const generic: Array<{ value: string; line: number; section: number }> = [];
    for (const code of page.inlineCode) {
      const value = code.value.trim();
      const methodPath = new RegExp(`^${HTTP_METHOD}\\s+(\\/\\S*)$`).exec(value);
      if (methodPath?.[1] && methodPath[2]) {
        for (const op of lookup.matchOperation(methodPath[1], methodPath[2])) {
          ref(page, op, "mention", code.line, 0.95, value);
          addContext(code.section, op);
        }
        continue;
      }
      const candidates = lookup.bySurface.get(value);
      if (!candidates) continue;
      if (isDistinctive(value)) {
        for (const e of candidates) {
          ref(page, e, "mention", code.line, value.startsWith("/") ? 0.7 : 0.85, value);
          addContext(code.section, e);
        }
      } else {
        generic.push({ value, line: code.line, section: code.section });
      }
    }
    for (const block of page.codeBlocks) {
      if (findHttpRequests(block.value).length > 0 && !/[A-Z][A-Z0-9_]{3,}/.test(block.value)) continue;
      block.value.split("\n").forEach((text, offset) => {
        for (const token of text.match(/[A-Za-z_][\w.-]*[\w]/g) ?? []) {
          if (!isDistinctive(token) || !/[A-Z_]/.test(token)) continue;
          for (const e of lookup.bySurface.get(token) ?? []) {
            if (e.kind === "config.key" || e.kind === "api.webhook") {
              ref(page, e, "mention", block.line + 1 + offset, 0.85, token);
              addContext(block.section, e);
            }
          }
        }
      });
    }
    if (mode === "strict") {
      for (const block of page.textBlocks) {
        for (const [form, list] of lookup.bySurface) {
          if (!isDistinctive(form) || form.length < 6) continue;
          if (!new RegExp(`(^|[^\\w/])${escapeRegExp(form)}($|[^\\w/])`).test(block.text)) continue;
          for (const e of list) ref(page, e, "mention", block.line, 0.6, form);
        }
      }
    }
    for (const g of generic) {
      const section = sectionContext.get(g.section);
      for (const e of lookup.bySurface.get(g.value) ?? []) {
        const contextKeys = [e.parentKey, ...(e.related ?? [])].filter((k): k is string => Boolean(k));
        const inSection = contextKeys.some((k) => section?.has(k));
        const inPage = contextKeys.some((k) => pageContext.has(k));
        if (inSection || inPage) ref(page, e, "mention", g.line, inSection ? 0.8 : 0.6, g.value);
      }
    }
  }
  return index;
}
