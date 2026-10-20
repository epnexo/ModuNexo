/** A file the platform refuses to store or a storage key it refuses to touch: an unknown module, a module that declared no files, an empty or oversized body, a type the module does not take. */
export class FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileError";
  }
}
