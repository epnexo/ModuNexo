const MAX_NAME_CHARS = 80;

/**
 * The name an agent's actions are recorded under: its key's name, after `mcp:`. The prefix is what makes it safe to hand to the
 * CLI as an option value (a name that begins with a dash can never be read as another option), and what tells the register the
 * action came through an agent's channel. Anything that is not printable becomes `_`, and a long name is cut.
 */
export function mcpActor(name: string | undefined | null): string {
  const clean = (name ?? "").trim().replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "_").slice(0, MAX_NAME_CHARS);
  return `mcp:${clean === "" ? "unnamed" : clean}`;
}
