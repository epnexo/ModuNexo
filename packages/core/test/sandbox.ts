import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { SDK_VERSION, type ModuleManifest } from "@modunexo/sdk";
import { Registry, type RegistryOptions } from "../src/registry.ts";

export interface Throwaway {
  manifest: ModuleManifest;
  dir: string;
  write: (filename: string, sql: string) => void;
}

/** Throwaway modules with unique ids and schemas plus temp migration directories, and the cleanup for them. */
export class Sandbox {
  readonly modules: Throwaway[] = [];

  constructor(private readonly pool: pg.Pool) {}

  add(dependsOn: Record<string, string> = {}): Throwaway {
    const suffix = randomBytes(4).toString("hex");
    const dir = mkdtempSync(join(tmpdir(), "modunexo-runner-"));
    const manifest: ModuleManifest = {
      id: `t-${suffix}`,
      version: "1.0.0",
      name: "Throwaway",
      platform: `^${SDK_VERSION}`,
      dependsOn,
      schema: `t_${suffix}`,
      migrationsDir: dir,
      nav: [],
    };
    const module: Throwaway = { manifest, dir, write: (filename, sql) => writeFileSync(join(dir, filename), sql) };
    this.modules.push(module);
    return module;
  }

  /** A registry with the core and every throwaway module added so far. Pass options to admit unsupported platforms. */
  registry(options?: RegistryOptions): Registry {
    const registry = new Registry(options);
    registry.registerCore();
    for (const { manifest } of this.modules) registry.register(manifest);
    return registry;
  }

  async cleanup(): Promise<void> {
    for (const { manifest, dir } of this.modules) {
      await this.pool.query("delete from core.schema_migrations where module_id = $1", [manifest.id]).catch(() => undefined);
      await this.pool.query("delete from core.modules where id = $1", [manifest.id]).catch(() => undefined);
      await this.pool.query("delete from core.module_events where module_id = $1", [manifest.id]).catch(() => undefined);
      await this.pool.query(`drop schema if exists "${manifest.schema}" cascade`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
