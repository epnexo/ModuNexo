import { queueReply, replyText } from "../lib/reply.ts";

/** Same rule as the shell's own forms: the request must come from a page served by this host. Forwarding headers are not consulted. */
function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const refuse = (message: string, status: number): Response => Response.json({ error: message }, { status });

/** The operator's reply form. The gate has already required `inbox.write`; the origin is checked here. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request.headers)) return refuse("The request must come from this site.", 403);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse("The body must be a form.", 400);
  }
  const id = form.get("conversationId");
  if (typeof id !== "string" || !/^\d{1,15}$/.test(id)) return refuse('"conversationId" must be a number.', 400);
  const text = replyText(form.get("text"));
  if (text === null) return refuse('"text" must be 1 to 4000 characters that are not blank.', 400);
  const replied = await queueReply(Number(id), text);
  if (!replied.found) return refuse("No such conversation.", 404);
  return new Response(null, { status: 303, headers: { location: `/inbox?c=${Number(id)}` } });
}
