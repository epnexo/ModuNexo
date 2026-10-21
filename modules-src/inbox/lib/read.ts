import { getDb } from "@modunexo/sdk";

export const LIST_LIMIT = 50;
export const THREAD_LIMIT = 200;

export interface ConversationRow {
  id: number;
  channel: string;
  contactName: string | null;
  contactRef: string;
  unread: number;
  lastMessageAt: Date;
  lastText: string | null;
}

export interface MessageRow {
  id: number;
  direction: "in" | "out";
  text: string;
  status: "received" | "queued" | "sent" | "failed";
  error: string | null;
  createdAt: Date;
}

type RawConversation = {
  id: string;
  channel: string;
  name: string | null;
  ref: string;
  unread_count: number;
  last_message_at: Date;
  last_text: string | null;
};

const CONVERSATIONS =
  "select v.id, v.channel, k.name, k.ref, v.unread_count, v.last_message_at, (select m.text from messages m where m.conversation_id = v.id order by m.id desc limit 1) as last_text from conversations v join contacts k on k.id = v.contact_id";

const shape = (row: RawConversation): ConversationRow => ({ id: Number(row.id), channel: row.channel, contactName: row.name, contactRef: row.ref, unread: row.unread_count, lastMessageAt: row.last_message_at, lastText: row.last_text });

/** The newest conversations, most recent activity first. */
export async function listConversations(limit = LIST_LIMIT): Promise<ConversationRow[]> {
  const { rows } = await getDb("inbox").query<RawConversation>(`${CONVERSATIONS} order by v.last_message_at desc, v.id desc limit $1`, [limit]);
  return rows.map(shape);
}

/** One conversation with its newest messages, oldest first; null when there is no such conversation. */
export async function loadThread(id: number): Promise<{ conversation: ConversationRow; messages: MessageRow[] } | null> {
  const db = getDb("inbox");
  const found = await db.query<RawConversation>(`${CONVERSATIONS} where v.id = $1`, [id]);
  if (found.rows.length === 0) return null;
  const { rows } = await db.query<{ id: string; direction: "in" | "out"; text: string; status: MessageRow["status"]; error: string | null; created_at: Date }>(
    "select id, direction, text, status, error, created_at from (select * from messages where conversation_id = $1 order by id desc limit $2) newest order by id",
    [id, THREAD_LIMIT],
  );
  return { conversation: shape(found.rows[0]!), messages: rows.map((r) => ({ id: Number(r.id), direction: r.direction, text: r.text, status: r.status, error: r.error, createdAt: r.created_at })) };
}

export async function markRead(id: number): Promise<void> {
  await getDb("inbox").query("update conversations set unread_count = 0 where id = $1 and unread_count <> 0", [id]);
}
