/** How many leading bytes decide a file's type. */
export const SNIFF_BYTES = 8192;

const startsWith = (head: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((byte, i) => head[at + i] === byte);
const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/** Anything below 0x20 except tab, line feed and carriage return, and DEL. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isText(head: Uint8Array, truncated: boolean): boolean {
  if (head.length === 0) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // A head cut in the middle of a character ends in up to three bytes of it.
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      return !CONTROL.test(decoder.decode(head.subarray(0, head.length - cut)));
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * The content type of a file from its first bytes. Only a few formats are recognised; readable UTF-8 text is
 * `text/plain` whatever it looks like (HTML and SVG included, so nothing a browser would run is ever announced), and
 * everything else is `application/octet-stream`. `truncated` says there are more bytes than `head` holds.
 */
export function sniffContentType(head: Uint8Array, truncated: boolean): string {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "image/gif";
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(head, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return "application/zip";
  if (startsWith(head, [0x1f, 0x8b])) return "application/gzip";
  if (isText(head, truncated)) return "text/plain";
  return "application/octet-stream";
}

/** Whether a module's `accept` list takes `type`. No list takes everything; an empty one takes nothing. */
export function acceptsType(accept: readonly string[] | undefined, type: string): boolean {
  if (accept === undefined) return true;
  return accept.some((entry) => entry === type || (entry.endsWith("/*") && type.startsWith(entry.slice(0, -1))));
}
