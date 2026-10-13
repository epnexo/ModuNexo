/**
 * The platform's appearance, and the per-module overrides of it, as plain data and pure functions. Appearance
 * changes design tokens and nothing else: the only things that ever reach a stylesheet are a number between 0 and
 * 360 and one of three radius names, so there is no free CSS to inject.
 */

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const RADII = ["sharp", "default", "round"] as const;
export type Radius = (typeof RADII)[number];

export interface Appearance {
  theme: Theme;
  /** Hue of the accent color, in degrees of the OKLCH color wheel. */
  accentHue: number;
  radius: Radius;
}

/** What a module may override for its own pages. The theme is the visitor's, so it is not here. */
export interface ModuleAppearance {
  accentHue?: number;
  radius?: Radius;
}

export interface AppearanceState {
  platform: Appearance;
  modules: Record<string, ModuleAppearance>;
}

/** The shipped look: the hue the tokens file was tuned for. */
export const DEFAULT_APPEARANCE: Appearance = { theme: "system", accentHue: 258, radius: "default" };

export type AppearanceName = keyof Appearance;
export const APPEARANCE_NAMES: readonly AppearanceName[] = ["theme", "accentHue", "radius"];

export type AppearanceValidation = { ok: true; value: string | number } | { ok: false; message: string };

const DECIMAL = /^-?\d+(\.\d+)?$/;

export function validateAppearanceValue(name: string, input: unknown): AppearanceValidation {
  const refuse = (rule: string): AppearanceValidation => ({ ok: false, message: `appearance.${name}: ${rule}` });
  switch (name) {
    case "theme":
      return typeof input === "string" && (THEMES as readonly string[]).includes(input) ? { ok: true, value: input } : refuse(`must be one of: ${THEMES.join(", ")}`);
    case "radius":
      return typeof input === "string" && (RADII as readonly string[]).includes(input) ? { ok: true, value: input } : refuse(`must be one of: ${RADII.join(", ")}`);
    case "accentHue": {
      const value = typeof input === "number" ? input : typeof input === "string" && DECIMAL.test(input.trim()) ? Number(input.trim()) : Number.NaN;
      return Number.isFinite(value) && value >= 0 && value <= 360 ? { ok: true, value } : refuse("must be a number from 0 to 360");
    }
    default:
      return { ok: false, message: `unknown appearance setting "${name}"` };
  }
}

const PLATFORM_KEY = /^appearance\.(theme|accentHue|radius)$/;
// A module id is kebab-case (the manifest validator's rule), so the key can be split on its dots unambiguously.
const MODULE_KEY = /^appearance\.module\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.(accentHue|radius)$/;

/** The `core.platform_settings` key of a platform appearance value. */
export const platformKey = (name: AppearanceName): string => `appearance.${name}`;
/** The key of one module override, and the prefix of all of a module's. */
export const moduleKey = (moduleId: string, name: "accentHue" | "radius"): string => `appearance.module.${moduleId}.${name}`;
export const modulePrefix = (moduleId: string): string => `appearance.module.${moduleId}.`;

/** Builds the state from stored rows. A value that is no longer accepted falls back to the default. */
export function resolveAppearance(rows: readonly { key: string; value: unknown }[]): AppearanceState {
  const platform: Appearance = { ...DEFAULT_APPEARANCE };
  const modules: Record<string, ModuleAppearance> = {};
  for (const { key, value } of rows) {
    const mine = PLATFORM_KEY.exec(key);
    if (mine !== null) {
      const checked = validateAppearanceValue(mine[1]!, value);
      if (checked.ok) (platform as unknown as Record<string, string | number>)[mine[1]!] = checked.value;
      continue;
    }
    const theirs = MODULE_KEY.exec(key);
    if (theirs !== null) {
      const checked = validateAppearanceValue(theirs[2]!, value);
      if (!checked.ok) continue;
      const entry = (modules[theirs[1]!] ??= {});
      (entry as Record<string, string | number>)[theirs[2]!] = checked.value;
    }
  }
  return { platform, modules };
}

const RADIUS_REM: Record<Radius, string> = { sharp: "0.25rem", default: "0.625rem", round: "1rem" };

/** Hue as it is written into CSS: at most two decimals, never an exponent. */
const hue = (value: number): string => String(Number(value.toFixed(2)));

function accentLight(h: number): string {
  const n = hue(h);
  return `--accent:oklch(0.49 0.15 ${n});--accent-hover:oklch(0.43 0.15 ${n});--accent-soft:oklch(0.94 0.035 ${n});--accent-soft-foreground:oklch(0.36 0.14 ${n});--ring:oklch(0.49 0.15 ${n} / 0.55);`;
}

function accentDark(h: number): string {
  const n = hue(h);
  return `--accent:oklch(0.7 0.13 ${n});--accent-hover:oklch(0.76 0.12 ${n});--accent-soft:oklch(0.29 0.06 ${n});--accent-soft-foreground:oklch(0.86 0.08 ${n});--ring:oklch(0.7 0.13 ${n} / 0.6);`;
}

/**
 * The CSS that applies an appearance on top of `tokens.css`: the platform's values on the root, and each module's
 * overrides under `[data-module="<id>"]`, which the shell puts on the element that wraps that module's pages.
 */
export function appearanceCss(state: AppearanceState): string {
  const { platform, modules } = state;
  const rules = [
    `:root{--radius:${RADIUS_REM[platform.radius]};}`,
    `:root[data-theme="light"]{${accentLight(platform.accentHue)}}`,
    `:root[data-theme="dark"]{${accentDark(platform.accentHue)}}`,
  ];
  for (const id of Object.keys(modules).sort()) {
    const override = modules[id]!;
    const scope = `[data-module="${id}"]`;
    if (override.accentHue !== undefined) {
      rules.push(`:root[data-theme="light"] ${scope}{${accentLight(override.accentHue)}}`);
      rules.push(`:root[data-theme="dark"] ${scope}{${accentDark(override.accentHue)}}`);
    }
    if (override.radius !== undefined) rules.push(`${scope}{--radius:${RADIUS_REM[override.radius]};}`);
  }
  return rules.join("\n");
}

/**
 * The script that picks the theme before the first paint. A choice the visitor saved wins; otherwise the platform's
 * default theme applies, and `system` means the browser's preference. Blocked storage is not an error.
 */
export function themeInitScript(defaultTheme: Theme, storageKey: string): string {
  const fallback = defaultTheme === "system" ? 'matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"' : JSON.stringify(defaultTheme === "dark" ? "dark" : "light");
  const staticFallback = defaultTheme === "dark" ? '"dark"' : '"light"';
  return `try{var t=localStorage.getItem(${JSON.stringify(storageKey)});if(t!=="light"&&t!=="dark"){t=${fallback}}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme=${staticFallback}}`;
}
