import { SNIFFED_TYPES } from "@modunexo/core/files";
import type { FileMeta, ModuleManifest } from "@modunexo/sdk";
import { type Subject, subjectCan } from "./nav.ts";

export type DownloadDecision = { ok: true } | { ok: false; status: 403 | 404; error: string };

const NOT_FOUND = { ok: false, status: 404, error: "file not found" } as const;

/**
 * Whether a viewer may download the files of a module. A module that is unknown, stores no files or is not enabled looks
 * exactly like a file that is missing. A module that tied its files to no permission shows them to no browser at all.
 */
export function authorizeDownload(manifest: ModuleManifest | undefined, enabled: boolean, subject: Subject): DownloadDecision {
  if (manifest?.files === undefined || !enabled) return NOT_FOUND;
  const permission = manifest.files.permission;
  if (permission === undefined || !subjectCan(subject, permission)) {
    return { ok: false, status: 403, error: "you do not have permission to download these files" };
  }
  return { ok: true };
}

/** `attachment` with the name twice: a plain ASCII form for old clients and the RFC 5987 form for the rest. */
export function contentDisposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\\;%]/gu, "_");
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain === "" ? "file" : plain}"; filename*=UTF-8''${encoded === "" ? "file" : encoded}`;
}

/**
 * The headers of a download: always an attachment, with a type from the platform's own list (anything else is a stream of
 * bytes), forbidden from being sniffed into something else, and unable to run anything if opened directly.
 */
export function downloadHeaders(meta: FileMeta): Record<string, string> {
  return {
    "content-type": SNIFFED_TYPES.includes(meta.contentType) ? meta.contentType : "application/octet-stream",
    "content-length": String(meta.size),
    "content-disposition": contentDisposition(meta.name),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  };
}
