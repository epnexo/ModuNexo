import { enqueueJob, getDb, getSetting } from "@modunexo/sdk";
import { MAX_TEXT_CHARS } from "./payload.ts";

export type Replied = { found: false } | { found: true; messageId: number };

/** The reply text as it is stored, or null when it is blank or too long. */
export function replyText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text === "" || text.length > MAX_TEXT_CHARS ? null : text;
}

/**
 * Stores an operator's reply as queued and asks the worker to deliver it. With no outbound URL set nothing is
 * enqueued and the reply waits. If the delivery cannot be enqueued the reply is marked failed, so it is never
 * left queued with nobody to send it.
 */
export async function queueReply(conversationId: number, text: string): Promise<Replied> {
  const db = getDb("inbox");
  const messageId = await db.transaction(async (tx) => {
    const conversation = await tx.query<{ channel: string }>("select channel from conversations where id = $1", [conversationId]);
    if (conversation.rows.length === 0) return null;
    const stored = await tx.query<{ id: string }>("insert into messages (conversation_id, channel, direction, text, status) values ($1, $2, 'out', $3, 'queued') returning id", [conversationId, conversation.rows[0]!.channel, text]);
    await tx.query("update conversations set last_message_at = now() where id = $1", [conversationId]);
    return Number(stored.rows[0]!.id);
  });
  if (messageId === null) return { found: false };
  const url = await getSetting("inbox", "outbound_url");
  if (typeof url === "string" && url.trim() !== "") {
    try {
      await enqueueJob("inbox", "deliver", { messageId }, { dedupeKey: `deliver:${messageId}` });
    } catch {
      await db.query("update messages set status = 'failed', error = $2 where id = $1 and status = 'queued'", [messageId, "The delivery could not be queued."]);
    }
  }
  return { found: true, messageId };
}
