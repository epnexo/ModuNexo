import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOLS } from "@modunexo/core/mcp-tools";
import { mcpConnection } from "../src/server/mcp-connection.ts";

describe("mcp connection screen", () => {
  const view = mcpConnection();

  it("offers a command for the container and one for the repository, each read-only and with writes", () => {
    assert.deepEqual(
      view.commands.map((c) => c.id),
      ["docker-read", "docker-write", "repo-read", "repo-write"],
    );
  });

  it("builds commands Claude Code accepts: options before the name, the server command after --", () => {
    for (const { id, command } of view.commands) {
      assert.match(command, /^(cd [^&]+ && )?claude mcp add /, `${id} starts with claude mcp add`);
      const [head, tail] = command.split(" -- ");
      assert.ok(tail !== undefined, `${id} has a -- separator`);
      assert.match(head!, / modunexo$/, `${id} ends its options with the server name`);
      assert.match(tail!, /npm run --silent mcp$/, `${id} runs the mcp script quietly`);
    }
  });

  it("never lets the server name directly follow --env, which the CLI would read as another KEY=value pair", () => {
    for (const { id, command } of view.commands) {
      const head = command.split(" -- ")[0]!;
      assert.doesNotMatch(head, /--env \S+ modunexo$/, `${id} puts an option between --env and the name`);
      if (command.includes("--env")) assert.match(head, /--env MODUNEXO_MCP_WRITE=1 --transport stdio modunexo$/, id);
    }
  });

  it("turns writes on only in the write variants", () => {
    for (const { id, command, write } of view.commands) {
      assert.equal(command.includes("MODUNEXO_MCP_WRITE=1"), write, id);
      assert.equal(write, id.endsWith("-write"));
    }
  });

  it("runs the container variants through docker exec with an open stdin and passes the write switch into the container", () => {
    const read = view.commands.find((c) => c.id === "docker-read")!.command;
    const write = view.commands.find((c) => c.id === "docker-write")!.command;
    assert.match(read, /docker exec -i modunexo-web npm run --silent mcp$/);
    assert.match(write, /docker exec -i -e MODUNEXO_MCP_WRITE=1 modunexo-web npm run --silent mcp$/);
  });

  it("lists the tools by kind, from the same source the server uses", () => {
    assert.deepEqual(
      view.read.map((t) => t.name),
      TOOLS.filter((t) => !t.write).map((t) => t.name),
    );
    assert.deepEqual(
      view.write.map((t) => t.name),
      TOOLS.filter((t) => t.write).map((t) => t.name),
    );
    for (const tool of [...view.read, ...view.write]) assert.ok(tool.description.length > 10);
  });

  it("names what is never offered, and none of it is a tool", () => {
    assert.ok(view.neverOffered.length >= 5);
    const names = new Set(TOOLS.map((t) => t.name));
    for (const item of view.neverOffered) {
      assert.ok(item.label.length > 3 && item.reason.length > 10);
      assert.ok(!names.has(item.label), `${item.label} must not be a tool`);
    }
  });
});
