import { SDK_VERSION } from "@epnexo/sdk";
import type { TarEntry } from "./tarball.ts";

export interface PackageOptions {
  id?: string;
  version?: string;
  manifest?: Record<string, unknown>;
  packageJson?: Record<string, unknown>;
  /** Replace or add files, by path inside the package. `null` removes one. */
  files?: Record<string, string | null>;
}

/** The entries of a good module archive, under a top-level `package/` folder, like `npm pack` writes. */
export function packageEntries(options: PackageOptions = {}): TarEntry[] {
  const id = options.id ?? "reports";
  const version = options.version ?? "1.0.0";
  const files: Record<string, string | null> = {
    "package.json": JSON.stringify({ name: `@acme/${id}`, version, ...options.packageJson }),
    "manifest.json": JSON.stringify({
      id,
      version,
      name: "Reports",
      platform: `^${SDK_VERSION}`,
      dependsOn: {},
      schema: id.replace(/-/g, "_"),
      migrationsDir: "migrations",
      nav: [{ label: "Reports", href: `/${id}` }],
      pages: [{ path: `/${id}`, entry: "./web/page.tsx", kind: "page" }],
      ...options.manifest,
    }),
    "manifest.ts": "export default {};\n",
    "migrations/0001_init.sql": "create table items (id int);\n",
    "web/page.tsx": "export default function Page() { return null; }\n",
    ...options.files,
  };
  return [{ name: "package/", type: "5" }, ...Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== null).map(([name, data]) => ({ name: `package/${name}`, data }))];
}
