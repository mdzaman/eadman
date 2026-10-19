---
title: Accept a payment
type: how_to
owners: ["@acme/payments-docs"]
tickets: [PAY-101]
entities:
  - payments-api:POST /v1/payments
reviewed: 2026-09-15
---

# Accept a payment

Create a payment with `POST /v1/payments`. Send an [idempotency key](../concepts/idempotency.md) so that
retries never charge a customer twice.

```bash
curl -X POST {{ apiBaseUrl }}/v1/payments \
  -H "Authorization: Bearer $ACME_API_KEY" \
  -H "Idempotency-Key: 8e03978e-40d5-43e8-bc93-6894a57f9324" \
  -d '{"amount": 2000, "currency": "usd", "customer_id": "cus_123"}'
```

Set `amount` in minor currency units: `2000` is $20.00. The `currency` must be `usd`, `eur` or `gbp`.

## Capture later

To authorize now and capture when you ship, set `capture` to `false`, then call
`POST /v1/payments/{payment_id}/capture`. Uncaptured payments are released after seven days.

## Check a payment

Retrieve the latest state with `GET /v1/payments/{payment_id}`. The `status` is one of
`pending`, `succeeded`, `failed` or `refunded`.

To give money back, see [partial refunds](refunds.md#partial-refunds).
