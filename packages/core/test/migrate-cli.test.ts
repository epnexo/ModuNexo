import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { openTestPool, resolveTestDatabaseUrl } from "../src/testing.ts";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../src/cli/migrate.ts", import.meta.url));

describe("db:migrate script", () => {
  it("fails with a clear message when DATABASE_URL is not set", async () => {
    await assert.rejects(
      run(process.execPath, ["--import", "tsx", script], { env: { PATH: process.env.PATH } }),
      (error: { stderr: string; code: number }) => error.code === 1 && /DATABASE_URL is not set/.test(error.stderr),
    );
  });

  it("migrates the database it is pointed at and reports what it did", async (t) => {
    const { pool, skipReason } = await openTestPool();
    if (!pool) return t.skip(skipReason);
    await pool.end();
    const { stdout } = await run(process.execPath, ["--import", "tsx", script], {
      env: { PATH: process.env.PATH, DATABASE_URL: resolveTestDatabaseUrl()! },
    });
    assert.match(stdout, /applied core\/0001_init\.sql|nothing to apply/);
  });
});
