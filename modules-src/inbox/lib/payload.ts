export const MAX_TEXT_CHARS = 4000;
const MAX_REF_CHARS = 200;
const CHANNEL = /^[a-z][a-z0-9_-]{0,31}$/;

export interface Inbound {
  channel: string;
  threadRef: string;
  messageId: string;
  text: string;
  contact: { ref: string; name: string | null };
}

export type Parsed = { ok: true; value: Inbound } | { ok: false; error: string };

const refOf = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" && value.length <= MAX_REF_CHARS ? value : null);

/** Checks the body a channel posts to the webhook; the error names the first field that cannot be used. */
export function parseInbound(raw: unknown): Parsed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "The body must be a JSON object." };
  const body = raw as Record<string, unknown>;
  if (typeof body.channel !== "string" || !CHANNEL.test(body.channel)) return { ok: false, error: '"channel" must be lowercase letters, digits, "_" or "-", starting with a letter, up to 32 characters.' };
  const threadRef = refOf(body.threadRef);
  if (threadRef === null) return { ok: false, error: `"threadRef" must be a text of 1 to ${MAX_REF_CHARS} characters.` };
  const messageId = refOf(body.messageId);
  if (messageId === null) return { ok: false, error: `"messageId" must be a text of 1 to ${MAX_REF_CHARS} characters.` };
  if (typeof body.text !== "string" || body.text.trim() === "" || body.text.length > MAX_TEXT_CHARS) return { ok: false, error: `"text" must be a text of 1 to ${MAX_TEXT_CHARS} characters that is not blank.` };

  let contact = { ref: threadRef, name: null as string | null };
  if (body.contact !== undefined) {
    if (typeof body.contact !== "object" || body.contact === null || Array.isArray(body.contact)) return { ok: false, error: '"contact" must be an object.' };
    const given = body.contact as Record<string, unknown>;
    const ref = refOf(given.ref);
    if (ref === null) return { ok: false, error: `"contact.ref" must be a text of 1 to ${MAX_REF_CHARS} characters.` };
    if (given.name !== undefined && given.name !== null && (typeof given.name !== "string" || given.name.length > MAX_REF_CHARS)) return { ok: false, error: `"contact.name" must be a text of up to ${MAX_REF_CHARS} characters.` };
    const name = typeof given.name === "string" && given.name.trim() !== "" ? given.name.trim() : null;
    contact = { ref, name };
  }
  return { ok: true, value: { channel: body.channel, threadRef, messageId, text: body.text, contact } };
}
