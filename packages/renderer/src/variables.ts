import type { VariableValue } from "./types.ts";

export type Variables = Record<string, VariableValue>;

const VARIABLE_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
/** In MDX, `{{ name }}` parses as an expression whose value is `{ name }`. */
const EXPRESSION_VARIABLE_RE = /^\s*\{\s*([A-Za-z_][\w.-]*)\s*\}\s*$/;

/** Replace `{{ name }}` / `{{name}}` with configured values; unknown names are left untouched. */
export function substituteVariables(value: string, variables: Variables): string {
  if (!value.includes("{{")) return value;
  return value.replace(VARIABLE_RE, (whole, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : whole,
  );
}

/**
 * Text for an MDX expression that is really a `{{ name }}` variable reference.
 * Returns undefined for any other expression (expressions are never evaluated).
 */
export function variableExpressionText(expression: string, variables: Variables): string | undefined {
  const match = EXPRESSION_VARIABLE_RE.exec(expression);
  if (!match?.[1]) return undefined;
  const name = match[1];
  return Object.hasOwn(variables, name) ? String(variables[name]) : `{{ ${name} }}`;
}
