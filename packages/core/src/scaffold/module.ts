import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ManifestError, SDK_VERSION, validateManifest } from "@epnexo/sdk";
import { CORE_MODULE_ID } from "../core-module.ts";

/** The generator refused: nothing was written. */
export class ScaffoldRefusedError extends Error {}

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface ScaffoldInput {
  id: string;
  /** Human-readable name. Default: the id in title case. */
  name?: string;
  /** The folder the module folder is created in. Created when missing. */
  parentDir: string;
}

export interface ScaffoldResult {
  folder: string;
  /** Paths relative to `folder`, sorted. */
  files: string[];
}

const titleCase = (id: string): string =>
  id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

/** The files of a new module, as path -> content. Every value that came from the caller goes in as a JSON string. */
function templates(id: string, schema: string, name: string): Record<string, string> {
  const permission = `${schema}.use`;
  const path = `/${id}`;
  return {
    "package.json": `${JSON.stringify({ name: `@local/${id}`, version: "0.1.0", private: true, type: "module" }, null, 2)}\n`,
    "manifest.ts": `import { SDK_VERSION, defineModule } from "@epnexo/sdk";

export default defineModule({
  id: ${JSON.stringify(id)},
  version: "0.1.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: ${JSON.stringify(name)},
  platform: \`^\${SDK_VERSION}\`,
  // Modules whose data this one reads, with \`getDb(${JSON.stringify(id)}).reader("<id>")\`. Each must be installed first.
  dependsOn: {},
  schema: ${JSON.stringify(schema)}, // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [{ key: ${JSON.stringify(permission)}, label: ${JSON.stringify(`Use ${name}`)} }],
  nav: [{ label: ${JSON.stringify(name)}, href: ${JSON.stringify(path)}, icon: "app", permission: ${JSON.stringify(permission)} }],
  pages: [{ path: ${JSON.stringify(path)}, entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic", permission: ${JSON.stringify(permission)} }],
});
`,
    "migrations/0001_init.sql": `-- Runs with search_path set to this module's schema. Never edit an applied file: add 0002_*.sql instead.
create table items (
  id serial primary key,
  title text not null,
  created_at timestamptz not null default now()
);
`,
    "web/page.tsx": `import { getDb } from "@epnexo/sdk";
import { revalidatePath } from "next/cache";

export const metadata = { title: ${JSON.stringify(name)} };

async function addItem(formData: FormData): Promise<void> {
  "use server";
  const title = String(formData.get("title") ?? "").trim();
  if (title === "" || title.length > 200) return;
  await getDb(${JSON.stringify(id)}).query("insert into items (title) values ($1)", [title]);
  revalidatePath(${JSON.stringify(path)});
}

export default async function Page() {
  const { rows } = await getDb(${JSON.stringify(id)}).query<{ id: number; title: string }>("select id, title from items order by id desc limit 50");
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{${JSON.stringify(name)}}</h1>
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
`,
  };
}

/**
 * Write a working module folder: a manifest with one permission, nav entry and page, a first migration, and a page
 * that lists and adds rows through `getDb`. The folder is built in a temporary sibling and moved into place, so a
 * failure leaves nothing half-written, and an existing folder is never touched.
 */
export async function scaffoldModule(input: ScaffoldInput): Promise<ScaffoldResult> {
  const { id } = input;
  if (!KEBAB_CASE.test(id)) throw new ScaffoldRefusedError(`"${id}" is not a valid module id: use lowercase letters, digits and single hyphens, starting with a letter`);
  if (id === CORE_MODULE_ID) throw new ScaffoldRefusedError(`module id "${CORE_MODULE_ID}" is reserved for the platform`);
  const name = (input.name ?? titleCase(id)).trim();
  if (name === "" || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ScaffoldRefusedError("the name must be 1 to 80 characters of plain text");
  }
  const schema = id.replaceAll("-", "_");
  const files = templates(id, schema, name);

  // The generated manifest must be one the platform accepts, whatever the id or name was.
  try {
    validateManifest({
      id,
      version: "0.1.0",
      name,
      platform: `^${SDK_VERSION}`,
      dependsOn: {},
      schema,
      migrationsDir: "migrations",
      permissions: [{ key: `${schema}.use`, label: `Use ${name}` }],
      nav: [{ label: name, href: `/${id}`, icon: "app", permission: `${schema}.use` }],
      pages: [{ path: `/${id}`, entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic", permission: `${schema}.use` }],
    });
  } catch (error) {
    if (error instanceof ManifestError) throw new ScaffoldRefusedError(`"${id}" cannot be used: ${error.problems.join("; ")}`);
    throw error;
  }

  const folder = join(input.parentDir, id);
  if (existsSync(folder)) throw new ScaffoldRefusedError(`${folder} already exists; nothing was written`);

  let staging: string;
  try {
    await mkdir(input.parentDir, { recursive: true });
    staging = await mkdtemp(join(input.parentDir, `.${id}-new-`));
  } catch (error) {
    throw writeRefusal(error, input.parentDir);
  }
  try {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(dirname(join(staging, relative)), { recursive: true });
      await writeFile(join(staging, relative), content);
    }
    await rename(staging, folder);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw writeRefusal(error, folder);
  }
  return { folder, files: Object.keys(files).sort() };
}

/** Where the folder cannot be written (a file in the way, no permission) is a refusal that names the place, not a raw errno. */
function writeRefusal(error: unknown, where: string): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ["EEXIST", "ENOTDIR", "EACCES", "EPERM", "ENOTEMPTY", "EROFS"].includes(code)) {
    return new ScaffoldRefusedError(`cannot write to ${where} (${code}); nothing was written`);
  }
  return error;
}
