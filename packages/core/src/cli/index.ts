// The platform CLI: `npm run modules -- list`, `npm run db:migrate`, `npm run registry:generate`.
export {};
// `mcp` serves the platform to an MCP client over stdio and is the one command that does not return an exit code.
if (process.argv[2] === "mcp") {
  const { serveMcp } = await import("../mcp/index.ts");
  await serveMcp();
} else {
  const { runCli } = await import("./run.ts");
  process.exitCode = await runCli(process.argv.slice(2));
}
