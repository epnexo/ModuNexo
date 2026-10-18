import { log } from "@epnexo/core/log";
import { checkHealth } from "../../../server/health";
import { platform } from "../../../server/platform";

export const dynamic = "force-dynamic";

/** Readiness probe for a load balancer or an orchestrator: 200 when the database answers, 503 when it does not. */
export async function GET() {
  const reply = await checkHealth(() => platform().pool.query("select 1"), { onFailure: (error) => log.error("health.degraded", { error }) });
  return Response.json(reply.body, { status: reply.status, headers: { "cache-control": "no-store" } });
}
