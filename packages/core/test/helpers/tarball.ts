import { gzipSync } from "node:zlib";

/** One entry of a hand-made tarball. Anything the real `tar` would refuse to write can be written here. */
export interface TarEntry {
  name: string;
  /** "0" file, "5" directory, "2" symbolic link, "1" hard link, "3" character device, "6" FIFO. Default "0". */
  type?: string;
  data?: string | Buffer;
  linkname?: string;
  mode?: number;
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  const put = (text: string, offset: number, length: number) => block.write(text.slice(0, length), offset, "latin1");
  put(entry.name, 0, 100);
  put((entry.mode ?? 0o644).toString(8).padStart(7, "0"), 100, 8);
  put("0000000", 108, 8);
  put("0000000", 116, 8);
  put(size.toString(8).padStart(11, "0"), 124, 12);
  put("00000000000", 136, 12);
  block.fill(0x20, 148, 156);
  put(entry.type ?? "0", 156, 1);
  put(entry.linkname ?? "", 157, 100);
  put("ustar", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/** The bytes of an uncompressed tar archive. */
export function tarBytes(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.name.length > 100) {
      // The GNU way to store a long name: a "././@LongLink" entry that holds it, then the real one.
      const longName = Buffer.from(`${entry.name}\0`, "latin1");
      parts.push(header({ name: "././@LongLink", type: "L" }, longName.length));
      parts.push(longName);
      parts.push(Buffer.alloc((512 - (longName.length % 512)) % 512));
    }
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    const isFile = (entry.type ?? "0") === "0";
    parts.push(header(entry, isFile ? data.length : 0));
    if (isFile && data.length > 0) {
      parts.push(data);
      parts.push(Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A gzipped tarball, like the ones `npm pack` makes. */
export function tgz(entries: TarEntry[]): Buffer {
  return gzipSync(tarBytes(entries));
}
