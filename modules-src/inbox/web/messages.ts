import { parseInbound } from "../lib/payload.ts";
import { receiveMessage } from "../lib/store.ts";

const json = (body: unknown, status: number): Response => Response.json(body, { status });

/** The channel's webhook. The shell has already checked the signature, the size and the rate before this runs. */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return json({ error: "The body must be JSON." }, 400);
  }
  const parsed = parseInbound(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { duplicate } = await receiveMessage(parsed.value);
  return json({ ok: true, duplicate }, 200);
}
