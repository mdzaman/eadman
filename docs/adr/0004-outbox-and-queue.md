---
title: "ADR-0004: Transactional outbox; Postgres queue by default, Kafka in scale mode"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0004: Transactional outbox; Postgres queue by default, Kafka in scale mode

## Context

Webhooks, CLI uploads and schedules trigger asynchronous work: extract, check, build, publish, index and tracker sync. We need at-least-once delivery, per-key ordering, retries, a dead-letter queue, coalescing and replay. Writing state and publishing an event must not be a dual write. Air-gapped installs want as few components as possible.

## Decision

1. Every state change that emits events writes an **outbox row in the same transaction**.
2. **Embedded mode** (default): a relay moves outbox rows into the Postgres `jobs` table, and workers dequeue with `FOR UPDATE SKIP LOCKED`, ordered by priority, honoring `run_after` and the coalesce key.
3. **Scale mode** (SaaS cells): the relay publishes to Kafka topics partitioned by `(tenant, repository, ref)` or `(tenant, issue)`. Consumers use the same handler interface.
4. Consumers are idempotent through the `processed_events` ledger and natural keys for external side effects.

## Options considered

| Option | Throughput | Ops weight | Replay | Portability |
|---|---|---|---|---|
| **Postgres queue + outbox** | 1–5k jobs/s | None extra | From the outbox | Everywhere |
| **Kafka** | Very high | High | Native | K8s (Strimzi) or managed |
| SQS/SNS | High | Low | No | AWS only |
| NATS JetStream | High | Low | Native | Good; smaller enterprise mindshare |

## Consequences

- A single `EventBus` and `JobQueue` interface with two implementations, covered by contract tests for both.
- Queue payloads carry references (IDs, SHAs), never document content, which keeps messages small and avoids copying sensitive data into the broker.
