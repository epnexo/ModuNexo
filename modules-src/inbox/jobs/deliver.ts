import { getDb, getSetting, type JobContext } from "@modunexo/sdk";
import { DELIVER_ATTEMPTS } from "../lib/limits.ts";
import { signature } from "../lib/sign.ts";

type Pending = {
  id: string;
  text: string;
  channel: string;
  thread_ref: string;
  contact_ref: string;
};

/** `fetch` also accepts other schemes (a `data:` address answers ok without sending anything), so only http and https are used. */
function isHttpAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Sends one queued reply to the outbound URL, signed with the outbound secret. A reply that is already sent, or is not
 * a queued reply, is left alone, so a repeated run sends nothing twice. The reason kept for a failure is never more than
 * the status or a fixed phrase: it names neither the URL nor the secret nor what the provider answered.
 */
export default async function deliver(ctx: JobContext): Promise<void> {
  const messageId = (ctx.payload as { messageId?: unknown } | null)?.messageId;
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId)) return;
  const db = getDb("inbox");
  const found = await db.query<Pending>(
    "select m.id, m.text, c.channel, c.thread_ref, k.ref as contact_ref from messages m join conversations c on c.id = m.conversation_id join contacts k on k.id = c.contact_id where m.id = $1 and m.direction = 'out' and m.status = 'queued'",
    [messageId],
  );
  const message = found.rows[0];
  if (message === undefined) return;

  const url = textOf(await getSetting("inbox", "outbound_url"));
  if (url === "") return;
  if (!isHttpAddress(url)) {
    await db.query("update messages set status = 'failed', error = $2 where id = $1", [messageId, "The setting outbound_url must be an http or https address."]);
    return;
  }
  const secret = textOf(await getSetting("inbox", "outbound_secret"));
  if (secret === "") {
    await db.query("update messages set status = 'failed', error = $2 where id = $1", [messageId, "The setting outbound_secret is not set."]);
    return;
  }

  const body = JSON.stringify({ channel: message.channel, threadRef: message.thread_ref, messageId: String(message.id), text: message.text, contact: { ref: message.contact_ref } });
  let reason: string | null = null;
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-signature": signature(secret, body) }, body, redirect: "error", signal: ctx.signal });
    if (!response.ok) reason = `HTTP ${response.status}`;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    reason = ctx.signal.aborted ? "The provider took too long." : "The provider could not be reached.";
  }

  if (reason === null) {
    await db.query("update messages set status = 'sent', error = null where id = $1 and status = 'queued'", [messageId]);
    return;
  }
  const last = ctx.attempt >= DELIVER_ATTEMPTS;
  await db.query("update messages set status = $2, error = $3 where id = $1", [messageId, last ? "failed" : "queued", reason]);
  throw new Error(reason);
}
