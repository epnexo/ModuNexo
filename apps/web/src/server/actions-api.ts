import { ActionError, type ActionErrorCode, type ActionService, type Actor } from "@modunexo/core/actions";
import { readObject } from "./module-tokens-api.ts";
import { json, sameOriginRequest } from "./settings-api.ts";

/** Who is asking: the name the register records and what they may do. Whether they hold an action's permission is the service's to ask. */
export interface ActionsViewer {
  actor: string;
  can: (permission: string) => boolean;
}

/** What this API needs of the platform, so a test can stand in for the database. */
export interface ActionsDeps {
  /** Who is asking; null when nobody the shell may serve. */
  viewer: (headers: Headers) => Promise<ActionsViewer | null>;
  service: Pick<ActionService, "run" | "approve" | "reject">;
}

const STATUS: Record<ActionErrorCode, number> = {
  unknown_action: 404,
  disabled: 409,
  forbidden: 403,
  invalid_input: 400,
  not_proposable: 400,
  needs_approval: 400,
  too_many_pending: 429,
  not_pending: 409,
  self_approval: 403,
  failed: 502,
};
const MAX_NOTE_CHARS = 300;

/** The caller, as the service wants them: a person on the portal's channel. Any signed-in person may ask; the service checks each action's permission. */
async function authorize(request: Request, deps: ActionsDeps): Promise<Actor | Response> {
  if (!sameOriginRequest(request.headers)) return json({ error: "cross-origin request refused" }, 403);
  const viewer = await deps.viewer(request.headers);
  if (viewer === null) return json({ error: "sign-in required" }, 401);
  return { name: viewer.actor, via: "portal", can: viewer.can };
}

/** What the service refuses, said with the status that fits; its messages are written to be shown. Anything else is not ours to hide. */
async function answer(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ActionError) return json({ error: error.message, code: error.code }, STATUS[error.code]);
    throw error;
  }
}

const validId = (id: number) => Number.isSafeInteger(id) && id >= 1;

/** The facts of a decision, which is all the caller needs: what was proposed is on the screen already, and not repeated here. */
const decided = (proposal: { id: number; status: string; decidedBy: string | null; jobId: number | null }) => ({ proposal: { id: proposal.id, status: proposal.status, decidedBy: proposal.decidedBy, jobId: proposal.jobId } });

/** `POST /api/actions/run` `{ action: "<module>.<key>", input? }`: a read returns its rows; a write is the caller's own decision and queues the module's job. */
export async function handleRunAction(request: Request, deps: ActionsDeps): Promise<Response> {
  const actor = await authorize(request, deps);
  if (actor instanceof Response) return actor;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "action" && key !== "input");
  if (unknown.length > 0) return json({ error: `unknown field "${unknown[0]}"` }, 400);
  const name = body.action;
  const dot = typeof name === "string" ? name.indexOf(".") : -1;
  if (typeof name !== "string" || dot < 1 || dot === name.length - 1) return json({ error: 'send the action as { "action": "<module>.<key>" }' }, 400);
  if (body.input !== undefined && (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))) return json({ error: "input must be an object" }, 400);
  return answer(async () => json(await deps.service.run({ moduleId: name.slice(0, dot), key: name.slice(dot + 1) }, body.input, actor)));
}

/** `POST /api/actions/proposals/{id}/approve`: a person holding the action's permission approves what an agent proposed; the module's job is queued once. */
export async function handleApprove(request: Request, id: number, deps: ActionsDeps): Promise<Response> {
  const actor = await authorize(request, deps);
  if (actor instanceof Response) return actor;
  if (!validId(id)) return json({ error: "there is no such proposal" }, 404);
  return answer(async () => json(decided(await deps.service.approve(id, actor))));
}

/** `POST /api/actions/proposals/{id}/reject` `{ note? }`: the same person says no, with a short reason if they want. Nothing runs. */
export async function handleReject(request: Request, id: number, deps: ActionsDeps): Promise<Response> {
  const actor = await authorize(request, deps);
  if (actor instanceof Response) return actor;
  if (!validId(id)) return json({ error: "there is no such proposal" }, 404);
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => key !== "note");
  if (unknown.length > 0) return json({ error: `unknown field "${unknown[0]}"` }, 400);
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > MAX_NOTE_CHARS)) return json({ error: `note must be text of at most ${MAX_NOTE_CHARS} characters` }, 400);
  return answer(async () => json(decided(await deps.service.reject(id, actor, body.note as string | undefined))));
}
