import type { TokenRecord } from "@modunexo/core/tokens";
import { buildTokenViews } from "./api-access-view.ts";
import { answer, authorize, readObject } from "./module-tokens-api.ts";
import { json } from "./settings-api.ts";

/** The module whose keys these are: the platform itself. */
const CORE = "core";
/** The only scope the screen hands out. A key that can change the platform is created from the CLI (`tokens create core`). */
const READ_SCOPE = "mcp.read";
const DAY_MS = 86_400_000;
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 365;

/** What this API needs of the platform, so a test can stand in for the database. */
export interface McpKeysDeps {
  /** Who is asking; null when nobody the shell may serve. */
  viewer: (headers: Headers) => Promise<{ actor: string; canWrite: boolean } | null>;
  now: () => Date;
  service: {
    list: () => Promise<TokenRecord[]>;
    find: (id: number) => Promise<TokenRecord | null>;
    create: (input: { moduleId: string; name: string; scopes: string[]; expiresAt: Date; actor: string }) => Promise<{ record: TokenRecord; token: string }>;
    revoke: (id: number, actor: string) => Promise<TokenRecord>;
  };
}

/** `GET /api/settings/mcp-keys`: the keys of the MCP endpoint. Never a key value, only name, prefix, scopes and dates. */
export async function handleListMcpKeys(request: Request, deps: McpKeysDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: false });
  if (viewer instanceof Response) return viewer;
  return json({ keys: buildTokenViews(await deps.service.list(), deps.now()) });
}

/**
 * `POST /api/settings/mcp-keys` `{ name, expiresInDays? }`: a new read key, whose value is in this answer only. The
 * scopes are not the caller's to choose, and a key always expires (30 days unless asked for 1 to 365).
 */
export async function handleCreateMcpKey(request: Request, deps: McpKeysDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: true });
  if (viewer instanceof Response) return viewer;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "name" && key !== "expiresInDays");
  if (unknown.length > 0) return json({ error: `unknown field "${unknown[0]}"` }, 400);
  if (typeof body.name !== "string") return json({ error: "send the key's name as { name }" }, 400);
  let days = DEFAULT_EXPIRY_DAYS;
  if (body.expiresInDays !== undefined) {
    const asked = body.expiresInDays;
    if (typeof asked !== "number" || !Number.isSafeInteger(asked) || asked < 1 || asked > MAX_EXPIRY_DAYS) {
      return json({ error: `expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}` }, 400);
    }
    days = asked;
  }
  const name = body.name;
  const expiresAt = new Date(deps.now().getTime() + days * DAY_MS);
  return answer(async () => json(await deps.service.create({ moduleId: CORE, name, scopes: [READ_SCOPE], expiresAt, actor: viewer.actor }), 201));
}

/** `DELETE /api/settings/mcp-keys/{id}`: stops the key from working at once, whatever its scopes. Only the core's keys. */
export async function handleRevokeMcpKey(request: Request, id: number, deps: McpKeysDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: true });
  if (viewer instanceof Response) return viewer;
  const found = Number.isSafeInteger(id) && id > 0 ? await deps.service.find(id) : null;
  if (found === null || found.moduleId !== CORE) return json({ error: `there is no MCP key ${id}` }, 404);
  return answer(async () => json({ record: await deps.service.revoke(id, viewer.actor) }));
}

export { mcpAddCommand } from "./mcp-add-command.ts";
