import { GroupError, type Group, type GroupOverview } from "@modunexo/core/groups";
import { json, parseJsonBody, readBodyText, sameOriginRequest } from "./settings-api.ts";

/** What the API needs of the group service, so a test can stand in for the database. */
export interface GroupsPort {
  overview: () => Promise<GroupOverview>;
  create: (name: string) => Promise<Group>;
  rename: (id: number, name: string) => Promise<Group>;
  move: (id: number, position: number) => Promise<Group[]>;
  remove: (id: number) => Promise<void>;
  assign: (moduleId: string, groupId: number | null) => Promise<void>;
}

export interface GroupsDeps {
  /** Who is asking; null when nobody the shell may serve. */
  viewer: (headers: Headers) => Promise<{ actor: string; canWrite: boolean } | null>;
  service: GroupsPort;
}

const STATUS: Record<GroupError["code"], number> = { "invalid-name": 400, duplicate: 409, "not-found": 404, "module-not-installed": 404 };

/** Same origin (for a write), a viewer, and the right to change things: the checks every call of this API shares. */
async function authorize(request: Request, deps: GroupsDeps, options: { write: boolean }): Promise<true | Response> {
  if (options.write && !sameOriginRequest(request.headers)) return json({ error: "cross-origin request refused" }, 403);
  const viewer = await deps.viewer(request.headers);
  if (viewer === null) return json({ error: "sign-in required" }, 401);
  if (!viewer.canWrite) return json({ error: "only an administrator can manage groups" }, 403);
  return true;
}

async function readObject(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await readBodyText(request);
  if (!text.ok) return json({ error: text.message }, 413);
  const parsed = parseJsonBody(text.text);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  if (typeof parsed.body !== "object" || parsed.body === null || Array.isArray(parsed.body)) return json({ error: "the request body must be an object" }, 400);
  return parsed.body as Record<string, unknown>;
}

/** A refusal of the service becomes its status and its message; anything else is not ours to explain. */
async function answer(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GroupError) return json({ error: error.message, code: error.code }, STATUS[error.code]);
    throw error;
  }
}

/** `GET /api/groups`: the groups, in order, and which module sits in which. */
export async function handleList(request: Request, deps: GroupsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: false });
  if (authorized !== true) return authorized;
  return json(await deps.service.overview());
}

/** `POST /api/groups` `{ name }`: a new group, last in the menu. */
export async function handleCreate(request: Request, deps: GroupsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: true });
  if (authorized !== true) return authorized;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  if (typeof body.name !== "string") return json({ error: "send the group's name as { name }" }, 400);
  const name = body.name;
  return answer(async () => json({ group: await deps.service.create(name) }, 201));
}

/** `PATCH /api/groups/{id}` `{ name?, position? }`: renames the group, moves it in the menu, or both. */
export async function handleUpdate(request: Request, id: number, deps: GroupsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: true });
  if (authorized !== true) return authorized;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "name" && key !== "position");
  if (unknown.length > 0) return json({ error: `unknown field "${unknown[0]}"` }, 400);
  if (body.name === undefined && body.position === undefined) return json({ error: "send { name }, { position } or both" }, 400);
  if (body.name !== undefined && typeof body.name !== "string") return json({ error: "name must be a string" }, 400);
  if (body.position !== undefined && !Number.isSafeInteger(body.position)) return json({ error: "position must be a whole number" }, 400);
  const { name, position } = body as { name?: string; position?: number };
  return answer(async () => {
    if (name !== undefined) await deps.service.rename(id, name);
    if (position !== undefined) await deps.service.move(id, position);
    return json(await deps.service.overview());
  });
}

/** `DELETE /api/groups/{id}`: its modules stay installed and have no group. */
export async function handleRemove(request: Request, id: number, deps: GroupsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: true });
  if (authorized !== true) return authorized;
  return answer(async () => {
    await deps.service.remove(id);
    return json(await deps.service.overview());
  });
}

/** `POST /api/groups/assign` `{ moduleId, groupId }`: `groupId` null takes the module out of its group. */
export async function handleAssign(request: Request, deps: GroupsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: true });
  if (authorized !== true) return authorized;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const { moduleId, groupId } = body;
  if (typeof moduleId !== "string" || moduleId === "") return json({ error: "send the module's id as { moduleId }" }, 400);
  if (groupId !== null && !(typeof groupId === "number" && Number.isSafeInteger(groupId) && groupId > 0)) return json({ error: "groupId must be a group's id or null" }, 400);
  return answer(async () => {
    await deps.service.assign(moduleId, groupId as number | null);
    return json(await deps.service.overview());
  });
}

/** The id in a URL: a whole number, or null. */
export function groupIdFrom(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}
