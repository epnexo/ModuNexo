import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LogLevel, createLogger, resolveLogFormat } from "../src/log.ts";

const capture = (format: "json" | "text") => {
  const lines: { level: LogLevel; line: string }[] = [];
  const log = createLogger({ format, now: () => new Date("2026-10-18T12:00:00.000Z"), sink: (line, level) => lines.push({ level, line }) });
  return { log, lines };
};

describe("createLogger: json", () => {
  it("writes one parseable line per event with the time, the level, the event and its fields", () => {
    const { log, lines } = capture("json");
    log.warn("access.refused", { path: "/apps", status: 403 });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, "warn");
    assert.deepEqual(JSON.parse(lines[0]!.line), { ts: "2026-10-18T12:00:00.000Z", level: "warn", event: "access.refused", path: "/apps", status: 403 });
    assert.ok(!lines[0]!.line.includes("\n"), "one line");
  });

  it("never lets a secret reach the output, whatever the field is called", () => {
    const { log, lines } = capture("json");
    log.info("sign-in", { password: "hunter2", Cookie: "session=abc", authorization: "Bearer x", api_token: "t", masterKey: "k", clientSecret: "s", accessKey: "a", key: "b", pwd: "c", user: "ana" });
    const parsed = JSON.parse(lines[0]!.line);
    for (const key of ["password", "Cookie", "authorization", "api_token", "masterKey", "clientSecret", "accessKey", "key", "pwd"]) assert.equal(parsed[key], "[redacted]", key);
    assert.equal(parsed.user, "ana");
    assert.ok(!/hunter2|session=abc|Bearer x/.test(lines[0]!.line));
  });

  it("reduces an Error to its name and message, never its stack, and cuts a very long value", () => {
    const { log, lines } = capture("json");
    log.error("db.failed", { error: new TypeError("connection refused"), detail: "x".repeat(2_000) });
    const parsed = JSON.parse(lines[0]!.line);
    assert.deepEqual(parsed.error, { name: "TypeError", message: "connection refused" });
    assert.ok(parsed.detail.length <= 520, "truncated");
    assert.ok(!lines[0]!.line.includes("at "), "no stack");
  });

  it("cannot be broken by a field it cannot serialise", () => {
    const { log, lines } = capture("json");
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    log.info("odd", { loop, big: 10n, undef: undefined });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!.line).event, "odd");
  });

  it("does not let a field overwrite the time, the level or the event", () => {
    const { log, lines } = capture("json");
    log.info("real", { ts: "fake", level: "debug", event: "fake" });
    const parsed = JSON.parse(lines[0]!.line);
    assert.deepEqual([parsed.ts, parsed.level, parsed.event], ["2026-10-18T12:00:00.000Z", "info", "real"]);
  });
});

describe("createLogger: text", () => {
  it("writes a readable line", () => {
    const { log, lines } = capture("text");
    log.error("db.failed", { reason: "down", code: 7 });
    assert.equal(lines[0]!.line, "2026-10-18T12:00:00.000Z error db.failed reason=down code=7");
  });
});

describe("resolveLogFormat", () => {
  it("is json in production or when asked, text otherwise, and an explicit choice wins", () => {
    assert.equal(resolveLogFormat({ NODE_ENV: "production" }), "json");
    assert.equal(resolveLogFormat({ NODE_ENV: "development" }), "text");
    assert.equal(resolveLogFormat({}), "text");
    assert.equal(resolveLogFormat({ LOG_FORMAT: "json" }), "json");
    assert.equal(resolveLogFormat({ NODE_ENV: "production", LOG_FORMAT: "text" }), "text");
    assert.equal(resolveLogFormat({ LOG_FORMAT: "yaml" }), "text", "an unknown value falls back to the default");
  });
});
