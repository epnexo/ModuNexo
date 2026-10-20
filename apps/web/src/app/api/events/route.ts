import { EventService } from "@modunexo/core/events";
import { log } from "@modunexo/core/log";
import { eventHub } from "../../../server/event-hub";
import { MAX_STREAMS, openEventStream, selectEventTypes, streamableEvents } from "../../../server/event-stream";
import { platform } from "../../../server/platform";
import { enabledModuleIds, webRegistry } from "../../../server/registry";
import { resolveViewer } from "../../../server/viewer";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const ENABLED_TTL_MS = 5000;
let open = 0;
let enabled: { at: number; ids: ReadonlySet<string> } | undefined;

const refuse = (status: number, error: string, extra: Record<string, string> = {}) => Response.json({ error }, { status, headers: { ...NO_STORE, ...extra } });

/** The enabled modules, read from the database at most every few seconds however many streams are open. */
async function enabledModules(): Promise<ReadonlySet<string>> {
  if (enabled === undefined || Date.now() - enabled.at > ENABLED_TTL_MS) enabled = { at: Date.now(), ids: await enabledModuleIds(platform().pool) };
  return enabled.ids;
}

/**
 * A server-sent-events stream of the events the viewer may follow: `?types=a.b,c.d` narrows it, `?after=<id>` or the
 * `Last-Event-ID` header (the browser sends it when it reconnects) resumes after the last event seen. Only events that
 * their module tied to a permission are ever sent.
 */
export async function GET(request: Request) {
  const viewer = await resolveViewer(request.headers);
  if (viewer === null) return refuse(401, "Sign-in required");
  const registry = webRegistry();
  const url = new URL(request.url);
  const picked = selectEventTypes(streamableEvents(registry.all()), viewer.subject, url.searchParams.get("types"));
  if (!picked.ok) return refuse(picked.status, picked.error);

  const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "";
  if (cursor !== "" && !/^\d{1,15}$/.test(cursor)) return refuse(400, "the cursor must be a whole number");
  if (open >= MAX_STREAMS) return refuse(503, "too many open event streams", { "retry-after": "5" });

  open++;
  let hub;
  try {
    hub = await eventHub();
  } catch (error) {
    open--;
    log.error("events.stream_unavailable", { error });
    return refuse(503, "events are not available right now", { "retry-after": "5" });
  }
  const stream = openEventStream(
    { hub, events: new EventService(platform().pool, registry), enabledModules, log },
    { types: picked.types, after: cursor === "" ? 0 : Number(cursor), signal: request.signal, onClose: () => void open-- },
  );
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
