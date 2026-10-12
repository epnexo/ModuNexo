// The platform CLI: `npm run modules -- list`, `npm run db:migrate`, `npm run registry:generate`.
import { runCli } from "./run.ts";

process.exitCode = await runCli(process.argv.slice(2));
