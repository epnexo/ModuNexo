import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileMeta, ModuleManifest } from "@modunexo/sdk";
import { authorizeDownload, contentDisposition, downloadHeaders } from "../src/server/file-download.ts";

const manifest = (files: ModuleManifest["files"]): ModuleManifest =>
  ({ id: "inbox", version: "1.0.0", name: "inbox", platform: "^0.1.0", dependsOn: {}, schema: "inbox", migrationsDir: "m", nav: [], ...(files === undefined ? {} : { files }) }) as ModuleManifest;

const operator = { kind: "operator" } as const;
const admin = { kind: "user", role: "admin" } as const;
const viewer = { kind: "user", role: "viewer" } as const;

const meta = (extra: Partial<FileMeta> = {}): FileMeta => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "report.pdf",
  contentType: "application/pdf",
  size: 1234,
  sha256: "a".repeat(64),
  ref: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  ...extra,
});

describe("contentDisposition", () => {
  it("is an attachment with the name twice: plain for old clients, encoded for the rest", () => {
    assert.equal(contentDisposition("report.pdf"), `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    assert.equal(contentDisposition("Año nuevo.txt"), `attachment; filename="A_o nuevo.txt"; filename*=UTF-8''A%C3%B1o%20nuevo.txt`);
  });

  it("cannot be bent by a name that carries quotes, separators or line breaks", () => {
    for (const name of ['a"b.txt', "a\\b.txt", "a;b.txt", "a\r\nSet-Cookie: x=1", "a\nb", "it's (a) *file*!.txt", "‮gnp.exe", "%2e%2e"]) {
      const header = contentDisposition(name);
      assert.match(header, /^attachment; filename="[^"\\\r\n;]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]*$/, JSON.stringify(name));
    }
  });

  it("falls back to a name when there is none to use", () => {
    assert.equal(contentDisposition(""), `attachment; filename="file"; filename*=UTF-8''file`);
  });
});

describe("downloadHeaders", () => {
  it("sends the stored type, the size and the protections that keep a download from running", () => {
    const headers = downloadHeaders(meta());
    assert.equal(headers["content-type"], "application/pdf");
    assert.equal(headers["content-length"], "1234");
    assert.match(headers["content-disposition"]!, /^attachment; /);
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(headers["cache-control"], "private, no-store");
  });

  it("never announces a type the platform does not sniff, whatever the row says", () => {
    for (const contentType of ["text/html", "image/svg+xml", "application/javascript", "TEXT/PLAIN", "x", ""]) {
      assert.equal(downloadHeaders(meta({ contentType }))["content-type"], "application/octet-stream", contentType);
    }
    for (const contentType of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/zip", "application/gzip", "text/plain", "application/octet-stream"]) {
      assert.equal(downloadHeaders(meta({ contentType }))["content-type"], contentType);
    }
  });
});

describe("authorizeDownload", () => {
  const gated = manifest({ permission: "inbox.read" });

  it("lets a viewer who holds the module's permission download", () => {
    assert.deepEqual(authorizeDownload(gated, true, operator), { ok: true });
    assert.deepEqual(authorizeDownload(gated, true, admin), { ok: true });
  });

  it("refuses with 403 a viewer who does not hold it, before anything about the file is looked up", () => {
    const refused = authorizeDownload(gated, true, viewer);
    assert.deepEqual(refused, { ok: false, status: 403, error: "you do not have permission to download these files" });
  });

  it("refuses with 403 everyone when the module tied its files to no permission", () => {
    for (const subject of [operator, admin, viewer]) {
      assert.deepEqual(authorizeDownload(manifest({}), true, subject), { ok: false, status: 403, error: "you do not have permission to download these files" });
    }
  });

  it("answers 404, the same as for a missing file, for a module that is unknown, stores no files or is not enabled", () => {
    const missing = { ok: false, status: 404, error: "file not found" };
    assert.deepEqual(authorizeDownload(undefined, true, operator), missing);
    assert.deepEqual(authorizeDownload(manifest(undefined), true, operator), missing);
    assert.deepEqual(authorizeDownload(gated, false, operator), missing);
    assert.deepEqual(authorizeDownload(gated, false, viewer), missing);
  });
});
