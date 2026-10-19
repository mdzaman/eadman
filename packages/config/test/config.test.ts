import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfigError, parseConfig } from "../src/index.ts";

const example = new URL("../../../examples/acme-payments/docops.yaml", import.meta.url);
const repoConfig = new URL("../../../docops.yaml", import.meta.url);

test("the documented example configuration is valid", () => {
  const { config, digest } = parseConfig(readFileSync(example, "utf8"));
  assert.equal(config.project.id, "payments");
  assert.equal(config.sources.length, 2);
  assert.equal(config.checks.drift.level, "block");
  assert.equal(config.checks.links.external.enabled, false);
  assert.equal(config.integrations.jira?.projects[0], "PAY");
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test("this repository's own docops.yaml is valid (dogfooding)", () => {
  const { config } = parseConfig(readFileSync(repoConfig, "utf8"));
  assert.equal(config.project.id, "docops");
});

test("defaults are applied to a minimal configuration", () => {
  const { config } = parseConfig("version: 1\nproject: { id: demo, name: Demo }\n");
  assert.equal(config.docs.root, "docs");
  assert.equal(config.checks.failOn, "error");
  assert.equal(config.checks.links.level, "block");
  assert.equal(config.checks.coverage.measure, "l2");
  assert.equal(config.site.title, "Demo");
});

test("unknown keys and bad enums are reported with line numbers", () => {
  const text = [
    "version: 1",
    "project:",
    "  id: demo",
    "  name: Demo",
    "checks:",
    "  links:",
    "    level: blocking",
    "  drfit: { level: block }",
  ].join("\n");
  assert.throws(
    () => parseConfig(text),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      const enumIssue = error.issues.find((i) => i.pointer === "/checks/links/level");
      assert.ok(enumIssue, JSON.stringify(error.issues));
      assert.equal(enumIssue.line, 7);
      assert.ok(error.issues.some((i) => i.message.includes('unknown property "drfit"')));
      return true;
    },
  );
});

test("YAML syntax errors carry positions", () => {
  assert.throws(() => parseConfig("version: 1\nproject: [unclosed\n"), (e: unknown) => e instanceof ConfigError && e.issues[0]!.line !== undefined);
});
