import { constants } from "node:fs";
import { link, mkdir, open, opendir, lstat, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FileError } from "./errors.ts";

/** One stored object and when it was last written, as a sweep needs to see it. */
export interface StoredObject {
  key: string;
  modifiedAt: Date;
}

/**
 * Where the bytes live. The service decides every key; an adapter only moves bytes under them. A key is slash-separated
 * segments of letters, digits, `.`, `_` and `-` (the first character of each a letter or digit; `.tmp` may start a key),
 * at most 200 characters. Another adapter (object storage) implements these six calls and changes no module.
 */
export interface FileStorage {
  /** Stores what `source` yields under a new key. Rejects if the key exists or the source fails, leaving nothing behind. */
  write(key: string, source: AsyncIterable<Uint8Array>): Promise<void>;
  /** The bytes under `key`, or null when there are none. */
  open(key: string): Promise<Readable | null>;
  /** Gives the object under `from` the key `to`. Rejects if `to` exists. */
  move(from: string, to: string): Promise<void>;
  /** Removes one object. A key with nothing under it is not an error. */
  remove(key: string): Promise<void>;
  /** Removes everything whose key starts with the segment path `prefix`. */
  removePrefix(prefix: string): Promise<void>;
  /** Every stored object. */
  list(): AsyncIterable<StoredObject>;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY_CHARS = 200;
const MISSING = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

function checkKey(key: string): string[] {
  const parts = typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_CHARS ? key.split("/") : [];
  if (parts.length === 0 || !parts.every((part, i) => SEGMENT.test(part) || (i === 0 && part === ".tmp"))) {
    throw new FileError("invalid storage key");
  }
  return parts;
}

/** Files in a folder, one file per key, readable only by the platform's user. */
export class DiskStorage implements FileStorage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, ...checkKey(key));
  }

  async write(key: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // "wx": never replace bytes that are already there, and never write through a link someone planted.
    const handle = await open(path, "wx", 0o600);
    try {
      await pipeline(Readable.from(source), handle.createWriteStream());
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async open(key: string): Promise<Readable | null> {
    const path = this.path(key);
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await handle.stat()).isFile()) {
        await handle.close();
        return null;
      }
      return handle.createReadStream();
    } catch (error) {
      if (MISSING.has((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  }

  async move(from: string, to: string): Promise<void> {
    const source = this.path(from);
    const target = this.path(to);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // A hard link fails when the target exists, which a rename would not.
    await link(source, target);
    await unlink(source);
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async removePrefix(prefix: string): Promise<void> {
    await rm(this.path(prefix), { recursive: true, force: true });
  }

  async *list(): AsyncGenerator<StoredObject> {
    yield* this.walk([]);
  }

  private async *walk(parts: string[]): AsyncGenerator<StoredObject> {
    let directory;
    try {
      directory = await opendir(join(this.root, ...parts));
    } catch (error) {
      if (MISSING.has((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const children: { name: string; directory: boolean }[] = [];
    for await (const entry of directory) {
      // Links are not followed or listed.
      if (entry.isDirectory()) children.push({ name: entry.name, directory: true });
      else if (entry.isFile()) children.push({ name: entry.name, directory: false });
    }
    for (const child of children) {
      const next = [...parts, child.name];
      try {
        checkKey(next.join("/"));
      } catch {
        continue;
      }
      if (child.directory) {
        yield* this.walk(next);
        continue;
      }
      try {
        yield { key: next.join("/"), modifiedAt: (await lstat(join(this.root, ...next))).mtime };
      } catch (error) {
        if (!MISSING.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }
}
