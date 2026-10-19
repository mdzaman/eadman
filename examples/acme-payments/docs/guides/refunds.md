---
title: Refund a payment
type: how_to
owners: ["@acme/payments-docs"]
tickets: [PAY-123]
reviewed: 2026-09-20
---

# Refund a payment

Refunds return captured money to the customer. Create one with `POST /v1/refunds`.

## Full refunds

Send only the `payment_id`. The full captured amount is refunded.

## Partial refunds

Set `amount` (in minor units) to refund part of a payment. You can issue several partial
refunds until the captured amount is used up.

| Field | Required | Notes |
|---|---|---|
| `payment_id` | yes | The payment to refund |
| `amount` | no | Defaults to the full captured amount |
| `reason` | no | `duplicate`, `fraudulent` or `requested_by_customer` |

<!-- docops:snippet name="support" -->
