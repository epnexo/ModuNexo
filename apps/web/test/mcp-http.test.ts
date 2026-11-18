import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpRun } from "@modunexo/core/mcp-server";
import { createMcpHttpHandler } from "../src/server/mcp-http.ts";

const KEY = `mdnx_${"0123abcd"}_${"A".repeat(43)}`;

function harness(options: { write?: boolean | Error; maxBytes?: number; run?: (argv: string[]) => Promise<number> } = {}) {
  const ran: string[][] = [];
  const checked: string[] = [];
  const handler = createMcpHttpHandler({
    run: (async (argv, io) => {
      ran.push(argv);
      io.out("[]");
      return options.run ? options.run(argv) : 0;
    }) as McpRun,
    version: "9.9.9",
    canWrite: async (token) => {
      checked.push(token);
      if (options.write instanceof Error) throw options.write;
      return options.write === true;
    },
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const post = (body: string | object, headers: Record<string, string> = {}) =>
    handler(new Request("http://localhost/svc/core/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { post, ran, checked };
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
    const response = await createMcpHttpHandler({ run: async () => 0, version: "1", canWrite: async () => false, maxBytes: 64 })(request);
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
