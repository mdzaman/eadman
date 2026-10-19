import { fileURLToPath } from "node:url";
import { matchesAny } from "@docops/core";
import { loadPages } from "@docops/markdown";
import type { EmbeddingProvider } from "../gateway/types.ts";
import { chunkPage, type Chunk } from "../rag/chunk.ts";
import type { SearchBackend } from "../rag/search.ts";

/** packages/ai/eval: datasets and test-only fixture pages. */
export const EVAL_DIR = fileURLToPath(new URL("../../eval/", import.meta.url));

export interface AclRule {
  /** Glob over the page path, e.g. "runbooks/**". */
  pattern: string;
  principals: string[];
}

export interface CorpusRoot {
  root: string;
  /** Prepended to page paths from this root, e.g. "eval-fixtures/". */
  prefix?: string;
}

export interface BuildCorpusOptions {
  roots: CorpusRoot[];
  version?: string;
  /** First matching rule wins; pages matching none get `defaultPrincipals`. */
  aclRules?: AclRule[];
  defaultPrincipals?: string[];
  defaultAudience?: string;
  include?: string[];
  exclude?: string[];
  snippetsDir?: string;
}

/**
 * Build an eval corpus the way the indexer would: load and parse pages, tag them
 * with ACL principals, and chunk them. Snippet files are not pages.
 */
export async function buildCorpus(opts: BuildCorpusOptions): Promise<Chunk[]> {
  const version = opts.version ?? "latest";
  const defaultPrincipals = opts.defaultPrincipals ?? ["tenant:*"];
  const chunks: Chunk[] = [];
  for (const { root, prefix = "" } of opts.roots) {
    const { pages } = await loadPages(root, {
      include: opts.include ?? ["**/*.md", "**/*.mdx"],
      exclude: opts.exclude ?? ["**/_drafts/**"],
      snippetsDir: opts.snippetsDir ?? "_snippets",
      defaultPageType: "guide",
    });
    for (const parsed of pages) {
      const path = `${prefix}${parsed.path}`;
      const page = { ...parsed, path };
      const rule = opts.aclRules?.find((r) => matchesAny(path, [r.pattern]));
      const audience = typeof parsed.frontmatter.audience === "string" ? parsed.frontmatter.audience : (opts.defaultAudience ?? "public");
      chunks.push(
        ...chunkPage(page, {
          url: `/${version}/${path.replace(/\.mdx?$/, "")}`,
          version,
          audience,
          aclPrincipals: rule ? rule.principals : defaultPrincipals,
        }),
      );
    }
  }
  return chunks;
}

/** Embed chunk texts (in batches) and index them. */
export async function indexCorpus(chunks: Chunk[], search: SearchBackend, embeddings: EmbeddingProvider, batchSize = 64): Promise<void> {
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await embeddings.embed(
      batch.map((c) => c.text),
      "document",
    );
    await search.index(batch, vectors);
  }
}
