import type { EntityDefinition } from "@docops/core";
import { extractJsonSchemaConfig } from "./jsonschema.ts";
import { extractOpenApi, type ExtractInput } from "./openapi.ts";

export * from "./openapi.ts";
export { extractJsonSchemaConfig } from "./jsonschema.ts";

/** Plugin contract (see docs/02-system-architecture.md §10). */
export interface Extractor {
  id: string;
  version: string;
  supports(type: string): boolean;
  extract(input: ExtractInput): EntityDefinition[];
}

export const builtinExtractors: Extractor[] = [
  { id: "openapi", version: "1.0.0", supports: (t) => t === "openapi", extract: extractOpenApi },
  { id: "jsonschema", version: "1.0.0", supports: (t) => t === "jsonschema", extract: extractJsonSchemaConfig },
];

export interface ExtractResult {
  entities: EntityDefinition[];
  extractor?: { id: string; version: string } | undefined;
  warning?: string | undefined;
}

/** Run the extractor registered for a source type. Unsupported types yield a warning, not a failure. */
export function extractSource(type: string, input: ExtractInput, extractors: Extractor[] = builtinExtractors): ExtractResult {
  const extractor = extractors.find((e) => e.supports(type));
  if (!extractor) return { entities: [], warning: `no extractor for source type "${type}" (available in V1/V2 or via plugins)` };
  return { entities: extractor.extract(input), extractor: { id: extractor.id, version: extractor.version } };
}
