import { FileService, defaultFileStorage } from "@modunexo/core/files";
import { authorizeDownload, downloadHeaders } from "../../../../../server/file-download";
import { platform } from "../../../../../server/platform";
import { enabledModuleIds, webRegistry } from "../../../../../server/registry";
import { resolveViewer } from "../../../../../server/viewer";

export const dynamic = "force-dynamic";

const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/**
 * A file a module stored, to a signed-in viewer who holds the permission the module tied its files to. Always sent as a
 * download, with a type the platform decided from the bytes; a module that is unknown, stores no files or is disabled
 * answers like a file that does not exist.
 */
export async function GET(request: Request, context: { params: Promise<{ module: string; id: string }> }) {
  const viewer = await resolveViewer(request.headers);
  if (viewer === null) return refuse(401, "Sign-in required");
  const { module: moduleId, id } = await context.params;
  const registry = webRegistry();
  const { pool } = platform();
  const decision = authorizeDownload(registry.get(moduleId), (await enabledModuleIds(pool)).has(moduleId), viewer.subject);
  if (!decision.ok) return refuse(decision.status, decision.error);
  const file = await new FileService(pool, registry, defaultFileStorage()).get(moduleId, id);
  if (file === null) return refuse(404, "file not found");
  return new Response(file.stream, { headers: downloadHeaders(file.meta) });
}
