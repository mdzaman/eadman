---
title: "ADR-0001: TypeScript across services, CLI, actions and UI"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0001: TypeScript across services, CLI, actions and UI

## Context

DocOps has many surfaces that have to agree on the same schemas: the CLI, the GitHub Action, the API and workers, the Forge app, the Astro portal, the TipTap editor and the IDE extensions. The schemas include the `docops.yaml` config, the entity model, finding and rule contracts, the event payloads and the plugin SDK. Several of those surfaces only accept JavaScript or TypeScript: Forge functions, JavaScript GitHub Actions, VS Code extensions, Astro, TipTap and remark/rehype plugins.

## Decision

Use **TypeScript on Node.js LTS (22 minimum, 24 in production images)** for every first-party component. Shared contracts live in `@docops/core` and `@docops/config`. Source runs directly with Node's type stripping (erasable syntax only); `tsc` type-checks; `esbuild` bundles the CLI and Action. Go is held in reserve for a hot path only if profiling shows Node can't meet an SLO, for example a link crawler.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **TypeScript everywhere** | One type system end to end; native to Forge, Actions, Astro and TipTap; one hiring profile; shared rule SDK between CLI and server | Single-thread CPU limits (mitigated with worker threads); no static single-file binary by default (Node SEA or Bun compile when needed) |
| Go services + TS front ends | Fast static binaries; simple concurrency | Schemas duplicated across two languages; the plugin SDK would need two implementations; Forge, Actions and the editor stay TS anyway |
| Rust core + TS shell | Best performance | Slowest iteration; small hiring pool for the domain |

## Consequences

- Contracts are written once. The JSON Schema for `docops.yaml` is the canonical artifact, and TS types follow it.
- CPU-heavy steps (render, extract) run in a `worker_threads` pool, with content-addressed caching keeping the work incremental.
- The CLI ships as an npm package and as Node single-executable binaries for air-gapped runners.
