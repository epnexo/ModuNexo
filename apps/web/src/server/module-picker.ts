export interface PickerEntry {
  id: string;
  name: string;
}

/**
 * Which module the Modules tab of Settings shows. The address only asks (`?module=<id>`); the answer is always one of the
 * enabled modules, so a disabled, unknown or hostile id never reaches the settings service. With no valid request the
 * first module is shown; with no module enabled there is nothing to show.
 */
export function pickModule(enabled: readonly PickerEntry[], requested: string | string[] | undefined): string | null {
  if (enabled.length === 0) return null;
  const wanted = Array.isArray(requested) ? requested[0] : requested;
  return enabled.find((entry) => entry.id === wanted)?.id ?? enabled[0]!.id;
}
