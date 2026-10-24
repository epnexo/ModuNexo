import { GroupService } from "@modunexo/core/groups";
import type { GroupLayout } from "./nav.ts";
import { platform } from "./platform.ts";

/** The managed groups, or none when the database cannot be asked: the menu must still render, with the manifests' own groups. */
export async function loadGroupLayout(): Promise<GroupLayout> {
  try {
    return await new GroupService(platform().pool).overview();
  } catch (error) {
    // Before the migration that creates the tables has run there is nothing to read; any other failure is worth a line in the log.
    if ((error as { code?: string }).code !== "42P01") console.error("menu groups could not be read; showing the manifests' groups:", error instanceof Error ? error.message : error);
    return { groups: [], assignments: {} };
  }
}
