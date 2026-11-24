import { ActionService } from "@modunexo/core/actions";
import { moduleRolesFor } from "@modunexo/core/data";
import type { ActionsDeps } from "./actions-api.ts";
import { subjectCan } from "./nav.ts";
import { platform } from "./platform.ts";
import { webRegistry } from "./registry.ts";
import { resolveViewer } from "./viewer.ts";

/** The service on this process's database, with the module logins a read action's statement runs on. */
export function actionService(): ActionService {
  const { pool } = platform();
  return new ActionService(pool, webRegistry(), { moduleRoles: moduleRolesFor(pool) });
}

/** The real platform behind the actions API: the signed-in person and what they hold, and the service. */
export function actionsDeps(): ActionsDeps {
  return {
    viewer: async (headers) => {
      const viewer = await resolveViewer(headers);
      return viewer === null ? null : { actor: viewer.actor, can: (permission) => subjectCan(viewer.subject, permission) };
    },
    service: actionService(),
  };
}
