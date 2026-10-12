// Schema names come from validated manifests, but nothing is ever interpolated into SQL unchecked:
// an identifier is either a plain lowercase name or it is refused. Escaping is not attempted.
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/** Double-quote a Postgres identifier. Throws for anything that is not a plain lowercase identifier. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name) || name.startsWith("pg_")) {
    throw new Error(`invalid SQL identifier ${JSON.stringify(name)}: expected lowercase letters, digits and underscores`);
  }
  return `"${name}"`;
}
