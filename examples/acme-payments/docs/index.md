---
title: Acme Payments
type: concept
owners: ["@acme/payments-docs"]
reviewed: 2026-09-15
---

# Acme Payments

{{ productName }} lets you accept card and bank payments and refund them.

| Task | Guide |
|---|---|
| Take a payment | [Accept a payment](guides/payments.md) |
| Give money back | [Refund a payment](guides/refunds.md) |
| Retry safely | [Idempotent requests](concepts/idempotency.md) |
| Find past payments | `GET /v1/payments` returns payments, newest first |

All requests go to `{{ apiBaseUrl }}` and authenticate with a secret API key sent as a bearer token.

<!-- docops:snippet name="support" -->
