import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPgliteClient, migrate } from "../src/index.ts";

test("concurrent starts apply each migration exactly once", async () => {
  const db = await createPgliteClient();
  const runs = await Promise.all([migrate(db), migrate(db), migrate(db)]);
  const files = (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(runs.flat().sort(), files, "every file ran once, in exactly one of the callers");
  const recorded = (await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
  assert.deepEqual(recorded, files);
  assert.deepEqual(await migrate(db), [], "a later start finds nothing to do");
  await db.close();
});

test("a failing migration rolls back the whole run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docops-migrations-"));
  try {
    await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE widgets (id int PRIMARY KEY);\nINSERT INTO widgets VALUES (1);");
    await writeFile(join(dir, "0002_bad.sql"), "CREATE TABLE gadgets (id int);\nSELECT 1 / 0;");
    const url = pathToFileURL(`${dir}/`);
    const db = await createPgliteClient();
    await assert.rejects(migrate(db, url), /division by zero/);
    const tables = (await db.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE tablename IN ('widgets', 'gadgets', 'schema_migrations')")).rows;
    assert.deepEqual(tables, [], "no table and no bookkeeping row survives the failed run");

    await writeFile(join(dir, "0002_bad.sql"), "CREATE TABLE gadgets (id int);");
    assert.deepEqual(await migrate(db, url), ["0001_ok.sql", "0002_bad.sql"], "the fixed run applies both files");
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
