---
title: "ADR-0010: Run extraction, checks and builds in the customer's CI"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0010: Run extraction, checks and builds in the customer's CI

## Context

Extracting entities and rendering MDX executes code from the customer's repository: MDX expressions, doc tests and plugins. Running untrusted code in multi-tenant infrastructure is the largest attack surface a docs platform has. Customers' CI already has the checkout, toolchains, caches and secrets, and it is the natural place to enforce gates.

## Decision

The **`docops` CLI is the primary execution engine**. In CI it extracts entities, diffs against the base, runs gates, renders previews and uploads *results and content-addressed artifacts*. The platform stores, indexes, publishes, runs AI and coordinates. Hosted execution is used only for edits that originate in the browser and for nightly scans, and it always runs inside Firecracker or gVisor sandboxes with no egress by default.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **CLI in customer CI (primary)** | Smallest attack surface; uses customer caches; works air-gapped; transparent | Depends on customer CI capacity; CLI version skew (mitigated by `cli >= x` checks in the API) |
| Hosted builds only (Mintlify and GitBook style) | Zero setup | We execute customer code; egress and secret issues; higher cost |
| Hybrid without a primary | Flexible | Two divergent code paths |

## Consequences

- The CLI and the hosted workers share the same packages (`@docops/engine`, `@docops/checks`, `@docops/renderer`), so results are identical wherever they run.
- `--offline` mode runs every deterministic gate with no network. Platform-dependent steps report as skipped.
