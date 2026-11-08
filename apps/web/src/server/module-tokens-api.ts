import { TokenError, type TokenRecord } from "@modunexo/core/tokens";
import { SettingValueError } from "@modunexo/core/settings";
import { json, parseJsonBody, readBodyText, sameOriginRequest } from "./settings-api.ts";

const DAY_MS = 86_400_000;
const MAX_EXPIRY_DAYS = 3650;

/** What this API needs of the platform, so a test can stand in for the database. */
export interface ApiAccessPort {
  moduleIsEnabled: (moduleId: string) => Promise<boolean>;
  list: (moduleId: string) => Promise<TokenRecord[]>;
  find: (id: number) => Promise<TokenRecord | null>;
  create: (input: { moduleId: string; name: string; scopes: string[]; expiresAt?: Date; actor: string }) => Promise<{ record: TokenRecord; token: string }>;
  regenerate: (id: number, actor: string) => Promise<{ record: TokenRecord; token: string; revoked: TokenRecord }>;
  revoke: (id: number, actor: string) => Promise<TokenRecord>;
  setAddress: (raw: string, actor: string) => Promise<string>;
  unsetAddress: (actor: string) => Promise<void>;
}

export interface ApiAccessDeps {
  /** Who is asking; null when nobody the shell may serve. */
  viewer: (headers: Headers) => Promise<{ actor: string; canWrite: boolean } | null>;
  now: () => Date;
  service: ApiAccessPort;
}

type Viewer = { actor: string };

/** Same origin (for a write), a viewer, and the right to administer: the checks every call of this API shares. */
async function authorize(request: Request, deps: ApiAccessDeps, options: { write: boolean }): Promise<Viewer | Response> {
  if (options.write && !sameOriginRequest(request.headers)) return json({ error: "cross-origin request refused" }, 403);
  const viewer = await deps.viewer(request.headers);
  if (viewer === null) return json({ error: "sign-in required" }, 401);
  if (!viewer.canWrite) return json({ error: "only an administrator can manage API access" }, 403);
  return { actor: viewer.actor };
}

async function readObject(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await readBodyText(request);
  if (!text.ok) return json({ error: text.message }, 413);
  const parsed = parseJsonBody(text.text);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  if (typeof parsed.body !== "object" || parsed.body === null || Array.isArray(parsed.body)) return json({ error: "the request body must be an object" }, 400);
  return parsed.body as Record<string, unknown>;
}

/** A token id from an address: digits only, so `1e0` or `0x1` are not ids. NaN when it is not one. */
export function parseTokenId(raw: string): number {
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : Number.NaN;
}

const STATUS = { invalid: 400, "not-found": 404, revoked: 409 } as const;

/** A refusal of the platform becomes its status and its message; anything else is not ours to explain. */
async function answer(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TokenError) return json({ error: error.message, code: error.code }, STATUS[error.code]);
    if (error instanceof SettingValueError) return json({ error: error.message }, 400);
    throw error;
  }
}

/** The token must exist and belong to the module in the address, so one module's page can never act on another's token. */
async function ownToken(deps: ApiAccessDeps, moduleId: string, id: number): Promise<TokenRecord | Response> {
  const found = Number.isSafeInteger(id) && id > 0 ? await deps.service.find(id) : null;
  if (found === null || found.moduleId !== moduleId) return json({ error: `there is no token ${id} for module "${moduleId}"` }, 404);
  return found;
}

const notEnabled = (moduleId: string) => json({ error: `module "${moduleId}" is not enabled` }, 404);

/** `GET /api/settings/modules/{id}/tokens`: the module's tokens. Never a token value, only name, prefix, scopes and dates. */
export async function handleListTokens(request: Request, moduleId: string, deps: ApiAccessDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: false });
  if (viewer instanceof Response) return viewer;
  if (!(await deps.service.moduleIsEnabled(moduleId))) return notEnabled(moduleId);
  return json({ tokens: await deps.service.list(moduleId) });
}

/** `POST /api/settings/modules/{id}/tokens` `{ name, scopes, expiresInDays? }`: a new token, whose value is in this answer only. */
export async function handleCreateToken(request: Request, moduleId: string, deps: ApiAccessDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: true });
  if (viewer instanceof Response) return viewer;
  if (!(await deps.service.moduleIsEnabled(moduleId))) return notEnabled(moduleId);
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "name" && key !== "scopes" && key !== "expiresInDays");
  if (unknown.length > 0) return json({ error: `unknown field "${unknown[0]}"` }, 400);
  if (typeof body.name !== "string") return json({ error: "send the token's name as { name }" }, 400);
  if (!Array.isArray(body.scopes) || !body.scopes.every((scope) => typeof scope === "string")) return json({ error: "send the scopes as { scopes: [\"...\"] }" }, 400);
  let expiresAt: Date | undefined;
  if (body.expiresInDays !== undefined) {
    const days = body.expiresInDays;
    if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) return json({ error: `expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}` }, 400);
    expiresAt = new Date(deps.now().getTime() + days * DAY_MS);
  }
  const { name, scopes } = body as { name: string; scopes: string[] };
  return answer(async () => json(await deps.service.create({ moduleId, name, scopes, ...(expiresAt === undefined ? {} : { expiresAt }), actor: viewer.actor }), 201));
}

/** `POST /api/settings/modules/{id}/tokens/{tokenId}/regenerate`: a new token in place of this one, which is revoked. */
export async function handleRegenerateToken(request: Request, moduleId: string, tokenId: number, deps: ApiAccessDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: true });
  if (viewer instanceof Response) return viewer;
  if (!(await deps.service.moduleIsEnabled(moduleId))) return notEnabled(moduleId);
  const own = await ownToken(deps, moduleId, tokenId);
  if (own instanceof Response) return own;
  return answer(async () => json(await deps.service.regenerate(tokenId, viewer.actor)));
}

/** `DELETE /api/settings/modules/{id}/tokens/{tokenId}`: stops the token from working at once. */
export async function handleRevokeToken(request: Request, moduleId: string, tokenId: number, deps: ApiAccessDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: true });
  if (viewer instanceof Response) return viewer;
  if (!(await deps.service.moduleIsEnabled(moduleId))) return notEnabled(moduleId);
  const own = await ownToken(deps, moduleId, tokenId);
  if (own instanceof Response) return own;
  return answer(async () => json({ record: await deps.service.revoke(tokenId, viewer.actor) }));
}

/** `PUT /api/settings/api-address` `{ address }`: the address shown to API clients; `null` goes back to the platform's own. */
export async function handleSetAddress(request: Request, deps: ApiAccessDeps): Promise<Response> {
  const viewer = await authorize(request, deps, { write: true });
  if (viewer instanceof Response) return viewer;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "address");
  if (unknown.length > 0) return json({ error: `unknown field "${unknown[0]}"` }, 400);
  if (body.address === null) return answer(async () => (await deps.service.unsetAddress(viewer.actor), json({ address: null })));
  if (typeof body.address !== "string") return json({ error: "send the address as { address }, or null to clear it" }, 400);
  const address = body.address;
  return answer(async () => json({ address: await deps.service.setAddress(address, viewer.actor) }));
}
