import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { AdminRefusedError } from "../auth/admin.ts";

/** One line from a terminal without echoing it. The label goes to stderr so stdout stays machine-readable. */
function promptHidden(label: string): Promise<string> {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(label);
  return new Promise((resolve) => {
    reader.question("", (answer) => {
      reader.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const end = text.indexOf("\n");
  return (end === -1 ? text : text.slice(0, end)).replace(/\r$/, "");
}

/**
 * The new password, from standard input. On a terminal it is asked twice, hidden, and the two must match. When
 * standard input is a pipe or a file the first line is the password; only its line ending is dropped, because
 * spaces are legitimate password characters.
 */
export async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readFirstLine(process.stdin);
  const password = await promptHidden("Password: ");
  const repeated = await promptHidden("Repeat password: ");
  if (password !== repeated) throw new AdminRefusedError("the two passwords do not match");
  return password;
}
