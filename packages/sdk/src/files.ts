import type { DbQueryable } from "./db.ts";

/**
 * How a module's code keeps files. The bytes never touch the module's own disk code: the platform stores them behind an
 * adapter (a folder on disk today) and the module keeps the id. Like jobs and events, the service is reached through a
 * global symbol that the platform registers (the web app and the worker do), so the SDK stays free of storage code and
 * every copy of it finds the same service.
 */
export const FILES_SERVICE: unique symbol = Symbol.for("modunexo.files.service") as never;

/** What the platform knows about a stored file. `contentType` was decided from the bytes, never from the name. */
export interface FileMeta {
  id: string;
  /** The display name, reduced to a safe single path segment. */
  name: string;
  contentType: string;
  size: number;
  /** Lowercase hex SHA-256 of the bytes. */
  sha256: string;
  /** What the module said this file belongs to, for example `message:42`; null when it said nothing. */
  ref: string | null;
  createdAt: string;
}

/** Bytes in memory, a web stream (for example `request.body`) or any async iterable of chunks. */
export type FileData = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface PutFileInput {
  /** Shown to people and sent as the download's file name. Path separators and control characters are dropped. */
  name: string;
  data: FileData;
  /** At most 200 characters. Lets the module find "the files of message 42" with `listFiles`. */
  ref?: string;
}

export interface PutFileOptions {
  /**
   * The handle `getDb(moduleId).transaction` gives. With it the row is written in that transaction, so the file exists
   * exactly when the caller's data does. The bytes are written before the transaction ends; the platform removes bytes
   * that never got a row.
   */
  tx?: DbQueryable;
}

export interface ListFilesOptions {
  ref?: string;
  /** Default 100, at most 500. Newest first. */
  limit?: number;
}

export interface StoredFile {
  meta: FileMeta;
  stream: ReadableStream<Uint8Array>;
}

export interface FilesService {
  put(moduleId: string, input: PutFileInput, options: PutFileOptions): Promise<FileMeta>;
  get(moduleId: string, id: string): Promise<StoredFile | null>;
  stat(moduleId: string, id: string): Promise<FileMeta | null>;
  list(moduleId: string, options: ListFilesOptions): Promise<FileMeta[]>;
  remove(moduleId: string, id: string): Promise<boolean>;
}

/** A file function ran where the platform has not registered the service: a script, a test, a build step. */
export class FilesUnavailableError extends Error {
  constructor() {
    super("files can only be used while the platform is running: no files service is registered in this process");
    this.name = "FilesUnavailableError";
  }
}

function service(): FilesService {
  const found = (globalThis as typeof globalThis & { [FILES_SERVICE]?: FilesService })[FILES_SERVICE];
  if (found === undefined) throw new FilesUnavailableError();
  return found;
}

/**
 * Store a file for a module that declared `files` in its manifest. The module must be enabled. Rejects with the
 * platform's reason when the body is empty, over the module's limit or of a type the module does not accept.
 */
export async function putFile(moduleId: string, input: PutFileInput, options: PutFileOptions = {}): Promise<FileMeta> {
  return service().put(moduleId, input, options);
}

/** The file's metadata and a stream of its bytes, or null when the module has no such file. */
export async function getFile(moduleId: string, id: string): Promise<StoredFile | null> {
  return service().get(moduleId, id);
}

/** The file's metadata, or null when the module has no such file. */
export async function statFile(moduleId: string, id: string): Promise<FileMeta | null> {
  return service().stat(moduleId, id);
}

/** The module's files, newest first. */
export async function listFiles(moduleId: string, options: ListFilesOptions = {}): Promise<FileMeta[]> {
  return service().list(moduleId, options);
}

/** Delete a file of the module. Resolves to false when the module has no such file. */
export async function deleteFile(moduleId: string, id: string): Promise<boolean> {
  return service().remove(moduleId, id);
}
