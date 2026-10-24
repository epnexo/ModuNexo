import { GroupService } from "@modunexo/core/groups";
import type { GroupLayout } from "./nav.ts";
import { platform } from "./platform.ts";

/** The managed groups, or none when the database cannot be asked: the menu must still render, with the manifests' own groups. */
export async function loadGroupLayout(): Promise<GroupLayout> {
  try {
    return await new GroupService(platform().pool).overview();
  } catch {
    return { groups: [], assignments: {} };
  }
}
