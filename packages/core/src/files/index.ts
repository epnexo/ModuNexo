import { filesDir, resolveDataDir } from "../packages/paths.ts";
import { DiskStorage } from "./storage.ts";

/** The adapter this process uses: a folder under the data directory (`MODUNEXO_DATA_DIR`, else `var/`). */
export const defaultFileStorage = (): DiskStorage => new DiskStorage(filesDir(resolveDataDir()));

export { FileError } from "./errors.ts";
export { MAX_FILE_NAME_CHARS, safeFileName } from "./name.ts";
export { FileService, MAX_FILE_REF_CHARS, ORPHAN_AFTER_MS, TEMP_AFTER_MS, type FileServiceOptions } from "./service.ts";
export { SNIFFED_TYPES, SNIFF_BYTES, acceptsType, sniffContentType } from "./sniff.ts";
export { DiskStorage, type FileStorage, type StoredObject } from "./storage.ts";
