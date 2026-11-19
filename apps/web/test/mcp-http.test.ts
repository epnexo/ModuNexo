import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpRun } from "@modunexo/core/mcp-server";
import { createLogger } from "@modunexo/core/log";
import { createMcpHttpHandler, scrubCliText } from "../src/server/mcp-http.ts";

const KEY = `mdnx_${"0123abcd"}_${"A".repeat(43)}`;

function harness(options: { write?: boolean | Error; maxBytes?: number; maxQueue?: number; run?: (argv: string[]) => Promise<number> } = {}) {
  const ran: string[][] = [];
  const checked: string[] = [];
  const audited: unknown[] = [];
  const handler = createMcpHttpHandler({
    run: (async (argv, io) => {
      ran.push(argv);
      io.out("[]");
      return options.run ? options.run(argv) : 0;
    }) as McpRun,
    version: "9.9.9",
    identify: async (token) => {
      checked.push(token);
      if (options.write instanceof Error) throw options.write;
      return { keyId: 42, write: options.write === true };
    },
    audit: (event) => audited.push(event),
    ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const post = (body: string | object, headers: Record<string, string> = {}) =>
    handler(new Request("http://localhost/svc/core/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { post, ran, checked, audited };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const toolNames = async (response: Response) => ((await response.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);

describe("MCP over HTTP: one JSON-RPC message in, one JSON reply out", () => {
  it("answers initialize and never lets the reply be cached", async () => {
    const h = harness();
    const response = await h.post(rpc("initialize", { protocolVersion: "2025-06-18" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await response.json()) as { id: number; result: { serverInfo: { version: string } } };
    assert.equal(body.id, 1);
    assert.equal(body.result.serverInfo.version, "9.9.9");
  });

  it("answers a notification with 202 and an empty body", async () => {
    const h = harness();
    const response = await h.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  });

  it("answers a body that is not JSON with a parse error and 400", async () => {
    const response = await harness().post("{nope");
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: number } }).error.code, -32700);
  });

  it("answers a batch with an invalid request, like stdio does", async () => {
    const body = (await (await harness().post([rpc("ping")])).json()) as { error: { code: number } };
    assert.equal(body.error.code, -32600);
  });
});

describe("MCP over HTTP: the key's scope decides the tools", () => {
  it("offers a read key only the read tools, and a write key the write tools too", async () => {
    const read = await toolNames(await harness({ write: false }).post(rpc("tools/list")));
    const write = await toolNames(await harness({ write: true }).post(rpc("tools/list")));
    assert.ok(read.includes("modules_list") || read.length > 0);
    assert.ok(!read.includes("modules_disable"));
    assert.ok(write.includes("modules_disable"));
    assert.ok(write.length > read.length);
  });

  it("refuses a write tool for a read key and never runs the command", async () => {
    const h = harness({ write: false });
    const body = (await (await h.post(rpc("tools/call", { name: "modules_disable", arguments: { id: "inbox" } }))).json()) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(body.result.isError, true);
    assert.deepEqual(h.ran, []);
  });

  it("runs a write tool for a write key", async () => {
    const h = harness({ write: true });
    const body = (await (await h.post(rpc("tools/call", { name: "modules_disable", arguments: { id: "inbox" } }))).json()) as { result: { isError: boolean } };
    assert.equal(body.result.isError, false);
    assert.deepEqual(h.ran, [["modules", "disable", "inbox"]]);
  });

  it("asks about the key's write scope with the bearer token of this request", async () => {
    const h = harness({ write: true });
    await h.post(rpc("ping"));
    assert.deepEqual(h.checked, [KEY]);
  });

  it("is not affected by MODUNEXO_MCP_WRITE", async () => {
    const before = process.env.MODUNEXO_MCP_WRITE;
    process.env.MODUNEXO_MCP_WRITE = "1";
    try {
      const names = await toolNames(await harness({ write: false }).post(rpc("tools/list")));
      assert.ok(!names.includes("modules_disable"));
    } finally {
      if (before === undefined) delete process.env.MODUNEXO_MCP_WRITE;
      else process.env.MODUNEXO_MCP_WRITE = before;
    }
  });

  it("answers 503 and runs nothing when the scope cannot be checked", async () => {
    const h = harness({ write: new Error("db down") });
    const response = await h.post(rpc("tools/call", { name: "modules_disable", arguments: { id: "inbox" } }));
    assert.equal(response.status, 503);
    assert.deepEqual(h.ran, []);
  });
});

describe("MCP over HTTP: limits", () => {
  it("refuses a body over the cap with 413 before running anything", async () => {
    const h = harness({ maxBytes: 64 });
    const big = JSON.stringify(rpc("tools/call", { name: "modules_list", arguments: { pad: "x".repeat(200) } }));
    assert.equal((await h.post(big)).status, 413);
    assert.deepEqual(h.ran, []);
  });

  it("refuses an oversized body even when content-length lies or is missing", async () => {
    const h = harness({ maxBytes: 64 });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(200)));
        controller.close();
      },
    });
    const request = new Request("http://localhost/svc/core/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: stream, duplex: "half" } as RequestInit);
    const response = await createMcpHttpHandler({ run: async () => 0, version: "1", identify: async () => ({ keyId: 1, write: false }), maxBytes: 64 })(request);
    assert.equal(response.status, 413);
    assert.deepEqual(h.ran, []);
  });

  it("runs one command at a time even when calls overlap", async () => {
    let active = 0;
    let peak = 0;
    const h = harness({
      write: false,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return 0;
      },
    });
    const call = () => h.post(rpc("tools/call", { name: "modules_list", arguments: {} }));
    await Promise.all([call(), call(), call()]);
    assert.equal(h.ran.length, 3);
    assert.equal(peak, 1);
  });
});

describe("MCP over HTTP: audit, scrubbing and a bounded queue", () => {
  const callTool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });

  it("writes one audit event per tool call: key id, tool and exit code, never the key or an argument value", async () => {
    const h = harness({ write: true, run: async () => 3 });
    await h.post(callTool("modules_list"));
    await h.post(callTool("jobs_cancel", { id: "job-secret-777" }));
    assert.deepEqual(h.audited, [
      { caller: 42, tool: "modules_list", exit: 3 },
      { caller: 42, tool: "jobs_cancel", exit: 3 },
    ]);
    assert.ok(!JSON.stringify(h.audited).includes(KEY));
    assert.ok(!JSON.stringify(h.audited).includes("job-secret-777"));
  });

  it("keeps the caller id readable once the real logger has formatted the event", async () => {
    const lines: string[] = [];
    const logger = createLogger({ format: "json", sink: (line) => lines.push(line) });
    const h = harness();
    await h.post(callTool("modules_list"));
    logger.info("mcp.call", { ...(h.audited[0] as object) });
    const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(logged.caller, 42);
    assert.equal(logged.tool, "modules_list");
    assert.equal(logged.exit, 0);
  });

  it("audits a write attempt by a read key as refused (null exit)", async () => {
    const h = harness({ write: false });
    await h.post(callTool("modules_disable", { id: "crm" }));
    assert.deepEqual(h.audited, [{ caller: 42, tool: "modules_disable", exit: null }]);
  });

  it("does not audit initialize, ping or tools/list", async () => {
    const h = harness();
    await h.post(rpc("initialize", { protocolVersion: "2025-06-18" }));
    await h.post(rpc("ping"));
    await h.post(rpc("tools/list"));
    assert.deepEqual(h.audited, []);
  });

  it("shows the remote caller a scrubbed first line of a CLI failure, not paths, stack frames or credentials", async () => {
    const h = harness({ run: async () => 1 });
    const failing = createMcpHttpHandler({
      run: (async (_argv, io) => {
        io.err("Error: connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432/modunexo");
        io.err("    at Pool.connect (/home/owner/app/node_modules/pg/lib/pool.js:10:5)");
        return 1;
      }) as McpRun,
      version: "1",
      identify: async () => ({ keyId: 1, write: false }),
    });
    const response = await failing(new Request("http://localhost/svc/core/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify(callTool("modules_list")) }));
    const text = ((await response.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    assert.ok(h);
    for (const leak of ["hunter2", "10.0.0.5", "/home/owner", "pool.js", "at Pool"]) assert.ok(!text.includes(leak), `leaked ${leak}: ${text}`);
    assert.match(text, /^exit 1: /);
  });

  it("scrubCliText keeps up to three short lines and removes secrets, addresses and paths", () => {
    assert.equal(scrubCliText("first\nsecond"), "first\nsecond");
    assert.equal(scrubCliText(""), "");
    assert.ok(scrubCliText("x".repeat(1000)).length <= 201);
    assert.ok(!scrubCliText(`token ${KEY} rejected`).includes(KEY));
    assert.ok(!scrubCliText("cannot read /var/lib/modunexo/.env").includes("/var/lib"));
    assert.ok(!scrubCliText("MODUNEXO_MASTER_KEY=abc123def is bad").includes("abc123def"));
    assert.ok(!scrubCliText("host 192.168.1.20 refused").includes("192.168"));
    assert.ok(!scrubCliText("Authorization: Bearer abc.def-123 rejected").includes("abc.def"));
    assert.ok(!scrubCliText("FATAL password=hunter2 host=x").includes("hunter2"));
    assert.ok(!scrubCliText('bad {"token": "abcdef0123"}').includes("abcdef0123"));
    assert.match(scrubCliText("module crm is not enabled"), /module crm is not enabled/);
  });

  it("scrubCliText removes IPv6 addresses, relative and Windows paths and the names Postgres quotes, and keeps timestamps and ids", () => {
    const gone = (text: string, secret: string) => assert.ok(!scrubCliText(text).includes(secret), `${secret} survived: ${scrubCliText(text)}`);
    gone("connect ECONNREFUSED ::1:5432", "::1");
    gone("connect ECONNREFUSED [::1]:5432", "::1");
    gone("host fe80::1ff:fe23:4567:890a refused", "fe80");
    gone("host 2001:db8:85a3:0:0:8a2e:370:7334 refused", "2001:db8");
    gone("host 2001:db8::8a2e:370:7334 refused", "8a2e");
    gone("cannot read ../../.env", ".env");
    gone("cannot read ./src/secret.ts", "secret.ts");
    gone("cannot read C:\\Users\\owner\\.env", "owner");
    gone('password authentication failed for user "modunexo_admin"', "modunexo_admin");
    gone('database "modunexo_prod" does not exist', "modunexo_prod");
    gone('role "mnx_m_crm" does not exist', "mnx_m_crm");
    assert.match(scrubCliText("failed at 10:20:30 on job job-42"), /10:20:30 on job job-42/);
    assert.match(scrubCliText("module crm 1.2.3 is not enabled"), /module crm 1\.2\.3 is not enabled/);
  });

  it("scrubCliText stays fast on a megabyte of hostile text", () => {
    for (const unit of ["a:", "1:", "::", "[:", "../", "user ", "\\"]) {
      const started = performance.now();
      scrubCliText(unit.repeat(Math.ceil(1_048_576 / unit.length)));
      assert.ok(performance.now() - started < 500, `${JSON.stringify(unit)} took ${Math.round(performance.now() - started)} ms`);
    }
  });

  it("scrubCliText keeps at most three non-empty lines and drops stack frames", () => {
    assert.equal(scrubCliText("one\n\ntwo\n   at Pool.connect (/app/pool.js:1:1)\nthree\nfour"), "one\ntwo\nthree");
    assert.equal(scrubCliText("   at only.frames (x.js:1:1)\n   at more (y.js:2:2)"), "");
    assert.ok(scrubCliText(`${"a".repeat(500)}\nsecond`).split("\n").every((line) => line.length <= 201));
  });

  it("answers busy once four commands are running or waiting by default", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ run: async () => { await gate; return 0; } });
    const held = [1, 2, 3, 4].map(() => h.post(callTool("modules_list")));
    await new Promise((r) => setTimeout(r, 20));
    const fifth = (await (await h.post(callTool("modules_list"))).json()) as { result: { content: { text: string }[] } };
    assert.match(fifth.result.content[0]!.text, /^exit 75: .*busy/);
    release();
    await Promise.all(held);
  });

  it("answers busy (exit 75) instead of queueing without limit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ maxQueue: 2, run: async () => { await gate; return 0; } });
    const first = h.post(callTool("modules_list"));
    const second = h.post(callTool("modules_list"));
    await new Promise((r) => setTimeout(r, 20));
    const third = (await (await h.post(callTool("modules_list"))).json()) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(third.result.isError, true);
    assert.match(third.result.content[0]!.text, /^exit 75: .*busy/);
    release();
    await Promise.all([first, second]);
    const after = (await (await h.post(callTool("modules_list"))).json()) as { result: { isError: boolean } };
    assert.equal(after.result.isError, false);
  });
});
