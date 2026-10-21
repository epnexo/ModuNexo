import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { satisfies } from "semver";
import { SDK_VERSION } from "@modunexo/sdk";
import { runCli } from "../src/cli/run.ts";
import { CORE_VERSION } from "../src/version.ts";

const root = (path: string) => new URL(`../../../${path}`, import.meta.url);
const versionOf = (path: string): string => (JSON.parse(readFileSync(root(path), "utf8")) as { version: string }).version;

describe("the platform version", () => {
  it("is one semver number, written in the root, the core and the web app, and in CORE_VERSION", () => {
    assert.match(CORE_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    assert.deepEqual(
      ["package.json", "packages/core/package.json", "apps/web/package.json"].map(versionOf),
      [CORE_VERSION, CORE_VERSION, CORE_VERSION],
    );
  });

  it("is accepted by the range the web app asks of the core, so the workspace still links", () => {
    const wanted = (JSON.parse(readFileSync(root("apps/web/package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@modunexo/core"];
    assert.ok(wanted !== undefined && satisfies(CORE_VERSION, wanted), `${CORE_VERSION} against "${wanted}"`);
  });

  it("keeps the SDK on its own number, the module contract, equal in its package, SDK_VERSION and the legacy alias", () => {
    assert.equal(versionOf("packages/sdk/package.json"), SDK_VERSION);
    assert.equal(versionOf("packages/sdk-legacy-alias/package.json"), SDK_VERSION);
  });

  it("has a changelog whose newest release is the current version", () => {
    const text = readFileSync(root("CHANGELOG.md"), "utf8");
    const newest = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(text);
    assert.equal(newest?.[1], CORE_VERSION);
  });
});

describe("modunexo --version", () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err };
  };

  it("prints the platform version and the SDK version, and exits 0", async () => {
    const result = await run(["--version"]);
    assert.deepEqual(result, { code: 0, out: [`modunexo ${CORE_VERSION} (sdk ${SDK_VERSION})`], err: [] });
  });

  it("is listed in the help text, and --help still works", async () => {
    const result = await run(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.out.join("\n"), /--version\s+print the version/);
  });

  it("is not mixed with a command: a command still runs as before", async () => {
    const result = await run(["modules"]);
    assert.notEqual(result.code, 0);
    assert.match(result.err.join("\n"), /no modules command given/);
  });
});
