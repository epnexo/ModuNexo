/**
 * The platform's appearance, and the per-module overrides of it, as plain data and pure functions. Appearance
 * changes design tokens and nothing else: the only things that ever reach a stylesheet are a number between 0 and
 * 360 and one of a few fixed names (radius, density, motion), so there is no free CSS to inject.
 */

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const RADII = ["sharp", "default", "round"] as const;
export type Radius = (typeof RADII)[number];

export const DENSITIES = ["compact", "default", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

export const MOTIONS = ["full", "reduced"] as const;
export type Motion = (typeof MOTIONS)[number];

export interface Appearance {
  theme: Theme;
  /** Hue of the accent color, in degrees of the OKLCH color wheel. */
  accentHue: number;
  radius: Radius;
  /** How much room pages and cards take: the three spacing tokens modules read. */
  density: Density;
  /** `reduced` makes every transition and entrance instant. `full` never overrides a visitor who asked for less motion. */
  motion: Motion;
}

/** What a module may override for its own pages. The theme is the visitor's, so it is not here. */
export interface ModuleAppearance {
  accentHue?: number;
  radius?: Radius;
  density?: Density;
  motion?: Motion;
}

export interface AppearanceState {
  platform: Appearance;
  modules: Record<string, ModuleAppearance>;
}

/** The shipped look: the hue the tokens file was tuned for (petrol). `tokens.css` carries the same values, and a test keeps the two equal. */
export const DEFAULT_APPEARANCE: Appearance = { theme: "system", accentHue: 220, radius: "default", density: "default", motion: "full" };

export type AppearanceName = keyof Appearance;
export const APPEARANCE_NAMES: readonly AppearanceName[] = ["theme", "accentHue", "radius", "density", "motion"];
/** What a module may override: every appearance setting except the theme. */
export const MODULE_APPEARANCE_NAMES = ["accentHue", "radius", "density", "motion"] as const;
export type ModuleAppearanceName = (typeof MODULE_APPEARANCE_NAMES)[number];

export type AppearanceValidation = { ok: true; value: string | number } | { ok: false; message: string };

const DECIMAL = /^-?\d+(\.\d+)?$/;

export function validateAppearanceValue(name: string, input: unknown): AppearanceValidation {
  const refuse = (rule: string): AppearanceValidation => ({ ok: false, message: `appearance.${name}: ${rule}` });
  switch (name) {
    case "theme":
      return typeof input === "string" && (THEMES as readonly string[]).includes(input) ? { ok: true, value: input } : refuse(`must be one of: ${THEMES.join(", ")}`);
    case "radius":
      return typeof input === "string" && (RADII as readonly string[]).includes(input) ? { ok: true, value: input } : refuse(`must be one of: ${RADII.join(", ")}`);
    case "density":
      return typeof input === "string" && (DENSITIES as readonly string[]).includes(input) ? { ok: true, value: input } : refuse(`must be one of: ${DENSITIES.join(", ")}`);
    case "motion":
      return typeof input === "string" && (MOTIONS as readonly string[]).includes(input) ? { ok: true, value: input } : refuse(`must be one of: ${MOTIONS.join(", ")}`);
    case "accentHue": {
      const value = typeof input === "number" ? input : typeof input === "string" && DECIMAL.test(input.trim()) ? Number(input.trim()) : Number.NaN;
      return Number.isFinite(value) && value >= 0 && value <= 360 ? { ok: true, value } : refuse("must be a number from 0 to 360");
    }
    default:
      return { ok: false, message: `unknown appearance setting "${name}"` };
  }
}

const PLATFORM_KEY = /^appearance\.(theme|accentHue|radius|density|motion)$/;
// A module id is kebab-case (the manifest validator's rule), so the key can be split on its dots unambiguously.
const MODULE_KEY = /^appearance\.module\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.(accentHue|radius|density|motion)$/;

/** The `core.platform_settings` key of a platform appearance value. */
export const platformKey = (name: AppearanceName): string => `appearance.${name}`;
/** The key of one module override, and the prefix of all of a module's. */
export const moduleKey = (moduleId: string, name: ModuleAppearanceName): string => `appearance.module.${moduleId}.${name}`;
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

/** The spacing tokens of each density. `default` is what `tokens.css` ships, and a test keeps the two equal. */
export const DENSITY_REM: Record<Density, { layoutGap: string; cardPad: string; cardGap: string }> = {
  compact: { layoutGap: "1.25rem", cardPad: "0.875rem", cardGap: "0.5rem" },
  default: { layoutGap: "1.75rem", cardPad: "1.125rem", cardGap: "0.75rem" },
  comfortable: { layoutGap: "2.25rem", cardPad: "1.375rem", cardGap: "1rem" },
};
const densityTokens = (density: Density): string => {
  const { layoutGap, cardPad, cardGap } = DENSITY_REM[density];
  return `--layout-gap:${layoutGap};--card-pad:${cardPad};--card-gap:${cardGap};`;
};

/** The duration tokens of each motion, as `tokens.css` ships them (`full`) or with everything instant (`reduced`). */
const MOTION_TOKENS: Record<Motion, string> = {
  full: "--duration-fast:120ms;--duration:180ms;--duration-slow:260ms;--stagger:60ms;",
  reduced: "--duration-fast:1ms;--duration:1ms;--duration-slow:1ms;--stagger:0ms;",
};
/** `reduced` always applies; `full` only where the visitor did not ask the system for less motion, which always wins. */
const motionRule = (selector: string, motion: Motion): string =>
  motion === "reduced" ? `${selector}{${MOTION_TOKENS.reduced}}` : `@media (prefers-reduced-motion: no-preference){${selector}{${MOTION_TOKENS.full}}}`;

/** Hue as it is written into CSS: at most two decimals, never an exponent. */
const hue = (value: number): string => String(Number(value.toFixed(2)));

function accentLight(h: number): string {
  const n = hue(h);
  return `--accent:oklch(0.45 0.075 ${n});--accent-hover:oklch(0.39 0.075 ${n});--accent-soft:oklch(0.93 0.02 ${n});--accent-soft-foreground:oklch(0.34 0.07 ${n});--ring:oklch(0.45 0.075 ${n} / 0.55);`;
}

function accentDark(h: number): string {
  const n = hue(h);
  return `--accent:oklch(0.826 0.07 ${n});--accent-hover:oklch(0.88 0.065 ${n});--accent-soft:oklch(0.312 0.03 ${n});--accent-soft-foreground:oklch(0.88 0.06 ${n});--ring:oklch(0.826 0.07 ${n} / 0.6);`;
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
  // Written only when it is not the shipped value, so the defaults leave tokens.css untouched.
  if (platform.density !== "default") rules.push(`:root{${densityTokens(platform.density)}}`);
  if (platform.motion === "reduced") rules.push(motionRule(":root", "reduced"), ".page-enter{animation:none}");
  for (const id of Object.keys(modules).sort()) {
    const override = modules[id]!;
    const scope = `[data-module="${id}"]`;
    if (override.accentHue !== undefined) {
      rules.push(`:root[data-theme="light"] ${scope}{${accentLight(override.accentHue)}}`);
      rules.push(`:root[data-theme="dark"] ${scope}{${accentDark(override.accentHue)}}`);
    }
    if (override.radius !== undefined) rules.push(`${scope}{--radius:${RADIUS_REM[override.radius]};}`);
    if (override.density !== undefined) rules.push(`${scope}{${densityTokens(override.density)}}`);
    if (override.motion !== undefined) rules.push(motionRule(scope, override.motion));
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
