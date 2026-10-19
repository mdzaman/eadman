import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { syncIncludes } from "@docops/markdown";

// "Docs never drift from the code" applies to our own docs: the DDL in docs/03-data-model.md
// is embedded from the migration and must stay byte-identical.
test("docs/03-data-model.md embeds the current migration DDL", async () => {
  const docPath = fileURLToPath(new URL("../../../docs/03-data-model.md", import.meta.url));
  const result = await syncIncludes(docPath, readFileSync(docPath, "utf8"), async (p) => readFileSync(p, "utf8"));
  const ddl = result.includes.find((i) => i.path.endsWith("migrations/0001_init.sql"));
  assert.ok(ddl, "include directive for the migration is missing");
  assert.equal(ddl.upToDate, true, "run `npm run docops -- sync` to refresh docs/03-data-model.md");
});
