import { LineCounter, parseDocument } from "yaml";
import { fingerprint, type EntityDefinition, type Visibility } from "@docops/core";
import { deref, type ExtractInput, type JsonObject } from "./openapi.ts";

/**
 * Extract configuration keys from a JSON Schema (`config.key` entities).
 * Nested object properties become dotted keys (`database.pool.max`).
 */
export function extractJsonSchemaConfig(input: ExtractInput): EntityDefinition[] {
  const lineCounter = new LineCounter();
  const yaml = parseDocument(input.content, { lineCounter });
  if (yaml.errors.length > 0) throw new Error(`invalid JSON Schema: ${yaml.errors[0]?.message.split("\n")[0]}`);
  const root = yaml.toJS() as JsonObject;
  const fallback: Visibility = input.visibility ?? "public";
  const entities: EntityDefinition[] = [];

  const walk = (schema: unknown, prefix: string[], parentKey: string | undefined, required: string[], at: Array<string | number>) => {
    const resolved = deref<JsonObject>(root, schema) ?? {};
    const properties = (resolved.properties as Record<string, JsonObject> | undefined) ?? {};
    const requiredHere = (resolved.required as string[] | undefined) ?? [];
    for (const [name, child] of Object.entries(properties)) {
      const node = deref<JsonObject>(root, child) ?? {};
      const path = [...prefix, name];
      const dotted = path.join(".");
      const key = `config.key:${input.sourceKey}:${dotted}`;
      const visibility: Visibility = node["x-internal"] === true ? "internal" : node.deprecated === true ? "deprecated" : fallback;
      const attributes = Object.fromEntries(
        Object.entries({
          type: node.type,
          default: node.default,
          enum: node.enum,
          const: node.const,
          format: node.format,
          minimum: node.minimum,
          maximum: node.maximum,
          required: requiredHere.includes(name) || undefined,
          deprecated: node.deprecated,
          description: typeof node.description === "string" ? node.description.trim() : undefined,
        }).filter(([, v]) => v !== undefined),
      );
      const location = yaml.getIn([...at, "properties", name], true) as { range?: [number, number, number] } | undefined;
      entities.push({
        key,
        kind: "config.key",
        name: dotted,
        sourceKey: input.sourceKey,
        parentKey,
        visibility,
        attributes,
        surfaceForms: [...new Set([dotted, name])],
        fingerprint: fingerprint(attributes),
        location: { file: input.path, line: location?.range ? lineCounter.linePos(location.range[0]).line : undefined },
      });
      if (node.type === "object" || node.properties) walk(node, path, key, requiredHere, [...at, "properties", name]);
    }
  };
  walk(root, [], undefined, [], []);
  return entities;
}
