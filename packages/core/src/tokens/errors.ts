/** A token request the platform refuses: an unknown module or token, a scope the module did not declare, a bad name. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}
