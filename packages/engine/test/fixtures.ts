import { readFileSync } from "node:fs";

const acmeRoot = new URL("../../../examples/acme-payments/", import.meta.url);

export function acmeFile(path: string): string {
  return readFileSync(new URL(path, acmeRoot), "utf8");
}

export const ACME_ROOT = acmeRoot.pathname;

function replaceOnce(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture drifted: ${JSON.stringify(from)} not found`);
  return text.replace(from, to);
}

/**
 * The "head" side of the canonical scenario used across the test suite (and shown in
 * docs/05-cli-and-ci.md): a PR that renames PaymentCreate.amount to amount_cents, adds
 * GET /v1/refunds/{refund_id}, and doubles the default processor timeout, without touching docs.
 */
export function acmeHeadOpenApi(): string {
  let text = acmeFile("api/openapi.yaml");
  text = replaceOnce(text, "required: [amount, currency, customer_id]", "required: [amount_cents, currency, customer_id]");
  text = replaceOnce(
    text,
    "        amount:\n          type: integer\n          minimum: 50",
    "        amount_cents:\n          type: integer\n          minimum: 50",
  );
  text = replaceOnce(
    text,
    "components:\n",
    [
      "  /v1/refunds/{refund_id}:",
      "    get:",
      "      tags: [Refunds]",
      "      operationId: getRefund",
      "      summary: Retrieve a refund",
      "      parameters:",
      "        - name: refund_id",
      "          in: path",
      "          required: true",
      "          schema:",
      "            type: string",
      "      responses:",
      '        "200":',
      "          description: The refund.",
      "          content:",
      "            application/json:",
      "              schema:",
      '                $ref: "#/components/schemas/Refund"',
      "components:",
      "",
    ].join("\n"),
  );
  return text;
}

export function acmeHeadConfigSchema(): string {
  return replaceOnce(acmeFile("config/schema.json"), '"default": 30000', '"default": 60000');
}
