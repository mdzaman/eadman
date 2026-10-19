---
title: "Runbook: payment processor timeouts"
type: runbook
owners: ["@acme/payments-sre"]
reviewed: 2026-07-10
---

# Runbook: payment processor timeouts

Use this runbook when the `PaymentsProcessorTimeouts` alert fires.

## Check the configuration

| Setting | Default | What it controls |
|---|---|---|
| `PAYMENTS_TIMEOUT_MS` | 30000 | How long to wait for the card processor |
| `PAYMENTS_RETRY_LIMIT` | 3 | Retries for idempotent processor calls |

## Mitigate

1. Check the processor status page.
2. If p99 latency is above the timeout, raise `PAYMENTS_TIMEOUT_MS` temporarily and redeploy.
3. If errors continue for more than 15 minutes, page the payments on-call engineer.
