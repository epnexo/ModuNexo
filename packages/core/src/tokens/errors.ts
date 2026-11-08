/** Why a token request was refused: a bad value, a token that does not exist, or one that is already revoked. */
export type TokenErrorCode = "invalid" | "not-found" | "revoked";

/** A token request the platform refuses: an unknown module or token, a scope the module did not declare, a bad name. */
export class TokenError extends Error {
  constructor(
    message: string,
    readonly code: TokenErrorCode = "invalid",
  ) {
    super(message);
    this.name = "TokenError";
  }
}
