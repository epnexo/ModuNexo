import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEnvironment, buildRunEnvironment } from "../src/install/build.ts";

describe("buildEnvironment", () => {
  it("keeps what a build needs and drops the secrets", () => {
    const env = buildEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/x",
      NODE_OPTIONS: "--max-old-space-size=1024",
      NEXT_TELEMETRY_DISABLED: "1",
      WEB_PUBLIC_URL: "https://modunexo.example.com",
      LANG: "en_US.UTF-8",
      MODUNEXO_MASTER_KEY: "secret",
      DATABASE_URL: "postgres://u:p@h/db",
      TEST_DATABASE_URL: "postgres://u:p@h/test",
      AWS_SECRET_ACCESS_KEY: "x",
    });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "NEXT_TELEMETRY_DISABLED", "NODE_OPTIONS", "PATH", "WEB_PUBLIC_URL"]);
  });

  it("skips variables that are not set", () => {
    assert.deepEqual(buildEnvironment({ PATH: undefined, HOME: "/h" }), { HOME: "/h" });
  });
});

describe("buildRunEnvironment", () => {
  const env = { PATH: "/usr/bin", MODUNEXO_MASTER_KEY: "secret", DATABASE_URL: "postgres://u:p@h/db", MODUNEXO_DIST_DIR: ".next-inherited" };

  it("adds the directory to build into, which next.config reads, to the same minimal environment", () => {
    const run = buildRunEnvironment(env, ".next-abc");
    assert.deepEqual(run, { PATH: "/usr/bin", MODUNEXO_DIST_DIR: ".next-abc" });
  });

  it("never inherits a directory from the process that launched the build", () => {
    assert.deepEqual(buildRunEnvironment(env, undefined), { PATH: "/usr/bin" });
  });
});
