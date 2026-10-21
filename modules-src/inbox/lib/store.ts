import { getDb, publishEvent } from "@modunexo/sdk";
import type { Inbound } from "./payload.ts";

export interface Received {
  duplicate: boolean;
}

/**
 * Stores one inbound message. The contact and the conversation are created when they are new, the unread count grows,
 * and the event is published in the same transaction, so a write that rolls back announces nothing. A message the
 * channel already delivered (same channel and message id) changes nothing and announces nothing.
 */
export async function receiveMessage(input: Inbound): Promise<Received> {
  return getDb("inbox").transaction(async (tx) => {
    const contact = await tx.query<{ id: string }>(
      "insert into contacts (channel, ref, name) values ($1, $2, $3) on conflict (channel, ref) do update set name = coalesce(contacts.name, excluded.name) returning id",
      [input.channel, input.contact.ref, input.contact.name],
    );
    const conversation = await tx.query<{ id: string }>(
      "insert into conversations (channel, thread_ref, contact_id) values ($1, $2, $3) on conflict (channel, thread_ref) do update set contact_id = conversations.contact_id returning id",
      [input.channel, input.threadRef, contact.rows[0]!.id],
    );
    const conversationId = Number(conversation.rows[0]!.id);
    const stored = await tx.query<{ id: string }>(
      "insert into messages (conversation_id, channel, direction, text, status, provider_message_id) values ($1, $2, 'in', $3, 'received', $4) on conflict (channel, provider_message_id) where provider_message_id is not null do nothing returning id",
      [conversationId, input.channel, input.text, input.messageId],
    );
    if (stored.rows.length === 0) return { duplicate: true };
    await tx.query("update conversations set unread_count = unread_count + 1, last_message_at = now() where id = $1", [conversationId]);
    await publishEvent("inbox", "message.received", { channel: input.channel, conversationId, messageId: Number(stored.rows[0]!.id) }, { tx });
    return { duplicate: false };
  });
}
