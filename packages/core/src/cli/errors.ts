/** The command line was malformed: exit code 2. */
export class UsageError extends Error {}

/** The action was understood and refused by a rule; nothing was changed: exit code 3. */
export class Refusal extends Error {}
