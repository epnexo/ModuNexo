import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { type McpRun, createMcpServer } from "../src/mcp/server.ts";
import { serveStdio } from "../src/mcp/stdio.ts";

interface Call {
  argv: string[];
}

/** A runner that records what it was asked and answers from a table keyed by the joined argv. */
function fakeRun(answers: Record<string, { code?: number; out?: string; err?: string }> = {}) {
  const calls: Call[] = [];
  const run: McpRun = async (argv, io) => {
    calls.push({ argv });
    const answer = answers[argv.join(" ")] ?? { out: "ok" };
    if (answer.out !== undefined) io.out(answer.out);
    if (answer.err !== undefined) io.err(answer.err);
    return answer.code ?? 0;
  };
  return { run, calls };
}

const request = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });
const call = (name: string, args: Record<string, unknown> = {}) => request("tools/call", { name, arguments: args });
type Reply = { result?: any; error?: { code: number; message: string } };
const ask = async (server: ReturnType<typeof createMcpServer>, message: unknown) => (await server.handle(message)) as Reply;

describe("mcp protocol", () => {
  it("answers initialize with the tools capability and the server name", async () => {
    const server = createMcpServer({ run: fakeRun().run, allowWrite: false, version: "9.9.9" });
    const reply = await ask(server, request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    assert.equal(reply.result.protocolVersion, "2025-06-18");
    assert.deepEqual(reply.result.capabilities, { tools: {} });
    assert.equal(reply.result.serverInfo.name, "modunexo");
    assert.equal(reply.result.serverInfo.version, "9.9.9");
  });

  it("falls back to its own protocol version when the client asks for one it does not know", async () => {
    const server = createMcpServer({ run: fakeRun().run, allowWrite: false, version: "1" });
    const reply = await ask(server, request("initialize", { protocolVersion: "1999-01-01" }));
    assert.match(reply.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(reply.result.protocolVersion, "1999-01-01");
  });

  it("answers ping, ignores notifications, and refuses unknown methods", async () => {
    const server = createMcpServer({ run: fakeRun().run, allowWrite: false, version: "1" });
    assert.deepEqual((await ask(server, request("ping"))).result, {});
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    assert.equal((await ask(server, request("resources/list"))).error?.code, -32601);
    assert.equal((await ask(server, { nope: true })).error?.code, -32600);
  });
});

describe("mcp tools list", () => {
  const names = async (allowWrite: boolean) => {
    const server = createMcpServer({ run: fakeRun().run, allowWrite, version: "1" });
    return ((await ask(server, request("tools/list"))).result.tools as { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { type: string } }[]).map((t) => t.name);
  };

  it("offers only the read tools while writes are off", async () => {
    const read = await names(false);
    for (const name of ["modules_list", "users_list", "settings_list", "tokens_list", "jobs_list", "events_list", "files_list", "auth_status", "llm_probe", "validate"]) {
      assert.ok(read.includes(name), `${name} is offered`);
    }
    for (const name of ["modules_enable", "modules_disable", "jobs_enqueue", "jobs_retry", "jobs_cancel", "events_publish"]) {
      assert.ok(!read.includes(name), `${name} is hidden`);
    }
  });

  it("adds the bounded write tools when writes are on, and never the dangerous ones", async () => {
    const all = await names(true);
    for (const name of ["modules_enable", "modules_disable", "jobs_enqueue", "jobs_retry", "jobs_cancel", "events_publish"]) {
      assert.ok(all.includes(name), `${name} is offered`);
    }
    for (const name of all) assert.doesNotMatch(name, /admin|user_create|password|token_create|tokens_create|purge|uninstall|auth_disable|files_delete|install|apply|settings_set/);
  });

  it("describes each tool with an object schema and a read-only hint that matches its kind", async () => {
    const server = createMcpServer({ run: fakeRun().run, allowWrite: true, version: "1" });
    const tools = (await ask(server, request("tools/list"))).result.tools as { name: string; description: string; annotations: { readOnlyHint: boolean }; inputSchema: { type: string } }[];
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.description.length > 10);
    }
    const hint = (name: string) => tools.find((t) => t.name === name)!.annotations.readOnlyHint;
    assert.equal(hint("modules_list"), true);
    assert.equal(hint("modules_disable"), false);
  });
});

describe("mcp tool calls", () => {
  it("runs the CLI with the exact argv of a read tool and returns its output", async () => {
    const { run, calls } = fakeRun({ "modules list --json": { out: '[{"id":"core"}]' } });
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const reply = await ask(server, call("modules_list"));
    assert.deepEqual(calls, [{ argv: ["modules", "list", "--json"] }]);
    assert.equal(reply.result.isError, false);
    assert.equal(reply.result.content[0].text, '[{"id":"core"}]');
  });

  it("never asks for payloads: job, event and file lists run without --json", async () => {
    const { run, calls } = fakeRun();
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    await ask(server, call("jobs_list", { module: "inbox", status: "dead" }));
    await ask(server, call("events_list", { module: "inbox", type: "inbox.message", limit: 5 }));
    await ask(server, call("files_list", { module: "inbox", limit: 3 }));
    assert.deepEqual(
      calls.map((c) => c.argv),
      [
        ["jobs", "list", "inbox", "--status", "dead"],
        ["events", "list", "inbox", "--type", "inbox.message", "--limit", "5"],
        ["files", "list", "inbox", "--limit", "3"],
      ],
    );
  });

  it("refuses a write tool while writes are off, without touching the CLI", async () => {
    const { run, calls } = fakeRun();
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const reply = await ask(server, call("modules_disable", { id: "inbox" }));
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /MODUNEXO_MCP_WRITE/);
    assert.equal(calls.length, 0);
  });

  it("builds the argv of the write tools when writes are on", async () => {
    const { run, calls } = fakeRun();
    const server = createMcpServer({ run, allowWrite: true, version: "1" });
    await ask(server, call("modules_enable", { id: "inbox" }));
    await ask(server, call("modules_disable", { id: "inbox" }));
    await ask(server, call("jobs_enqueue", { module: "inbox", job: "sync", payload: { a: 1 }, delaySeconds: 30, dedupeKey: "k1" }));
    await ask(server, call("jobs_retry", { id: "12" }));
    await ask(server, call("jobs_cancel", { id: "13" }));
    await ask(server, call("events_publish", { module: "inbox", event: "inbox.message", payload: { b: 2 } }));
    assert.deepEqual(
      calls.map((c) => c.argv),
      [
        ["modules", "enable", "inbox"],
        ["modules", "disable", "inbox"],
        ["jobs", "enqueue", "inbox", "sync", "--payload", '{"a":1}', "--delay-seconds", "30", "--dedupe-key", "k1"],
        ["jobs", "retry", "12"],
        ["jobs", "cancel", "13"],
        ["events", "publish", "inbox", "inbox.message", "--payload", '{"b":2}'],
      ],
    );
  });

  it("rejects values that could turn into CLI options or are the wrong shape, before running anything", async () => {
    const { run, calls } = fakeRun();
    const server = createMcpServer({ run, allowWrite: true, version: "1" });
    const bad: [string, Record<string, unknown>][] = [
      ["modules_disable", { id: "--rebuild" }],
      ["modules_disable", { id: "inbox --purge" }],
      ["modules_disable", { id: "" }],
      ["modules_disable", {}],
      ["jobs_retry", { id: "1; rm -rf" }],
      ["jobs_enqueue", { module: "inbox", job: "sync", payload: "not an object" }],
      ["jobs_enqueue", { module: "inbox", job: "sync", delaySeconds: -1 }],
      ["jobs_enqueue", { module: "inbox", job: "sync", extra: true }],
      ["jobs_list", { status: "everything" }],
      ["events_list", { limit: 100000 }],
      ["modules_list", { json: false }],
    ];
    for (const [name, args] of bad) {
      const reply = await ask(server, call(name, args));
      assert.equal(reply.result.isError, true, `${name} ${JSON.stringify(args)} is refused`);
    }
    assert.equal(calls.length, 0);
  });

  it("answers an unknown tool with an invalid-params error", async () => {
    const server = createMcpServer({ run: fakeRun().run, allowWrite: true, version: "1" });
    assert.equal((await ask(server, call("auth_disable"))).error?.code, -32602);
    assert.equal((await ask(server, request("tools/call", {}))).error?.code, -32602);
  });

  it("reports a failing command as a tool error carrying its message", async () => {
    const { run } = fakeRun({ "modules list --json": { code: 3, err: "refused: nope" } });
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const reply = await ask(server, call("modules_list"));
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /exit 3/);
    assert.match(reply.result.content[0].text, /refused: nope/);
  });

  it("turns a crashing runner into a tool error instead of dying", async () => {
    const run: McpRun = async () => {
      throw new Error("boom");
    };
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const reply = await ask(server, call("modules_list"));
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /boom/);
  });

  it("cuts a huge output and says so", async () => {
    const { run } = fakeRun({ "modules list --json": { out: "x".repeat(300_000) } });
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const text = (await ask(server, call("modules_list"))).result.content[0].text as string;
    assert.ok(text.length < 120_000);
    assert.match(text, /truncated/);
  });

  it("runs one tool call at a time", async () => {
    let running = 0;
    let peak = 0;
    const run: McpRun = async (_argv, io) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      io.out("ok");
      return 0;
    };
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    await Promise.all([ask(server, call("modules_list")), ask(server, call("users_list")), ask(server, call("auth_status"))]);
    assert.equal(peak, 1);
  });
});

describe("mcp validate", () => {
  const modules = (extra: object = {}) => JSON.stringify([{ id: "inbox", status: "enabled", upgradePending: false, orphaned: false, dataRetained: false, invalidInstalledVersion: false, ...extra }]);
  const users = (role: string) => JSON.stringify([{ email: "a@b.c", role, banned: false }]);

  it("reports a healthy platform with no findings", async () => {
    const { run } = fakeRun({ "modules list --json": { out: modules() }, "auth status": { out: "sign-in: required" }, "user list --json": { out: users("admin") } });
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const report = JSON.parse((await ask(server, call("validate"))).result.content[0].text);
    assert.equal(report.ok, true);
    assert.deepEqual(report.findings, []);
    assert.equal(report.signIn, "required");
  });

  it("flags pending upgrades, orphans, invalid versions, a disabled sign-in and a missing administrator", async () => {
    const { run } = fakeRun({
      "modules list --json": { out: modules({ upgradePending: true, orphaned: true, invalidInstalledVersion: true }) },
      "auth status": { out: "sign-in: disabled" },
      "user list --json": { out: users("operator") },
    });
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const report = JSON.parse((await ask(server, call("validate"))).result.content[0].text);
    assert.equal(report.ok, false);
    const text = report.findings.join("\n");
    for (const word of ["upgrade", "orphan", "invalid", "sign-in", "administrator"]) assert.match(text, new RegExp(word, "i"));
  });

  it("reports a check that could not run instead of passing silently", async () => {
    const { run } = fakeRun({ "modules list --json": { code: 1, err: "no database" }, "auth status": { out: "sign-in: required" }, "user list --json": { out: users("admin") } });
    const server = createMcpServer({ run, allowWrite: false, version: "1" });
    const report = JSON.parse((await ask(server, call("validate"))).result.content[0].text);
    assert.equal(report.ok, false);
    assert.match(report.findings.join("\n"), /modules list.*no database/i);
  });
});

describe("mcp stdio", () => {
  it("answers one JSON line per request and writes nothing else to the output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = createMcpServer({ run: fakeRun({ "auth status": { out: "sign-in: required" } }).run, allowWrite: false, version: "1" });
    const done = serveStdio(input, output, server);
    input.write(`${JSON.stringify(request("ping", undefined, 1))}\n`);
    input.write("this is not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify(call("auth_status"))}\n`.replace('"id":1', '"id":2'));
    input.end();
    await done;
    const lines = output.read()?.toString().trim().split("\n") ?? [];
    const replies = lines.map((line: string) => JSON.parse(line));
    assert.equal(replies.length, 3);
    assert.deepEqual(replies[0].result, {});
    assert.equal(replies[1].error.code, -32700);
    assert.equal(replies[1].id, null);
    assert.equal(replies[2].result.content[0].text, "sign-in: required");
  });
});
