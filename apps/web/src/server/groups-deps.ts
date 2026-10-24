import { GroupService } from "@modunexo/core/groups";
import type { GroupsDeps } from "./groups-api.ts";
import { platform } from "./platform.ts";
import { resolveViewer } from "./viewer.ts";

/** The real dependencies of the groups API: this process's database and the signed-in viewer. */
export function groupsDeps(): GroupsDeps {
  return { viewer: (headers) => resolveViewer(headers), service: new GroupService(platform().pool) };
}
