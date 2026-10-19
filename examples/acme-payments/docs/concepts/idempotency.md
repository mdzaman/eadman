---
title: Idempotent requests
type: concept
owners: ["@acme/payments-docs"]
reviewed: 2026-08-01
---

# Idempotent requests

Network failures happen. Send an `Idempotency-Key` header with every `POST` so that a retried
request returns the original response instead of creating a second payment or refund.

- Use a random UUID per logical operation.
- Keys are remembered for 24 hours.
- Reusing a key with a different body returns `409 Conflict`.
