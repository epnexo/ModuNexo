import { getDb } from "@modunexo/sdk";
import { revalidatePath } from "next/cache";

export const metadata = { title: "Inbox" };

async function addItem(formData: FormData): Promise<void> {
  "use server";
  const title = String(formData.get("title") ?? "").trim();
  if (title === "" || title.length > 200) return;
  await getDb("inbox").query("insert into items (title) values ($1)", [title]);
  revalidatePath("/inbox");
}

export default async function Page() {
  const { rows } = await getDb("inbox").query<{ id: number; title: string }>("select id, title from items order by id desc limit 50");
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{"Inbox"}</h1>
      <form action={addItem} className="flex gap-2">
        <input
          name="title"
          required
          maxLength={200}
          aria-label="New item"
          placeholder="New item"
          className="h-10 flex-1 rounded-md border border-border-strong bg-surface px-3 outline-none focus-visible:border-accent"
        />
        <button type="submit" className="h-10 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover">
          Add
        </button>
      </form>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing here yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
          {rows.map((row) => (
            <li key={row.id} className="px-4 py-3 text-sm">
              {row.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
