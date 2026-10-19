import { LineCounter, parseDocument, type Document } from "yaml";
import { fingerprint, type EntityDefinition, type Visibility } from "@docops/core";

export type JsonObject = Record<string, unknown>;

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"] as const;

export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, JsonObject>;
  webhooks?: Record<string, JsonObject>;
  components?: { schemas?: Record<string, JsonObject>; securitySchemes?: Record<string, JsonObject>; [k: string]: unknown };
  tags?: Array<{ name: string; description?: string }>;
  security?: Array<Record<string, string[]>>;
  [key: string]: unknown;
}

export interface LoadedOpenApi {
  document: OpenApiDocument;
  yaml: Document;
  lineCounter: LineCounter;
}

export class OpenApiError extends Error {}

export function loadOpenApi(content: string): LoadedOpenApi {
  const lineCounter = new LineCounter();
  const yaml = parseDocument(content, { lineCounter });
  if (yaml.errors.length > 0) throw new OpenApiError(`invalid YAML/JSON: ${yaml.errors[0]?.message.split("\n")[0]}`);
  const document = yaml.toJS({ maxAliasCount: 100 }) as OpenApiDocument;
  if (!document || typeof document !== "object" || (!document.openapi && !document.swagger)) {
    throw new OpenApiError("not an OpenAPI document (missing `openapi` field)");
  }
  if (document.swagger) throw new OpenApiError("Swagger 2.0 is not supported; convert to OpenAPI 3.x");
  return { document, yaml, lineCounter };
}

/** Resolve a local JSON pointer `$ref` (`#/components/schemas/Payment`). Remote refs are refused (SSRF). */
export function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new OpenApiError(`remote $ref not allowed: ${ref}`);
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as JsonObject)[key];
  }
  return node;
}

export function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

/** Follow `$ref` chains (with cycle protection). */
export function deref<T = JsonObject>(doc: unknown, value: unknown, seen = new Set<string>()): T | undefined {
  let current = value;
  while (current && typeof current === "object" && typeof (current as JsonObject).$ref === "string") {
    const ref = (current as JsonObject).$ref as string;
    if (seen.has(ref)) return undefined;
    seen.add(ref);
    current = resolvePointer(doc, ref);
  }
  return current as T | undefined;
}

export interface SchemaSummary {
  type?: string | string[] | undefined;
  format?: string | undefined;
  enum?: unknown[] | undefined;
  default?: unknown;
  nullable?: boolean | undefined;
  ref?: string | undefined;
  items?: SchemaSummary | undefined;
  oneOf?: SchemaSummary[] | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
}

/** A comparable summary of a schema (resolves refs one level; keeps names for recursion). */
export function summarizeSchema(doc: unknown, schema: unknown, depth = 0): SchemaSummary | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const raw = schema as JsonObject;
  if (typeof raw.$ref === "string") {
    const name = refName(raw.$ref);
    const target = depth < 1 ? deref(doc, raw) : undefined;
    return { ref: name, ...(target ? summarizeSchema(doc, target, depth + 1) : {}) };
  }
  const variants = (raw.oneOf ?? raw.anyOf) as unknown[] | undefined;
  return {
    type: raw.type as string | string[] | undefined,
    format: raw.format as string | undefined,
    enum: raw.enum as unknown[] | undefined,
    default: raw.default,
    nullable: raw.nullable as boolean | undefined,
    items: raw.items ? summarizeSchema(doc, raw.items, depth + 1) : undefined,
    oneOf: variants ? variants.map((v) => summarizeSchema(doc, v, depth + 1) ?? {}) : undefined,
    minimum: raw.minimum as number | undefined,
    maximum: raw.maximum as number | undefined,
  };
}

/** Merge `allOf` members into one object schema (properties + required). */
export function flattenObjectSchema(doc: unknown, schema: unknown, seen = new Set<string>()): { properties: Record<string, JsonObject>; required: string[]; raw: JsonObject } {
  const resolved = deref<JsonObject>(doc, schema, seen) ?? {};
  const properties: Record<string, JsonObject> = {};
  const required: string[] = [];
  for (const member of (resolved.allOf as unknown[] | undefined) ?? []) {
    const flat = flattenObjectSchema(doc, member, new Set(seen));
    Object.assign(properties, flat.properties);
    required.push(...flat.required);
  }
  Object.assign(properties, (resolved.properties as Record<string, JsonObject> | undefined) ?? {});
  required.push(...((resolved.required as string[] | undefined) ?? []));
  return { properties, required: [...new Set(required)], raw: resolved };
}

function clean<T extends JsonObject>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function visibilityOf(node: JsonObject, fallback: Visibility): Visibility {
  if (node["x-internal"] === true) return "internal";
  if (node.deprecated === true) return "deprecated";
  return fallback;
}

export interface ExtractInput {
  sourceKey: string;
  /** Repository-relative path, used in entity locations. */
  path: string;
  content: string;
  visibility?: Visibility | undefined;
}

/** Extract API entities (operations, parameters, schemas, properties, webhooks) from OpenAPI 3.x. */
export function extractOpenApi(input: ExtractInput): EntityDefinition[] {
  const { document: doc, yaml, lineCounter } = loadOpenApi(input.content);
  const src = input.sourceKey;
  const fallback = input.visibility ?? "public";
  const entities: EntityDefinition[] = [];

  const lineAt = (segments: Array<string | number>): number | undefined => {
    const node = yaml.getIn(segments, true) as { range?: [number, number, number] } | undefined;
    return node?.range ? lineCounter.linePos(node.range[0]).line : undefined;
  };
  const push = (entity: Omit<EntityDefinition, "fingerprint">, at: Array<string | number>) => {
    entities.push({ ...entity, fingerprint: fingerprint(entity.attributes), location: { file: input.path, line: lineAt(at) } });
  };

  const pushProperties = (
    parentKey: string,
    keyPrefix: string,
    surfaceContext: string,
    schema: unknown,
    parentVisibility: Visibility,
    at: Array<string | number>,
  ) => {
    const flat = flattenObjectSchema(doc, schema);
    for (const [prop, propSchema] of Object.entries(flat.properties)) {
      const resolved = deref<JsonObject>(doc, propSchema) ?? {};
      const attributes = clean({
        name: prop,
        required: flat.required.includes(prop),
        schema: summarizeSchema(doc, propSchema),
        readOnly: resolved.readOnly as boolean | undefined,
        writeOnly: resolved.writeOnly as boolean | undefined,
        deprecated: resolved.deprecated as boolean | undefined,
        description: (resolved.description as string | undefined)?.trim(),
      });
      push(
        {
          key: `${keyPrefix}.${prop}`,
          kind: "api.property",
          name: prop,
          sourceKey: src,
          parentKey,
          visibility: visibilityOf(resolved, parentVisibility),
          attributes,
          surfaceForms: [prop, `${surfaceContext}.${prop}`],
        },
        [...at, "properties", prop],
      );
    }
  };

  // Schemas and their top-level properties.
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    const flat = flattenObjectSchema(doc, schema);
    const key = `api.schema:${src}:${name}`;
    const visibility = visibilityOf(schema, fallback);
    push(
      {
        key,
        kind: "api.schema",
        name,
        sourceKey: src,
        visibility,
        attributes: clean({
          type: (flat.raw.type as string | undefined) ?? (Object.keys(flat.properties).length > 0 ? "object" : undefined),
          required: [...flat.required].sort(),
          properties: Object.keys(flat.properties).sort(),
          enum: flat.raw.enum as unknown[] | undefined,
          description: (flat.raw.description as string | undefined)?.trim(),
        }),
        surfaceForms: [name],
      },
      ["components", "schemas", name],
    );
    pushProperties(key, `api.property:${src}:${name}`, name, schema, visibility, ["components", "schemas", name]);
  }

  // Operations and parameters.
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const pathParams = (item.parameters as unknown[] | undefined) ?? [];
    for (const method of HTTP_METHODS) {
      const op = item[method] as JsonObject | undefined;
      if (!op) continue;
      const METHOD = method.toUpperCase();
      const opKey = `api.operation:${src}:${METHOD} ${path}`;
      const visibility = visibilityOf(op, fallback);
      const params = new Map<string, JsonObject>();
      for (const p of [...pathParams, ...((op.parameters as unknown[] | undefined) ?? [])]) {
        const resolved = deref<JsonObject>(doc, p);
        if (resolved?.name && resolved.in) params.set(`${String(resolved.in)}.${String(resolved.name)}`, resolved);
      }
      const body = deref<JsonObject>(doc, op.requestBody);
      const bodyContent = (body?.content as Record<string, JsonObject> | undefined) ?? {};
      const bodySchema = Object.values(bodyContent)[0]?.schema;
      const operationId = op.operationId as string | undefined;
      const related = new Set<string>();
      const collectRefs = (schema: unknown) => {
        if (schema && typeof schema === "object") {
          const raw = schema as JsonObject;
          if (typeof raw.$ref === "string" && raw.$ref.startsWith("#/components/schemas/")) related.add(`api.schema:${src}:${refName(raw.$ref)}`);
          if (raw.items) collectRefs(raw.items);
          for (const v of [...((raw.allOf as unknown[]) ?? []), ...((raw.oneOf as unknown[]) ?? []), ...((raw.anyOf as unknown[]) ?? [])]) collectRefs(v);
        }
      };
      collectRefs(bodySchema);
      for (const [code, response] of Object.entries((op.responses as JsonObject | undefined) ?? {})) {
        if (!code.startsWith("2")) continue;
        const resolved = deref<JsonObject>(doc, response);
        for (const media of Object.values((resolved?.content as Record<string, JsonObject> | undefined) ?? {})) collectRefs(media.schema);
      }
      push(
        {
          key: opKey,
          kind: "api.operation",
          name: operationId ?? `${METHOD} ${path}`,
          sourceKey: src,
          visibility,
          attributes: clean({
            method: METHOD,
            path,
            operationId,
            summary: (op.summary as string | undefined)?.trim(),
            description: (op.description as string | undefined)?.trim(),
            deprecated: op.deprecated === true ? true : undefined,
            tags: op.tags as string[] | undefined,
            parameters: [...params.values()]
              .map((p) => ({ in: p.in, name: p.name, required: p.required === true }))
              .sort((a, b) => `${a.in}.${a.name}`.localeCompare(`${b.in}.${b.name}`)),
            requestBody: body
              ? { required: body.required === true, contentTypes: Object.keys(bodyContent).sort(), schema: summarizeSchema(doc, bodySchema) }
              : undefined,
            responses: Object.keys((op.responses as JsonObject | undefined) ?? {}).sort(),
            security: op.security as unknown,
          }),
          surfaceForms: [`${METHOD} ${path}`, path, ...(operationId ? [operationId] : [])],
          related: [...related].sort(),
        },
        ["paths", path, method],
      );
      for (const [id, p] of params) {
        const schema = p.schema;
        push(
          {
            key: `api.parameter:${src}:${METHOD} ${path}:${id}`,
            kind: "api.parameter",
            name: String(p.name),
            sourceKey: src,
            parentKey: opKey,
            visibility: visibilityOf(p, visibility),
            attributes: clean({
              in: p.in,
              name: p.name,
              required: p.required === true,
              schema: summarizeSchema(doc, schema),
              deprecated: p.deprecated as boolean | undefined,
              description: (p.description as string | undefined)?.trim(),
            }),
            surfaceForms: [String(p.name)],
          },
          ["paths", path, method, "parameters"],
        );
      }
      // Inline request bodies get operation-scoped property entities.
      if (bodySchema && typeof (bodySchema as JsonObject).$ref !== "string") {
        pushProperties(opKey, `api.property:${src}:${METHOD} ${path}#body`, operationId ?? path, bodySchema, visibility, [
          "paths",
          path,
          method,
          "requestBody",
        ]);
      }
    }
  }

  // OpenAPI 3.1 webhooks (outbound events).
  for (const [name, item] of Object.entries(doc.webhooks ?? {})) {
    const methods = HTTP_METHODS.filter((m) => item[m]);
    const first = item[methods[0] ?? "post"] as JsonObject | undefined;
    push(
      {
        key: `api.webhook:${src}:${name}`,
        kind: "api.webhook",
        name,
        sourceKey: src,
        visibility: visibilityOf(first ?? {}, fallback),
        attributes: clean({
          name,
          methods: methods.map((m) => m.toUpperCase()),
          summary: (first?.summary as string | undefined)?.trim(),
          operationId: first?.operationId as string | undefined,
        }),
        surfaceForms: [name],
      },
      ["webhooks", name],
    );
  }

  return entities;
}
