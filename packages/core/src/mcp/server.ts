import { ArgumentError, type Args, TOOLS, type ToolDef, checkArguments, inputSchema } from "./tools.ts";

/** What the server needs from the CLI: run an argv, report lines through `io`, answer the exit code. */
export type McpRun = (argv: string[], io: { out: (line: string) => void; err: (line: string) => void }) => Promise<number>;

export interface McpServerOptions {
  run: McpRun;
  /** Offer and allow the write tools. Off unless the owner asked for it with MODUNEXO_MCP_WRITE=1. */
  allowWrite: boolean;
  version: string;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MAX_OUTPUT_CHARS = 100_000;

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;
interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

const result = (id: Id, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolText = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], isError });

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: ${text.length - MAX_OUTPUT_CHARS} more characters]`;
}

export function createMcpServer(options: McpServerOptions) {
  const tools = TOOLS.filter((tool) => options.allowWrite || !tool.write);
  // The CLI keeps a database pool and some process-wide state per run: one call at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function runCommand(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    try {
      const code = await options.run(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
      return { code, out: out.join("\n"), err: err.join("\n") };
    } catch (error) {
      return { code: 1, out: out.join("\n"), err: [...err, error instanceof Error ? error.message : String(error)].join("\n") };
    }
  }

  async function runTool(tool: ToolDef, args: Args): Promise<ToolResult> {
    if (tool.name === "validate") return validate();
    const done = await runCommand(tool.argv!(args));
    if (done.code !== 0) return toolText(clip(`exit ${done.code}: ${done.err || done.out || "the command failed"}`), true);
    return toolText(clip(done.out || done.err || "done"));
  }

  async function validate(): Promise<ToolResult> {
    const findings: string[] = [];
    const [modules, auth, users] = [await runCommand(["modules", "list", "--json"]), await runCommand(["auth", "status"]), await runCommand(["user", "list", "--json"])];
    const unavailable = (name: string, done: { code: number; err: string; out: string }) => findings.push(`${name} could not run (exit ${done.code}): ${done.err || done.out || "no message"}`);

    let moduleCount: number | null = null;
    if (modules.code !== 0) unavailable("modules list", modules);
    else {
      try {
        const list = JSON.parse(modules.out) as { id: string; upgradePending?: boolean; orphaned?: boolean; invalidInstalledVersion?: boolean }[];
        moduleCount = list.length;
        for (const m of list) {
          if (m.upgradePending) findings.push(`module "${m.id}" has an upgrade pending: run modules upgrade`);
          if (m.orphaned) findings.push(`module "${m.id}" is orphaned: it is installed but its package is not on disk`);
          if (m.invalidInstalledVersion) findings.push(`module "${m.id}" has an invalid installed version`);
        }
      } catch {
        findings.push("modules list answered something that is not JSON");
      }
    }

    let signIn: string | null = null;
    if (auth.code !== 0) unavailable("auth status", auth);
    else {
      signIn = /sign-in:\s*(\w+)/.exec(auth.out)?.[1] ?? null;
      if (signIn === null) findings.push("auth status answered something unexpected");
      else if (signIn !== "required") findings.push("sign-in is disabled: anyone on the local network can use the platform");
    }

    let userCount: number | null = null;
    if (users.code !== 0) unavailable("user list", users);
    else {
      try {
        const list = JSON.parse(users.out) as { role?: string; banned?: boolean }[];
        userCount = list.length;
        if (!list.some((u) => u.role === "admin" && u.banned !== true)) findings.push("there is no active administrator");
      } catch {
        findings.push("user list answered something that is not JSON");
      }
    }

    const report = { ok: findings.length === 0, signIn, modules: moduleCount, users: userCount, findings };
    return toolText(JSON.stringify(report, null, 2));
  }

  async function callTool(id: Id, params: unknown) {
    const named = typeof params === "object" && params !== null ? (params as { name?: unknown; arguments?: unknown }) : {};
    const known = typeof named.name === "string" ? TOOLS.find((tool) => tool.name === named.name) : undefined;
    if (known === undefined) return failure(id, INVALID_PARAMS, `unknown tool "${String(named.name)}"`);
    if (known.write && !options.allowWrite) return result(id, toolText(`"${known.name}" changes the platform and writes are off: start the server with MODUNEXO_MCP_WRITE=1 to allow it.`, true));
    let args: Args;
    try {
      args = checkArguments(known, named.arguments);
    } catch (error) {
      if (error instanceof ArgumentError) return result(id, toolText(`${known.name}: ${error.message}`, true));
      throw error;
    }
    return result(id, await exclusive(() => runTool(known, args)));
  }

  /** One JSON-RPC message in, its reply out; a notification has no reply. */
  async function handle(message: unknown): Promise<object | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return failure(null, INVALID_REQUEST, "a request must be a JSON object");
    const { method, id: rawId, params } = message as { method?: unknown; id?: unknown; params?: unknown };
    const isNotification = rawId === undefined;
    const id: Id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    if (typeof method !== "string") return failure(id, INVALID_REQUEST, "a request needs a method");
    if (isNotification) return undefined;
    try {
      switch (method) {
        case "initialize": {
          const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
          const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
          return result(id, {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: "modunexo", version: options.version },
            instructions: options.allowWrite
              ? "Operates a modunexo CRM through its CLI: read tools and a bounded set of write tools (enable or disable modules, queue or cancel jobs, publish events)."
              : "Operates a modunexo CRM through its CLI in read-only mode.",
          });
        }
        case "ping":
          return result(id, {});
        case "tools/list":
          return result(id, {
            tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool), annotations: { readOnlyHint: !tool.write, destructiveHint: false, openWorldHint: false } })),
          });
        case "tools/call":
          return await callTool(id, params);
        default:
          return failure(id, METHOD_NOT_FOUND, `method "${method}" is not supported`);
      }
    } catch (error) {
      return failure(id, INTERNAL_ERROR, error instanceof Error ? error.message : "internal error");
    }
  }

  return { handle };
}
