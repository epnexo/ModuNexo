import type pg from "pg";
import { LlmService } from "../llm/index.ts";
import type { Registry } from "../registry.ts";
import type { CliOutput } from "./jobs.ts";

export interface LlmCommand {
  action: "probe";
  /** The module id. */
  args: string[];
  json: boolean;
}

/** `llm probe <module>`: asks the provider the module's settings name for its models. The key is never printed. */
export async function runLlmCommand(command: LlmCommand, deps: { pool: pg.Pool; registry: Registry; io: CliOutput }): Promise<void> {
  const { pool, registry, io } = deps;
  const result = await new LlmService(pool, registry).probe(command.args[0]!);
  if (command.json) {
    io.out(JSON.stringify(result, null, 2));
    return;
  }
  io.out(`reached ${result.endpoint} in ${result.latencyMs} ms`);
  io.out(`models (${result.models.length}): ${result.models.length === 0 ? "none" : result.models.join(", ")}`);
  io.out(result.model === null ? "model: not set" : result.modelAvailable === true ? `model "${result.model}": available` : `model "${result.model}": not listed by the provider`);
}
