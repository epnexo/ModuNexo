import { LaunchBusyError } from "@epnexo/core/install";
import { UploadTooLargeError } from "@epnexo/core/packages";
import type { IntakeResult } from "@epnexo/core/packages";
import { json, parseJsonBody, readBodyText, sameOriginRequest } from "./settings-api.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export interface AppsDeps {
  /** Who is asking; null when nobody the shell may serve. */
  viewer: (headers: Headers) => Promise<{ actor: string; canWrite: boolean } | null>;
  /** Brings the uploaded archive in through intake. */
  receive: (body: ReadableStream<Uint8Array>, options: { actor: string; expectedSha256?: string }) => Promise<IntakeResult>;
  /** Whether a package with this SHA-256 was staged and its tree is still on disk. */
  isStaged: (sha256: string) => Promise<boolean>;
  /** Starts `modules apply` detached. */
  launch: (sha256: string, actor: string) => Promise<{ pid: number; logFile: string }>;
  /** What the screen shows: recent runs, received packages, the run in progress. */
  state: () => Promise<{ operations: unknown[]; packages: unknown[]; running: unknown }>;
  maxUploadBytes: number;
}

/** Same origin, a viewer, and the right to change things: the checks every write and read of this API shares. */
async function authorize(request: Request, deps: AppsDeps, options: { write: boolean }): Promise<{ actor: string } | Response> {
  if (options.write && !sameOriginRequest(request.headers)) return json({ error: "cross-origin request refused" }, 403);
  const viewer = await deps.viewer(request.headers);
  if (viewer === null) return json({ error: "sign-in required" }, 401);
  if (!viewer.canWrite) return json({ error: "only an administrator can manage apps" }, 403);
  return { actor: viewer.actor };
}

/** `POST /api/apps/packages`: the body is the archive; `x-expected-sha256` is optional. Stages it, installs nothing. */
export async function handleUpload(request: Request, deps: AppsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: true });
  if (authorized instanceof Response) return authorized;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > deps.maxUploadBytes) {
    await request.body?.cancel().catch(() => undefined);
    return json({ error: `the archive is larger than ${deps.maxUploadBytes} bytes` }, 413);
  }
  const expected = request.headers.get("x-expected-sha256");
  if (expected !== null && !SHA256.test(expected)) return json({ error: "x-expected-sha256 must be 64 lowercase hexadecimal characters" }, 400);
  if (request.body === null) return json({ error: "the request has no body: send the archive" }, 400);

  try {
    const result = await deps.receive(request.body, { actor: authorized.actor, ...(expected === null ? {} : { expectedSha256: expected }) });
    if (!result.ok) return json({ status: "refused", sha256: result.sha256, sizeBytes: result.sizeBytes, problems: result.problems }, 422);
    return json({ status: "staged", sha256: result.sha256, sizeBytes: result.sizeBytes, alreadyStaged: result.alreadyStaged, review: result.review });
  } catch (error) {
    if (error instanceof UploadTooLargeError) return json({ error: `the archive is larger than ${error.limit} bytes` }, 413);
    throw error;
  }
}

/** `POST /api/apps/operations` `{ sha256 }`: starts the install or upgrade of a staged package. Answers at once. */
export async function handleStart(request: Request, deps: AppsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: true });
  if (authorized instanceof Response) return authorized;

  const text = await readBodyText(request);
  if (!text.ok) return json({ error: text.message }, 413);
  const parsed = parseJsonBody(text.text);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "the request body must be an object" }, 400);
  const keys = Object.keys(body);
  const sha256 = (body as { sha256?: unknown }).sha256;
  if (keys.length !== 1 || typeof sha256 !== "string" || !SHA256.test(sha256)) return json({ error: "send { sha256 }: the 64 lowercase hexadecimal characters of a staged package" }, 400);
  if (!(await deps.isStaged(sha256))) return json({ error: "no staged package has that SHA-256; upload it first" }, 404);

  try {
    await deps.launch(sha256, authorized.actor);
  } catch (error) {
    if (error instanceof LaunchBusyError) return json({ error: error.message }, 409);
    throw error;
  }
  return json({ status: "started", sha256 }, 202);
}

/** `GET /api/apps`: for the screen's polling. */
export async function handleState(request: Request, deps: AppsDeps): Promise<Response> {
  const authorized = await authorize(request, deps, { write: false });
  if (authorized instanceof Response) return authorized;
  return json(await deps.state());
}


/** The actor as the apply process accepts it: a plain name. An email is kept; anything else is made plain. */
export function plainActor(actor: string): string {
  const cleaned = actor.replace(/[^A-Za-z0-9:._@-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100);
  return cleaned === "" ? "web" : cleaned;
}
