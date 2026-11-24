/**
 * The CSS a company writes for itself, made safe. Nothing the administrator typed is ever served: the text is parsed, every
 * rule, selector, property and value is checked against closed lists, and what is served is written again from the parts that
 * passed, inside the `custom` cascade layer (after the platform's and the modules'). A stylesheet with anything refused is not
 * stored at all, and every refusal says the line it is on.
 *
 * What it can do: set the platform's own tokens, and restyle a module's pages or the platform's documented classes with a short
 * list of properties inside bounds that cannot hide or break a page. What it cannot do: load anything (`url()`, `@import`,
 * `@font-face`), run anything, move or hide an element, reach a guard element (`data-guard`: the sign-in, the permission and the
 * alert messages), or use `!important`.
 */
import postcss, { type AtRule, type ChildNode, type Declaration, type Root, type Rule } from "postcss";

export const MAX_CUSTOM_CSS_BYTES = 16 * 1024;
const MAX_RULES = 300;

/** The platform's tokens a stylesheet may set or read. The layout's structural sizes and the fonts are left out on purpose. */
export const CUSTOM_CSS_TOKENS = [
  "--accent", "--accent-foreground", "--accent-hover", "--accent-soft", "--accent-soft-foreground",
  "--background", "--border", "--border-strong", "--card-gap", "--card-line-opacity", "--card-pad", "--card-radius",
  "--chart-base", "--chart-top", "--danger", "--danger-soft", "--danger-soft-foreground",
  "--duration", "--duration-fast", "--duration-slow", "--ease-out", "--foreground", "--layout-gap", "--muted-foreground",
  "--panel", "--panel-hover", "--radius", "--ring", "--shadow-raised", "--stagger",
  "--success", "--success-soft", "--surface", "--tile-size", "--warning", "--warning-soft",
] as const;
const TOKENS: ReadonlySet<string> = new Set(CUSTOM_CSS_TOKENS);

/** The platform's documented classes: the ones `docs/GUIDE.md` tells a module to use. */
const CORE_CLASSES: ReadonlySet<string> = new Set([
  "card", "card-link", "icon-tile", "chip", "empty", "section-title", "rise", "seg",
  "badge", "badge-info", "badge-success", "badge-warning", "badge-danger",
  "btn", "btn-primary", "btn-sm", "input", "field", "field-label", "form", "detail-list", "data-table",
  "stats", "stat", "stat-label", "stat-value", "stat-sub",
  "notice", "notice-info", "notice-success", "notice-warning", "notice-error",
]);

const PSEUDO_CLASSES = "hover|focus|focus-visible|focus-within|active|disabled|first-child|last-child";
// A tag can only open a compound and every other piece starts with its own character (`.`, `[` or `:`), so there is exactly one way to
// split a selector into pieces and the match is linear. A pattern that let a run of letters be split in many ways would backtrack
// exponentially, and this runs on every page read.
const PIECE = String.raw`(?:\.[a-z][a-z0-9_-]*|\[data-[a-z][a-z0-9-]*(?:="[a-zA-Z0-9_-]*")?\]|:(?:${PSEUDO_CLASSES})|::(?:before|after))`;
const COMPOUND = new RegExp(`^(?=.)(?:[a-z][a-z0-9]*)?${PIECE}*$`);
const ROOT_SELECTOR = /^:root(?:\[data-theme="(?:light|dark)"\])?$/;
const MODULE_SCOPE = /^\[data-module="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"\]$/;

const MEDIA_CONDITION = String.raw`\(\s*(?:(?:min|max)-(?:width|height)\s*:\s*[0-9.]+(?:rem|em|px)|prefers-color-scheme\s*:\s*(?:light|dark)|prefers-reduced-motion\s*:\s*(?:reduce|no-preference))\s*\)`;
const MEDIA = new RegExp(`^${MEDIA_CONDITION}(?:\\s+and\\s+${MEDIA_CONDITION})*$`);

const FUNCTIONS: ReadonlySet<string> = new Set(["calc", "clamp", "min", "max", "var", "oklch", "oklab", "rgb", "rgba", "hsl", "hsla", "color-mix", "cubic-bezier"]);
const VALUE_ALPHABET = /^[a-zA-Z0-9\s.,%#()/+\-*]+$/;
const FORBIDDEN_WORDS = /\b(?:url|image-set|expression|javascript|attr|env|src|paint|element|cross-fade|-webkit-image-set)\b/i;

export type CustomCssError = { line: number; message: string };
/** Where a stylesheet lands in the cascade: the company's, then the person's, which is last and so wins. */
export type CustomCssLayer = "custom" | "person";
export type CustomCssResult = { ok: true; css: string } | { ok: false; errors: CustomCssError[] };

type Check = (value: string) => string | null;

const NUMBER = /(-?\d*\.?\d+)([a-z%]*)/gi;

/** The value with its `var(--token)` and function names taken out, so only numbers, units and words are left to check. */
function stripped(value: string): string {
  return value
    .replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, " ")
    .replace(/(?:oklch|oklab|rgba?|hsla?|color-mix)\([^)]*\)/gi, " ")
    .replace(/#[0-9a-f]{3,8}\b/gi, " ")
    .replace(/[a-z][a-z-]*\(/gi, "(");
}

/** Every number of a value with its unit, or an error naming the first one that is not allowed. */
function numbers(value: string): { n: number; unit: string }[] {
  return [...stripped(value).matchAll(NUMBER)].map((match) => ({ n: Number(match[1]), unit: (match[2] ?? "").toLowerCase() }));
}

const wordsLeft = (value: string, allowed: readonly string[]): string | undefined => {
  const words = stripped(value).replace(NUMBER, " ").match(/[a-z][a-z-]*/gi) ?? [];
  return words.find((word) => !allowed.includes(word.toLowerCase()));
};

type Range = readonly [number, number];
interface Ranges {
  rem: Range;
  px: Range;
  pct?: Range;
  /** A number with no unit (a multiplier, a line height, the 0 of a shadow). Absent: not allowed. */
  none?: Range;
}

/** A length (rem, em, px, %) with the range each unit may take. */
function bounded(prop: string, rule: string, ranges: Ranges, words: readonly string[] = []): Check {
  const message = (value: string) => `${prop}: "${value}" must be between ${rule}`;
  return (value) => {
    if (wordsLeft(value, words) !== undefined) return message(value);
    for (const { n, unit } of numbers(value)) {
      const range = unit === "rem" || unit === "em" ? ranges.rem : unit === "px" ? ranges.px : unit === "%" ? ranges.pct : unit === "" ? ranges.none : undefined;
      if (range === undefined || n < range[0] || n > range[1]) return message(value);
    }
    return null;
  };
}

const spacing = (prop: string): Check => bounded(prop, "0 and 6rem (96px)", { rem: [0, 6], px: [0, 96], pct: [0, 100], none: [0, 6] });
const color = (prop: string): Check => (value) => (/\b(?:transparent|inherit|initial|unset|revert)\b/i.test(value) ? `${prop}: transparent is not allowed` : null);

const duration = (prop: string): Check => (value) => {
  for (const part of value.split(",")) {
    if (/^\s*var\(\s*--duration(?:-fast|-slow)?\s*\)\s*$/.test(part)) continue;
    const match = /^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(part);
    if (match === null) return `${prop}: "${value}" must be a time in ms or s, at most 2s`;
    const ms = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
    if (ms > 2000) return `${prop}: "${value}" must be at most 2s`;
  }
  return null;
};

const PROPERTIES: Record<string, Check> = {
  color: color("color"),
  "background-color": color("background-color"),
  "border-color": color("border-color"),
  "border-width": bounded("border-width", "0 and 0.5rem (8px)", { rem: [0, 0.5], px: [0, 8], none: [0, 0] }),
  "border-radius": bounded("border-radius", "0 and 999px (62rem, 50%)", { rem: [0, 62], px: [0, 999], pct: [0, 50], none: [0, 0] }),
  padding: spacing("padding"),
  "padding-top": spacing("padding-top"),
  "padding-right": spacing("padding-right"),
  "padding-bottom": spacing("padding-bottom"),
  "padding-left": spacing("padding-left"),
  margin: spacing("margin"),
  "margin-top": spacing("margin-top"),
  "margin-right": spacing("margin-right"),
  "margin-bottom": spacing("margin-bottom"),
  "margin-left": spacing("margin-left"),
  gap: spacing("gap"),
  "row-gap": spacing("row-gap"),
  "column-gap": spacing("column-gap"),
  "font-size": bounded("font-size", "10px and 40px (0.625rem and 2.5rem, 60% and 200%)", { rem: [0.625, 2.5], px: [10, 40], pct: [60, 200] }),
  "font-weight": (value) => (/^\s*(?:[1-9]00|normal|bold|lighter|bolder)\s*$/i.test(value) ? null : `font-weight: "${value}" must be 100 to 900, normal or bold`),
  "line-height": bounded("line-height", "1 and 2.5 (10px and 40px, 100% and 250%, with a unit)", { rem: [1, 2.5], px: [10, 40], pct: [100, 250], none: [1, 2.5] }, ["normal"]),
  "letter-spacing": bounded("letter-spacing", "-0.2em and 0.2em", { rem: [-0.2, 0.2], px: [-4, 4], none: [0, 0] }),
  opacity: (value) => {
    const n = /^\s*(\d*\.?\d+)\s*$/.exec(value);
    return n !== null && Number(n[1]) >= 0.3 && Number(n[1]) <= 1 ? null : `opacity: "${value}" must be between 0.3 and 1`;
  },
  "box-shadow": bounded("box-shadow", "-64px and 64px (-4rem and 4rem; 0 takes no unit)", { rem: [-4, 4], px: [-64, 64], none: [0, 0] }, ["inset", "none"]),
  "transition-duration": duration("transition-duration"),
  "animation-duration": duration("animation-duration"),
};

/** The error of one value, or null. Applies to every property before its own bounds. */
function checkValue(prop: string, value: string): string | null {
  if (!VALUE_ALPHABET.test(value)) return `${prop}: the value contains a character that is not allowed`;
  if (FORBIDDEN_WORDS.test(value)) return `${prop}: the value loads or runs something, which is not allowed`;
  for (const [, name] of value.matchAll(/([a-z][a-z-]*)\(/gi)) {
    if (!FUNCTIONS.has(name!.toLowerCase())) return `${prop}: ${name}() is not allowed`;
  }
  for (const [, name] of value.matchAll(/var\(\s*(--[a-z0-9-]*)/gi)) {
    if (!TOKENS.has(name!)) return `${prop}: "${name}" is not one of the platform's tokens`;
  }
  // A fallback inside var() could carry anything the checks above do not know; there is none to allow.
  if (/var\(/i.test(value.replace(/var\(\s*--[a-z0-9-]+\s*\)/gi, ""))) return `${prop}: var() takes a token and nothing else`;
  return null;
}

function checkSelector(selector: string): string | null {
  const text = spaced(selector);
  if (/data-guard/i.test(text)) return `selector "${selector.trim()}" reaches a guard element, which no customization may change`;
  const refuse = `selector "${selector.trim()}" is not allowed: use the root, [data-module="<id>"] or a documented platform class`;
  if (ROOT_SELECTOR.test(text)) return null;
  const parts = text.split(/ (?:> )?/);
  const [first, ...rest] = parts;
  if (first === undefined || first === "") return refuse;
  const firstOk = MODULE_SCOPE.test(first) || (COMPOUND.test(first) && CORE_CLASSES.has(/^\.([a-z][a-z0-9_-]*)/.exec(first)?.[1] ?? ""));
  if (!firstOk) return refuse;
  return rest.every((part) => part !== ">" && COMPOUND.test(part)) ? null : refuse;
}

/** A selector with one space around each child combinator and one between everything else. Split on the combinator rather than matched around it, which is linear. */
const spaced = (selector: string): string =>
  selector
    .split(">")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .join(" > ");

/** The selectors of a rule written the way the checks read them, joined the way they are served. */
const normalized = (selector: string): string => spaced(selector).replace(/ > /g, ">");

function serializeDeclaration(decl: Declaration): string {
  return `${decl.prop}:${decl.value.replace(/\s+/g, " ").trim()};`;
}

export function sanitizeCustomCss(input: string, layer: CustomCssLayer = "custom"): CustomCssResult {
  const errors: CustomCssError[] = [];
  const refuse = (node: { source?: { start?: { line: number } } } | undefined, message: string) => errors.push({ line: node?.source?.start?.line ?? 1, message });

  if (Buffer.byteLength(input, "utf8") > MAX_CUSTOM_CSS_BYTES) return { ok: false, errors: [{ line: 1, message: "the stylesheet is larger than 16 KB" }] };
  let root: Root;
  try {
    root = postcss.parse(input);
  } catch (error) {
    const syntax = error as { line?: number; reason?: string };
    return { ok: false, errors: [{ line: syntax.line ?? 1, message: `syntax error: ${syntax.reason ?? "the text is not a stylesheet"}` }] };
  }

  let rules = 0;
  root.walkRules(() => {
    rules++;
  });
  if (rules > MAX_RULES) return { ok: false, errors: [{ line: 1, message: `the stylesheet has more than ${MAX_RULES} rules` }] };

  const serializeRule = (rule: Rule): string | null => {
    const failed = rule.selectors.map(checkSelector).find((message) => message !== null);
    if (failed !== undefined && failed !== null) {
      refuse(rule, failed);
      return null;
    }
    const onRoot = rule.selectors.every((selector) => ROOT_SELECTOR.test(selector.trim()));
    const out: string[] = [];
    let valid = true;
    for (const child of rule.nodes as ChildNode[]) {
      if (child.type === "comment") continue;
      if (child.type !== "decl") {
        refuse(child, child.type === "rule" ? "nested rules are not allowed" : `@${(child as AtRule).name} is not allowed`);
        valid = false;
        continue;
      }
      const message = checkDeclaration(child, onRoot);
      if (message !== null) {
        refuse(child, message);
        valid = false;
      } else out.push(serializeDeclaration(child));
    }
    return valid ? `${rule.selectors.map(normalized).join(",")}{${out.join("")}}` : null;
  };

  const checkDeclaration = (decl: Declaration, onRoot: boolean): string | null => {
    if (decl.important) return "!important is not allowed: the custom layer already wins over the platform's and the modules'";
    const prop = decl.prop;
    if (prop.startsWith("--")) {
      if (!TOKENS.has(prop)) return `custom property "${prop}" is not one of the platform's tokens`;
      return checkValue(prop, decl.value);
    }
    if (onRoot) return "only the platform's tokens can be set on the root";
    const check = PROPERTIES[prop.toLowerCase()];
    if (check === undefined) return `property "${prop}" is not allowed`;
    return checkValue(prop, decl.value) ?? check(decl.value.trim());
  };

  const served: string[] = [];
  for (const node of root.nodes) {
    if (node.type === "comment") continue;
    if (node.type === "rule") {
      const css = serializeRule(node);
      if (css !== null) served.push(css);
    } else if (node.type === "atrule" && node.name.toLowerCase() === "media") {
      const params = node.params.replace(/\s+/g, " ").trim();
      if (!MEDIA.test(params)) {
        refuse(node, `@media ${params}: only min/max width and height, prefers-color-scheme and prefers-reduced-motion are allowed`);
        continue;
      }
      const inner: string[] = [];
      for (const child of node.nodes ?? []) {
        if (child.type === "comment") continue;
        if (child.type !== "rule") {
          refuse(child, `@${(child as AtRule).name ?? child.type} is not allowed`);
          continue;
        }
        const css = serializeRule(child);
        if (css !== null) inner.push(css);
      }
      if (inner.length > 0) served.push(`@media ${params}{${inner.join("")}}`);
    } else if (node.type === "atrule") refuse(node, `@${node.name} is not allowed`);
    else refuse(node, "a declaration has to be inside a rule");
  }

  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, css: served.length === 0 ? "" : `@layer ${layer}{${served.join("")}}` };
}
