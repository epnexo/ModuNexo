import { getSetting } from "@modunexo/sdk";
import { listConversations, loadThread, markRead, type ConversationRow, type MessageRow } from "../lib/read.ts";
import { Live } from "./live.tsx";

export const metadata = { title: "Inbox" };

const when = (date: Date): string => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
const label = (row: ConversationRow): string => row.contactName ?? row.contactRef;

const STATUS: Record<MessageRow["status"], string> = { received: "", queued: "Queued", sent: "Sent", failed: "Failed" };

export default async function Page({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  const { c } = await searchParams;
  const asked = typeof c === "string" && /^\d{1,15}$/.test(c) ? Number(c) : null;
  const thread = asked === null ? null : await loadThread(asked);
  if (thread !== null && thread.conversation.unread > 0) await markRead(thread.conversation.id);
  const conversations = await listConversations();
  const outbound = await getSetting("inbox", "outbound_url");
  const canSend = typeof outbound === "string" && outbound.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      <Live />
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <nav aria-label="Conversations" className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
          {conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted">No conversation yet. Messages a channel posts to /hooks/inbox/messages appear here.</p>
          ) : (
            conversations.map((row) => {
              const selected = thread?.conversation.id === row.id;
              return (
                <a key={row.id} href={`/inbox?c=${row.id}`} aria-current={selected ? "page" : undefined} className={`flex flex-col gap-1 px-4 py-3 text-sm transition-colors duration-150 hover:bg-accent-soft ${selected ? "bg-accent-soft" : ""}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{label(row)}</span>
                    {row.unread > 0 && !selected ? <span className="rounded-full bg-accent px-2 text-xs text-accent-foreground">{row.unread}</span> : null}
                  </span>
                  <span className="truncate text-muted">{row.lastText ?? ""}</span>
                  <span className="text-xs text-muted">
                    {row.channel} · <time dateTime={row.lastMessageAt.toISOString()}>{when(row.lastMessageAt)}</time>
                  </span>
                </a>
              );
            })
          )}
        </nav>

        <section aria-label="Conversation" className="flex min-h-64 flex-col gap-4 rounded-lg border border-border bg-surface p-4">
          {thread === null ? (
            <p className="text-sm text-muted">{asked === null ? "Select a conversation." : "That conversation does not exist."}</p>
          ) : (
            <>
              <h2 className="text-lg font-semibold tracking-tight">{label(thread.conversation)}</h2>
              <ol className="flex flex-col gap-3">
                {thread.messages.map((message) => (
                  <li key={message.id} className={`flex max-w-xl flex-col gap-1 rounded-lg px-3 py-2 text-sm ${message.direction === "out" ? "self-end bg-accent-soft" : "self-start border border-border"}`}>
                    <span className="whitespace-pre-wrap break-words">{message.text}</span>
                    <span className="text-xs text-muted">
                      <time dateTime={message.createdAt.toISOString()}>{when(message.createdAt)}</time>
                      {STATUS[message.status] === "" ? "" : ` · ${STATUS[message.status]}`}
                      {message.error === null ? "" : ` · ${message.error}`}
                    </span>
                  </li>
                ))}
              </ol>
              {canSend ? null : (
                <p role="note" className="rounded-md bg-warning-soft px-3 py-2 text-sm">
                  No outbound URL is set in this module&apos;s settings, so a reply stays queued.
                </p>
              )}
              <form method="post" action="/inbox/reply" className="flex flex-col gap-2">
                <input type="hidden" name="conversationId" value={thread.conversation.id} />
                <label htmlFor="reply-text" className="text-sm font-medium">
                  Reply
                </label>
                <textarea id="reply-text" name="text" required maxLength={4000} rows={3} className="rounded-md border border-border-strong bg-surface px-3 py-2 outline-none focus-visible:border-accent" />
                <button type="submit" className="h-10 self-start rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover">
                  Send
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
