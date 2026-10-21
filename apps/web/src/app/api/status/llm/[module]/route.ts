import { LlmService } from "@modunexo/core/llm";
import { log } from "@modunexo/core/log";
import { platform } from "../../../../../server/platform";
import { enabledModuleIds, webRegistry } from "../../../../../server/registry";
import { authorizeWrite, json } from "../../../../../server/settings-api";
import { runProbe } from "../../../../../server/status";

export const dynamic = "force-dynamic";

/**
 * Tests a module's model connection: asks the provider its settings name for its models. Administrators only, from this site
 * only. It reads at the provider and changes nothing here. The key is decrypted by the platform and never comes back.
 */
export async function POST(request: Request, context: { params: Promise<{ module: string }> }) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const { module: moduleId } = await context.params;
  const { pool } = platform();
  const registry = webRegistry();
  const reply = await runProbe(
    { service: new LlmService(pool, registry), manifests: registry.all(), enabled: await enabledModuleIds(pool), onUnexpected: (error) => log.error("status.probe_failed", { moduleId, error }) },
    moduleId,
  );
  return json(reply.body, reply.status);
}
