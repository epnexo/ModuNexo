import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_FILE_MAX_BYTES,
  FILES_SERVICE,
  FilesUnavailableError,
  type FilesService,
  MAX_FILE_BYTES_CEILING,
  ManifestError,
  deleteFile,
  getFile,
  listFiles,
  putFile,
  statFile,
  validateManifest,
} from "../src/index.ts";

const base = {
  id: "inbox",
  version: "1.0.0",
  name: "Inbox",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "inbox",
  migrationsDir: "migrations",
  nav: [],
};

const problemsOf = (input: unknown): string[] => {
  try {
    validateManifest(input);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};

describe("validateManifest: files", () => {
  const withFiles = (files: unknown, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, files });
  const permissions = { permissions: [{ key: "inbox.read", label: "Read" }] };

  it("accepts no files, an empty declaration and a full one", () => {
    assert.deepEqual(problemsOf(base), []);
    assert.deepEqual(problemsOf(withFiles({})), []);
    assert.deepEqual(
      problemsOf(withFiles({ maxBytes: 1024, accept: ["image/png", "application/pdf", "image/*"], permission: "inbox.read" }, permissions)),
      [],
    );
  });

  it("states the defaults and the ceiling", () => {
    assert.equal(DEFAULT_FILE_MAX_BYTES, 10 * 1024 * 1024);
    assert.equal(MAX_FILE_BYTES_CEILING, 50 * 1024 * 1024);
    assert.deepEqual(problemsOf(withFiles({ maxBytes: MAX_FILE_BYTES_CEILING })), []);
  });

  it("requires an object", () => {
    for (const files of ["yes", true, [], null, 1]) {
      assert.ok(problemsOf(withFiles(files)).some((p) => p.startsWith("files")), JSON.stringify(files));
    }
  });

  it("requires maxBytes to be a positive integer within the ceiling", () => {
    for (const maxBytes of [0, -1, 1.5, "10", MAX_FILE_BYTES_CEILING + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.ok(problemsOf(withFiles({ maxBytes })).some((p) => p.includes("files.maxBytes")), String(maxBytes));
    }
  });

  it("requires accept to be up to 20 distinct content types or families", () => {
    for (const accept of ["image/png", {}, [""], ["png"], ["image/"], ["/png"], ["Image/PNG"], ["image/png", "image/png"], [5], ["image/*/x"]]) {
      assert.ok(problemsOf(withFiles({ accept })).some((p) => p.includes("files.accept")), JSON.stringify(accept));
    }
    const many = Array.from({ length: 21 }, (_, i) => `application/x-t${i}`);
    assert.ok(problemsOf(withFiles({ accept: many })).some((p) => p.includes("files.accept") && p.includes("20")));
    assert.deepEqual(problemsOf(withFiles({ accept: many.slice(0, 20) })), []);
  });

  it("refuses a permission the module does not declare", () => {
    assert.ok(problemsOf(withFiles({ permission: "inbox.read" })).some((p) => p.includes("files.permission")));
    assert.ok(problemsOf(withFiles({ permission: 5 }, permissions)).some((p) => p.includes("files.permission")));
  });

  it("refuses unknown fields", () => {
    assert.ok(problemsOf(withFiles({ public: true })).some((p) => p.includes('unknown field "public"')));
  });
});

describe("file functions", () => {
  const slot = globalThis as typeof globalThis & { [FILES_SERVICE]?: FilesService };
  afterEach(() => {
    delete slot[FILES_SERVICE];
  });

  const meta = { id: "f1", name: "a.txt", contentType: "text/plain", size: 1, sha256: "x", ref: null, createdAt: "2026-10-21T00:00:00.000Z" };

  it("fail clearly where the platform registered no service", async () => {
    await assert.rejects(() => putFile("inbox", { name: "a", data: new Uint8Array([1]) }), FilesUnavailableError);
    await assert.rejects(() => getFile("inbox", "f1"), FilesUnavailableError);
    await assert.rejects(() => statFile("inbox", "f1"), FilesUnavailableError);
    await assert.rejects(() => listFiles("inbox"), FilesUnavailableError);
    await assert.rejects(() => deleteFile("inbox", "f1"), FilesUnavailableError);
  });

  it("hand the module, arguments and options to the registered service", async () => {
    const calls: unknown[][] = [];
    const record =
      <T>(name: string, value: T) =>
      async (...args: unknown[]): Promise<T> => {
        calls.push([name, ...args]);
        return value;
      };
    slot[FILES_SERVICE] = {
      put: record("put", meta),
      get: record("get", null),
      stat: record("stat", meta),
      list: record("list", [meta]),
      remove: record("remove", true),
    } as FilesService;
    const tx = { query: async () => ({ rows: [], rowCount: 0 }) };
    const data = new Uint8Array([1, 2]);
    assert.deepEqual(await putFile("inbox", { name: "a.txt", data, ref: "m:1" }, { tx }), meta);
    assert.deepEqual(await putFile("inbox", { name: "b.txt", data }), meta);
    assert.equal(await getFile("inbox", "f1"), null);
    assert.deepEqual(await statFile("inbox", "f1"), meta);
    assert.deepEqual(await listFiles("inbox", { ref: "m:1", limit: 5 }), [meta]);
    assert.deepEqual(await listFiles("inbox"), [meta]);
    assert.equal(await deleteFile("inbox", "f1"), true);
    assert.deepEqual(calls, [
      ["put", "inbox", { name: "a.txt", data, ref: "m:1" }, { tx }],
      ["put", "inbox", { name: "b.txt", data }, {}],
      ["get", "inbox", "f1"],
      ["stat", "inbox", "f1"],
      ["list", "inbox", { ref: "m:1", limit: 5 }],
      ["list", "inbox", {}],
      ["remove", "inbox", "f1"],
    ]);
  });
});
