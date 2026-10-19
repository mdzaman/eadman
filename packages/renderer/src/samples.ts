import { refName } from "@docops/extractors";
import { asArray, flatten, refOf, resolve, schemaTypes, variants, type JsonObject } from "./schema.ts";

export type AuthSample =
  | { kind: "bearer" }
  | { kind: "basic" }
  | { kind: "apiKey"; in: "header" | "query" | "cookie"; name: string };

export interface SampleRequest {
  method: string;
  /** Path template; path parameters stay as `{name}` placeholders. */
  path: string;
  serverUrl: string;
  /** Required query parameters (rendered as `name={name}`). */
  query: string[];
  /** Required header parameters (rendered as `Name: {Name}`). */
  headers: string[];
  auth?: AuthSample | undefined;
  body?: { contentType: string; value: unknown } | undefined;
}

const MAX_EXAMPLE_DEPTH = 5;

function exampleString(schema: JsonObject): string {
  switch (schema.format) {
    case "date-time":
      return "2024-01-01T00:00:00Z";
    case "date":
      return "2024-01-01";
    case "time":
      return "12:00:00";
    case "email":
      return "user@example.com";
    case "uuid":
      return "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    case "uri":
    case "url":
      return "https://example.com";
    case "ipv4":
      return "192.0.2.1";
    default:
      return "string";
  }
}

/** An example value synthesized from a schema (request bodies skip read-only properties). */
export function synthesizeExample(doc: unknown, schema: unknown, depth = 0, seen: ReadonlySet<string> = new Set()): unknown {
  const ref = refOf(schema);
  if (ref && seen.has(ref)) return {};
  const nextSeen = ref ? new Set([...seen, ref]) : seen;
  const resolved = resolve(doc, schema);
  if (!resolved || depth > MAX_EXAMPLE_DEPTH) return null;
  if (resolved.example !== undefined) return resolved.example;
  if (Array.isArray(resolved.examples) && resolved.examples.length > 0) return resolved.examples[0];
  if (resolved.default !== undefined) return resolved.default;
  if (resolved.const !== undefined) return resolved.const;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];
  const alternatives = variants(resolved);
  if (alternatives) return synthesizeExample(doc, alternatives.list[0], depth + 1, nextSeen);
  const types = schemaTypes(resolved).filter((t) => t !== "null");
  const type = types[0] ?? "object";
  switch (type) {
    case "object": {
      const flat = flatten(doc, schema);
      const names = Object.keys(flat.properties).filter((name) => (resolve(doc, flat.properties[name]) ?? {}).readOnly !== true);
      const chosen = flat.required.length > 0 ? names.filter((n) => flat.required.includes(n)) : names.slice(0, 10);
      const out: Record<string, unknown> = {};
      for (const name of chosen) out[name] = synthesizeExample(doc, flat.properties[name], depth + 1, nextSeen);
      return out;
    }
    case "array":
      return [synthesizeExample(doc, resolved.items, depth + 1, nextSeen)];
    case "integer":
    case "number":
      return typeof resolved.minimum === "number" ? resolved.minimum : 0;
    case "boolean":
      return true;
    case "string":
      return exampleString(resolved);
    default:
      return null;
  }
}

/** Example for a media type object: `example`, then `examples`, then the schema's own, then synthesized. */
export function mediaExample(doc: unknown, media: JsonObject | undefined): unknown {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  if (media.examples && typeof media.examples === "object") {
    for (const value of Object.values(media.examples as Record<string, unknown>)) {
      const example = resolve(doc, value);
      if (example && example.value !== undefined) return example.value;
    }
  }
  return synthesizeExample(doc, media.schema);
}

export function schemaRefName(schema: unknown): string | undefined {
  const ref = refOf(schema);
  return ref ? refName(ref) : undefined;
}

/** Security requirement → the credential the samples should send (first supported scheme). */
export function authSample(doc: unknown, security: unknown): AuthSample | undefined {
  const schemes = (doc as { components?: { securitySchemes?: Record<string, unknown> } }).components?.securitySchemes ?? {};
  for (const requirement of asArray(security)) {
    if (!requirement || typeof requirement !== "object") continue;
    for (const name of Object.keys(requirement as Record<string, unknown>)) {
      const scheme = resolve(doc, schemes[name]);
      if (!scheme) continue;
      const type = String(scheme.type ?? "").toLowerCase();
      if (type === "http" && String(scheme.scheme ?? "").toLowerCase() === "basic") return { kind: "basic" };
      if (type === "http" || type === "oauth2" || type === "openidconnect") return { kind: "bearer" };
      if (type === "apikey" && typeof scheme.name === "string") {
        const where = scheme.in === "query" || scheme.in === "cookie" ? scheme.in : "header";
        return { kind: "apiKey", in: where, name: scheme.name };
      }
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isJson(contentType: string): boolean {
  return /[/+]json\b/i.test(contentType) || contentType === "*/*";
}

function formFields(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}

function requestUrl(request: SampleRequest, extraQuery: string[] = []): string {
  const query = [...request.query.map((name) => `${encodeURIComponent(name)}={${name}}`), ...extraQuery];
  return `${request.serverUrl.replace(/\/+$/, "")}${request.path}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}

/** A `curl` command for the request. */
export function curlSample(request: SampleRequest): string {
  const extraQuery = request.auth?.kind === "apiKey" && request.auth.in === "query" ? [`${encodeURIComponent(request.auth.name)}={API_KEY}`] : [];
  const first = `curl${request.method === "GET" ? "" : ` -X ${request.method}`} ${shellQuote(requestUrl(request, extraQuery))}`;
  const options: string[] = [];
  const auth = request.auth;
  if (auth?.kind === "bearer") options.push(`-H "Authorization: Bearer $API_TOKEN"`);
  else if (auth?.kind === "basic") options.push(`-u "$API_USERNAME:$API_PASSWORD"`);
  else if (auth?.kind === "apiKey" && auth.in === "header") options.push(`-H "${auth.name}: $API_KEY"`);
  else if (auth?.kind === "apiKey" && auth.in === "cookie") options.push(`-b "${auth.name}=$API_KEY"`);
  for (const name of request.headers) options.push(`-H ${shellQuote(`${name}: {${name}}`)}`);
  const body = request.body;
  if (body && request.method !== "GET" && request.method !== "HEAD") {
    if (/multipart\/form-data/i.test(body.contentType)) {
      for (const [k, v] of formFields(body.value)) options.push(`-F ${shellQuote(`${k}=${v}`)}`);
    } else {
      options.push(`-H ${shellQuote(`Content-Type: ${body.contentType}`)}`);
      if (/x-www-form-urlencoded/i.test(body.contentType)) {
        for (const [k, v] of formFields(body.value)) options.push(`--data-urlencode ${shellQuote(`${k}=${v}`)}`);
      } else {
        const data = isJson(body.contentType) || typeof body.value !== "string" ? JSON.stringify(body.value, null, 2) : body.value;
        options.push(`-d ${shellQuote(data)}`);
      }
    }
  }
  return [first, ...options].join(" \\\n  ");
}

/** A JavaScript `fetch` call for the request. */
export function fetchSample(request: SampleRequest): string {
  const extraQuery = request.auth?.kind === "apiKey" && request.auth.in === "query" ? [`${encodeURIComponent(request.auth.name)}=YOUR_API_KEY`] : [];
  const headers: string[] = [];
  const auth = request.auth;
  if (auth?.kind === "bearer") headers.push(`"Authorization": "Bearer YOUR_API_TOKEN"`);
  else if (auth?.kind === "basic") headers.push(`"Authorization": "Basic " + btoa("USERNAME:PASSWORD")`);
  else if (auth?.kind === "apiKey" && auth.in === "header") headers.push(`${JSON.stringify(auth.name)}: "YOUR_API_KEY"`);
  for (const name of request.headers) headers.push(`${JSON.stringify(name)}: ${JSON.stringify(`{${name}}`)}`);
  let bodyLine: string | undefined;
  const body = request.body;
  if (body && request.method !== "GET" && request.method !== "HEAD") {
    if (/multipart\/form-data/i.test(body.contentType)) {
      bodyLine = `body: (() => { const form = new FormData(); ${formFields(body.value)
        .map(([k, v]) => `form.append(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join(" ")} return form; })(),`;
    } else {
      headers.push(`"Content-Type": ${JSON.stringify(body.contentType)}`);
      if (/x-www-form-urlencoded/i.test(body.contentType)) {
        bodyLine = `body: new URLSearchParams(${JSON.stringify(Object.fromEntries(formFields(body.value)), null, 2).replace(/\n/g, "\n  ")}),`;
      } else if (isJson(body.contentType) || typeof body.value !== "string") {
        bodyLine = `body: JSON.stringify(${JSON.stringify(body.value, null, 2).replace(/\n/g, "\n  ")}),`;
      } else {
        bodyLine = `body: ${JSON.stringify(body.value)},`;
      }
    }
  }
  const lines = [`const response = await fetch(${JSON.stringify(requestUrl(request, extraQuery))}, {`];
  lines.push(`  method: ${JSON.stringify(request.method)},`);
  if (auth?.kind === "apiKey" && auth.in === "cookie") lines.push(`  credentials: "include", // sends the ${auth.name} cookie`);
  if (headers.length > 0) {
    lines.push("  headers: {");
    for (const header of headers) lines.push(`    ${header},`);
    lines.push("  },");
  }
  if (bodyLine) lines.push(`  ${bodyLine}`);
  lines.push("});");
  lines.push("const data = await response.json();");
  lines.push("console.log(response.status, data);");
  return lines.join("\n");
}
