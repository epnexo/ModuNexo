import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type pg from "pg";
import { DEFAULT_FILE_MAX_BYTES, type FileData, type FileMeta, type FilesService, type ListFilesOptions, type PutFileInput, type PutFileOptions, type StoredFile } from "@modunexo/sdk";
import type { Executor } from "../executor.ts";
import type { Registry } from "../registry.ts";
import { FileError } from "./errors.ts";
import { safeFileName } from "./name.ts";
import { SNIFF_BYTES, acceptsType, sniffContentType } from "./sniff.ts";
import type { FileStorage } from "./storage.ts";

export const MAX_FILE_REF_CHARS = 200;
/** Bytes without a row are removed once they are this old; a finished put takes seconds, an open transaction rarely a day. */
export const ORPHAN_AFTER_MS = 24 * 3600 * 1000;
/** A half-written upload is removed once it is this old. */
export const TEMP_AFTER_MS = 3600 * 1000;
const DEFAULT_LIST = 100;
const MAX_LIST = 500;
const SWEEP_BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const COLUMNS = "id, name, content_type, size, sha256, ref, created_at";

export interface FileServiceOptions {
  now?: () => Date;
}

const toMeta = (row: Record<string, unknown>): FileMeta => ({
  id: row.id as string,
  name: row.name as string,
  contentType: row.content_type as string,
  size: Number(row.size),
  sha256: row.sha256 as string,
  ref: (row.ref as string | null) ?? null,
  createdAt: (row.created_at as Date).toISOString(),
});

const keyOf = (moduleId: string, id: string): string => `${moduleId}/${id.slice(0, 2)}/${id}`;

function toIterable(data: FileData): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) return Readable.from([data], { objectMode: true });
  if (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) return Readable.fromWeb(data as never) as AsyncIterable<Uint8Array>;
  if (data !== null && typeof data === "object" && Symbol.asyncIterator in data) return data;
  throw new FileError("data must be bytes, a ReadableStream or an async iterable of bytes");
}

/** The platform side of the file API: stores bytes behind an adapter and keeps one row per file. */
export class FileService implements FilesService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    private readonly storage: FileStorage,
    options: FileServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Store a file for a module that declared `files`. The bytes are written to a temporary key while their size, SHA-256
   * and first bytes are taken, then moved to their key, and only then is the row written (in the caller's transaction
   * when `options.tx` is given). A failure at any step removes what was written; bytes whose row never commits are
   * left for `sweep`.
   */
  async put(moduleId: string, input: PutFileInput, options: PutFileOptions = {}): Promise<FileMeta> {
    const manifest = this.registry.get(moduleId);
    if (manifest === undefined) throw new FileError(`module "${moduleId}" is not registered`);
    const declaration = manifest.files;
    if (declaration === undefined) throw new FileError(`module "${moduleId}" does not declare files`);
    const db: Executor = (options.tx as Executor | undefined) ?? this.pool;
    const enabled = await db.query("select 1 from core.modules where id = $1 and state = 'enabled'", [moduleId]);
    if (enabled.rowCount === 0) throw new FileError(`module "${moduleId}" is not enabled`);

    if (typeof input.name !== "string") throw new FileError("the file name must be a string");
    if (input.ref !== undefined && (typeof input.ref !== "string" || input.ref.length < 1 || input.ref.length > MAX_FILE_REF_CHARS)) {
      throw new FileError(`the ref must be a string of 1 to ${MAX_FILE_REF_CHARS} characters`);
    }
    const source = toIterable(input.data);
    const limit = declaration.maxBytes ?? DEFAULT_FILE_MAX_BYTES;
    const hash = createHash("sha256");
    const head: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    async function* metered(): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new FileError("data must yield bytes");
        size += chunk.byteLength;
        if (size > limit) throw new FileError(`the file is over the limit of ${limit} bytes`);
        hash.update(chunk);
        if (headLength < SNIFF_BYTES) {
          const part = Buffer.from(chunk.subarray(0, SNIFF_BYTES - headLength));
          head.push(part);
          headLength += part.byteLength;
        }
        yield chunk;
      }
    }

    const temporary = `.tmp/${randomUUID()}`;
    await this.storage.write(temporary, metered());
    let key: string | undefined;
    try {
      if (size === 0) throw new FileError("the file is empty");
      const contentType = sniffContentType(Buffer.concat(head), size > SNIFF_BYTES);
      if (!acceptsType(declaration.accept, contentType)) throw new FileError(`module "${moduleId}" does not accept ${contentType} files`);
      const id = randomUUID();
      key = keyOf(moduleId, id);
      await this.storage.move(temporary, key);
      const name = safeFileName(input.name);
      const createdAt = this.now();
      const sha256 = hash.digest("hex");
      const ref = input.ref ?? null;
      await db.query("insert into core.files (id, module_id, name, content_type, size, sha256, ref, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [
        id, moduleId, name, contentType, size, sha256, ref, createdAt,
      ]);
      return { id, name, contentType, size, sha256, ref, createdAt: createdAt.toISOString() };
    } catch (error) {
      await this.storage.remove(temporary).catch(() => undefined);
      if (key !== undefined) await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
  }

  async stat(moduleId: string, id: string): Promise<FileMeta | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.pool.query(`select ${COLUMNS} from core.files where module_id = $1 and id = $2`, [moduleId, id]);
    return rows[0] === undefined ? null : toMeta(rows[0]);
  }

  /** The file and its bytes, or null when the module has no such file or its bytes are gone. */
  async get(moduleId: string, id: string): Promise<StoredFile | null> {
    const meta = await this.stat(moduleId, id);
    if (meta === null) return null;
    const stream = await this.storage.open(keyOf(moduleId, id));
    if (stream === null) return null;
    return { meta, stream: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array> };
  }

  async list(moduleId: string, options: ListFilesOptions = {}): Promise<FileMeta[]> {
    const asked = options.limit;
    const limit = Math.min(Math.max(typeof asked === "number" && Number.isFinite(asked) ? Math.trunc(asked) : DEFAULT_LIST, 1), MAX_LIST);
    const filterRef = options.ref !== undefined;
    const { rows } = await this.pool.query(
      `select ${COLUMNS} from core.files where module_id = $1 and ($2::boolean is false or ref = $3) order by created_at desc, id desc limit $4`,
      [moduleId, filterRef, options.ref ?? null, limit],
    );
    return rows.map(toMeta);
  }

  /** Deletes the module's own file: the row first, then the bytes (what remains of them is swept). */
  async remove(moduleId: string, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rowCount } = await this.pool.query("delete from core.files where module_id = $1 and id = $2", [moduleId, id]);
    if (rowCount === 0) return false;
    await this.storage.remove(keyOf(moduleId, id)).catch(() => undefined);
    return true;
  }

  /** Every byte a module has, rows aside; for an uninstall that purges. */
  async removeModuleBytes(moduleId: string): Promise<void> {
    if (!MODULE_ID.test(moduleId)) throw new FileError(`"${moduleId}" is not a module id`);
    await this.storage.removePrefix(moduleId);
  }

  /** Removes half-written uploads older than an hour and bytes older than a day that no row describes. */
  async sweep(): Promise<{ removed: number }> {
    const now = this.now().getTime();
    let removed = 0;
    let batch: { key: string; id: string }[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const found = await this.pool.query("select id from core.files where id = any($1::uuid[])", [batch.map((candidate) => candidate.id)]);
      const known = new Set(found.rows.map((row) => row.id as string));
      for (const candidate of batch) {
        if (known.has(candidate.id)) continue;
        await this.storage.remove(candidate.key);
        removed++;
      }
      batch = [];
    };
    for await (const entry of this.storage.list()) {
      const age = now - entry.modifiedAt.getTime();
      if (entry.key.startsWith(".tmp/")) {
        if (age > TEMP_AFTER_MS) {
          await this.storage.remove(entry.key);
          removed++;
        }
        continue;
      }
      if (age <= ORPHAN_AFTER_MS) continue;
      const parts = entry.key.split("/");
      const id = parts[2];
      // Only what this service wrote: <module>/<first two of the id>/<id>.
      if (parts.length !== 3 || id === undefined || !UUID.test(id) || parts[1] !== id.slice(0, 2)) continue;
      batch.push({ key: entry.key, id });
      if (batch.length >= SWEEP_BATCH) await flush();
    }
    await flush();
    return { removed };
  }
}
