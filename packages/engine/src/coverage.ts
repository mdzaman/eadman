import type { CoverageCounts, CoverageReport, EntityDefinition } from "@docops/core";
import type { ReferenceIndex } from "./references.ts";

export interface CoverageOptions {
  kinds: readonly string[];
  includeDeprecated: boolean;
  /** Sources that generate reference pages (L1 requires a generated page with a description). */
  referenceSources: ReadonlySet<string>;
  minConfidence?: number | undefined;
}

function percent(n: number, d: number): number {
  return d === 0 ? 100 : Math.round((n / d) * 1000) / 10;
}

function counts(entities: readonly EntityDefinition[], l1: (e: EntityDefinition) => boolean, l2: (e: EntityDefinition) => boolean): CoverageCounts {
  const documentedL1 = entities.filter(l1).length;
  const documentedL2 = entities.filter(l2).length;
  return {
    publicEntities: entities.length,
    documentedL1,
    documentedL2,
    percentL1: percent(documentedL1, entities.length),
    percentL2: percent(documentedL2, entities.length),
  };
}

/**
 * Coverage (docs/01-product-requirements.md §10):
 * L1 = generated reference with a human-written description; L2 = referenced by a guide/how-to/concept page.
 */
export function computeCoverage(entities: readonly EntityDefinition[], refs: ReferenceIndex, options: CoverageOptions): CoverageReport {
  const minConfidence = options.minConfidence ?? 0.6;
  const inScope = entities.filter(
    (e) =>
      options.kinds.includes(e.kind) &&
      (e.visibility === "public" || (e.visibility === "deprecated" && options.includeDeprecated)),
  );
  const l1 = (e: EntityDefinition) =>
    options.referenceSources.has(e.sourceKey) &&
    [e.attributes.description, e.attributes.summary].some((v) => typeof v === "string" && v.trim().length > 0);
  const l2 = (e: EntityDefinition) =>
    (refs.byEntity.get(e.key) ?? []).some((r) => r.kind !== "generated" && r.confidence >= minConfidence);

  const kinds = [...new Set(inScope.map((e) => e.kind))].sort();
  return {
    totals: counts(inScope, l1, l2),
    byKind: kinds.map((kind) => ({ kind, ...counts(inScope.filter((e) => e.kind === kind), l1, l2) })),
    undocumented: inScope.filter((e) => !l2(e)).map((e) => ({ key: e.key, kind: e.kind })),
  };
}
