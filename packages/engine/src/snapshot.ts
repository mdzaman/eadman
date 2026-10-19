import type { EntityDefinition, PageType } from "@docops/core";
import { frontmatterList, type ParsedPage } from "@docops/markdown";
import type { ReferenceIndex } from "./references.ts";

/** Wire format of `POST /v1/snapshots` (api/openapi.yaml#/components/schemas/Snapshot). */
export interface SnapshotPayload {
  repository: { provider: string; fullName: string };
  commitSha: string;
  ref?: string | undefined;
  committedAt?: string | undefined;
  spaceKey: string;
  spaceName?: string | undefined;
  docsRoot?: string | undefined;
  configDigest?: string | undefined;
  sources: Array<{ key: string; format: string; path: string; extractor?: string | undefined; extractorVersion?: string | undefined }>;
  pages: Array<{
    path: string;
    title: string;
    pageType: PageType;
    contentHash: string;
    frontmatter: Record<string, unknown>;
    headings: Array<{ depth: number; text: string; anchor: string }>;
    wordCount: number;
    tickets: string[];
    owners: string[];
    reviewedOn?: string | undefined;
    references: Array<{ entityKey: string; kind: string; line: number | null; confidence: number; entityFingerprint: string }>;
  }>;
  entities: Array<{
    key: string;
    kind: string;
    name: string;
    sourceKey: string;
    parentKey: string | null;
    visibility: string;
    fingerprint: string;
    attributes: Record<string, unknown>;
    surfaceForms: string[];
  }>;
}

export interface BuildSnapshotInput {
  repository: { provider: string; fullName: string };
  commitSha: string;
  ref?: string | undefined;
  committedAt?: string | undefined;
  spaceKey: string;
  spaceName?: string | undefined;
  docsRoot?: string | undefined;
  configDigest?: string | undefined;
  sources: SnapshotPayload["sources"];
  pages: readonly ParsedPage[];
  entities: readonly EntityDefinition[];
  references: ReferenceIndex;
}

function reviewedOn(page: ParsedPage): string | undefined {
  const value = page.frontmatter.reviewed;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return undefined;
}

export function buildSnapshot(input: BuildSnapshotInput): SnapshotPayload {
  return {
    repository: input.repository,
    commitSha: input.commitSha,
    ref: input.ref,
    committedAt: input.committedAt,
    spaceKey: input.spaceKey,
    spaceName: input.spaceName,
    docsRoot: input.docsRoot,
    configDigest: input.configDigest,
    sources: input.sources,
    pages: input.pages.map((page) => ({
      path: page.path,
      title: page.title,
      pageType: page.pageType,
      contentHash: page.contentHash,
      frontmatter: page.frontmatter,
      headings: page.headings.map(({ depth, text, anchor }) => ({ depth, text, anchor })),
      wordCount: page.wordCount,
      tickets: frontmatterList(page, "tickets"),
      owners: frontmatterList(page, "owners"),
      reviewedOn: reviewedOn(page),
      references: (input.references.byPage.get(page.path) ?? []).map((r) => ({
        entityKey: r.entityKey,
        kind: r.kind,
        line: r.line ?? null,
        confidence: r.confidence,
        entityFingerprint: r.entityFingerprint,
      })),
    })),
    entities: input.entities.map((e) => ({
      key: e.key,
      kind: e.kind,
      name: e.name,
      sourceKey: e.sourceKey,
      parentKey: e.parentKey ?? null,
      visibility: e.visibility,
      fingerprint: e.fingerprint,
      attributes: e.attributes,
      surfaceForms: e.surfaceForms,
    })),
  };
}
