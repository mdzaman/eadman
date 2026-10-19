import { deref, flattenObjectSchema, refName, type JsonObject } from "@docops/extractors";

export type { JsonObject };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `deref` that never throws (remote `$ref`s resolve to undefined instead of failing the build). */
export function resolve(doc: unknown, value: unknown): JsonObject | undefined {
  try {
    const target = deref<unknown>(doc, value);
    return isObject(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** Merged `allOf` properties of an object schema (never throws). */
export function flatten(doc: unknown, schema: unknown): { properties: Record<string, JsonObject>; required: string[]; raw: JsonObject } {
  try {
    const flat = flattenObjectSchema(doc, schema);
    return { properties: flat.properties, required: flat.required, raw: flat.raw };
  } catch {
    return { properties: {}, required: [], raw: {} };
  }
}

export function refOf(schema: unknown): string | undefined {
  return isObject(schema) && typeof schema.$ref === "string" ? schema.$ref : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Declared or implied JSON types of a (resolved) schema. */
export function schemaTypes(schema: JsonObject): string[] {
  if (Array.isArray(schema.type)) return schema.type.filter((t): t is string => typeof t === "string");
  if (typeof schema.type === "string") return [schema.type];
  if (isObject(schema.properties) || Array.isArray(schema.allOf)) return ["object"];
  if (schema.items !== undefined) return ["array"];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const first = schema.enum[0];
    return [first === null ? "null" : typeof first === "number" ? (Number.isInteger(first) ? "integer" : "number") : typeof first];
  }
  return [];
}

export function variants(schema: JsonObject | undefined): { kind: "oneOf" | "anyOf"; list: unknown[] } | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return { kind: "oneOf", list: schema.oneOf };
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return { kind: "anyOf", list: schema.anyOf };
  return undefined;
}

export function variantName(doc: unknown, schema: unknown, index: number): string {
  const ref = refOf(schema);
  if (ref) return refName(ref);
  const resolved = resolve(doc, schema);
  if (resolved && typeof resolved.title === "string" && resolved.title.trim()) return resolved.title.trim();
  return resolved ? schemaTypeLabel(doc, resolved) : `option ${index + 1}`;
}

/** Human-readable type: "string", "array of Payment", "string (PaymentStatus)", "one of: Card | Bank", "integer | null". */
export function schemaTypeLabel(doc: unknown, schema: unknown, depth = 0): string {
  if (!isObject(schema)) return "any";
  const ref = refOf(schema);
  if (ref) {
    const name = refName(ref);
    const target = resolve(doc, schema);
    if (!target || depth > 2) return name;
    const base = schemaTypeLabel(doc, target, depth + 1);
    return base === "object" || base === "any" ? name : `${base} (${name})`;
  }
  const alternatives = variants(schema);
  if (alternatives) {
    const names = alternatives.list.map((v, i) => variantName(doc, v, i));
    return `${alternatives.kind === "oneOf" ? "one of" : "any of"}: ${names.join(" | ")}`;
  }
  const types = schemaTypes(schema);
  if (types.length === 0) return schema.const !== undefined ? typeof schema.const : "any";
  const label = types
    .map((t) => (t === "array" ? `array of ${schemaTypeLabel(doc, schema.items, depth + 1)}` : t))
    .join(" | ");
  return schema.nullable === true && !types.includes("null") ? `${label} | null` : label;
}

/** The object schema to expand for nested properties (`a.b`) or array items (`a[].b`). */
export function nestedObject(doc: unknown, schema: unknown): { schema: unknown; suffix: string } | undefined {
  const resolved = resolve(doc, schema);
  if (!resolved || variants(resolved)) return undefined;
  const types = schemaTypes(resolved);
  if (types.includes("array")) {
    const items = resolve(doc, resolved.items);
    if (items && !variants(items) && Object.keys(flatten(doc, resolved.items).properties).length > 0) {
      return { schema: resolved.items, suffix: "[]" };
    }
    return undefined;
  }
  if (Object.keys(flatten(doc, schema).properties).length > 0) return { schema, suffix: "" };
  return undefined;
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
