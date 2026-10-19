---
title: "ADR-0008: Astro portal; TipTap + Yjs editor with opaque MDX nodes"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0008: Astro portal; TipTap + Yjs editor with opaque MDX nodes

## Context

The portal must be static (for availability), fast (Lighthouse ≥ 95), accessible (WCAG 2.2 AA), support MDX components and islands (try-it, Ask, Jira status), and build 5k pages in under 60 s. The editor must round-trip Markdown/MDX to Git with no loss and support real-time collaboration.

## Decision

- **Portal:** Astro static output with islands. Content passes through our unified (remark/rehype) pipeline with a content-addressed per-page cache. Pagefind provides static search. Next.js was considered but rejected.
- **Editor:** TipTap (ProseMirror) with Yjs, synced through Hocuspocus. The Markdown ↔ ProseMirror mapping is lossless for supported nodes. Anything else, including arbitrary MDX JSX and expressions, becomes an **opaque MDX node** that is edited as source and written back byte-for-byte.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Astro** | Zero JS by default; first-class MDX; islands in any framework; static output | Smaller ecosystem than Next.js |
| Next.js (static export) | Huge ecosystem | Heavier client JS; slower large static builds; ISR features assume a server |
| Docusaurus as the engine | Docs features built in | React-only; harder to own incremental builds and multi-audience filtering |
| **TipTap + Yjs** | ProseMirror maturity; MIT core; Yjs CRDT is proven | Markdown fidelity is our responsibility (hence opaque nodes) |
| Lexical / Slate | Viable | Less mature collaboration story for Markdown round trips |

## Consequences

- A fidelity suite of more than 500 real documents asserts `parse → edit(no-op) → serialize` is byte-identical. It runs in CI.
- The MVP scaffold's renderer implements the same unified pipeline that the Astro integration wraps.
