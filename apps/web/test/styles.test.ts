import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = stripComments(readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8"));
const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

/** The text of every `@media (prefers-reduced-motion: reduce) { ... }` block of a stylesheet. */
function reducedMotionBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (const start of css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)) {
    let depth = 1;
    let i = start.index! + start[0].length;
    const from = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(from, i - 1));
  }
  return blocks;
}

describe("spacing tokens", () => {
  it("defines the variables modules read, once, in :root", () => {
    for (const name of ["--layout-gap", "--card-pad", "--card-gap", "--card-radius"]) {
      const declared = [...tokens.matchAll(new RegExp(`${name}\\s*:`, "g"))];
      assert.equal(declared.length, 1, `${name} is declared exactly once`);
    }
  });

  it("keeps the dark theme free of spacing values, so a theme change never moves the layout", () => {
    const dark = tokens.slice(tokens.indexOf(':root[data-theme="dark"]'));
    assert.doesNotMatch(dark, /--(layout-gap|card-pad|card-gap)/);
  });
});

describe("motion", () => {
  it("switches the page entrance off for anyone who asked for less motion", () => {
    assert.match(globals, /\.page-enter\s*\{[^}]*animation:\s*page-enter/);
    assert.ok(reducedMotionBlocks(globals).some((block) => /\.page-enter\s*\{[^}]*animation:\s*none/.test(block)));
  });

  it("keeps the entrance short, a fade and a small rise, never a layout change", () => {
    const keyframes = globals.match(/@keyframes page-enter\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(keyframes, /opacity/);
    assert.doesNotMatch(keyframes, /\b(width|height|margin|padding|top|left)\b/);
    const ms = Number(globals.match(/animation:\s*page-enter\s+(\d+)ms/)?.[1]);
    assert.ok(ms >= 150 && ms <= 600, `the entrance lasts ${ms} ms`);
  });
});

describe("card, tile and chart styling", () => {
  it("gives the card its accent line from tokens, so a module can switch it off", () => {
    assert.match(tokens, /--card-line-opacity\s*:/);
    const card = globals.match(/\.card::before\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(card, /var\(--accent\)/);
    assert.match(card, /opacity:\s*var\(--card-line-opacity\)/);
  });

  it("declares the chart bar shades in both themes and reads only tokens", () => {
    for (const name of ["--chart-top", "--chart-base"]) {
      assert.equal([...tokens.matchAll(new RegExp(`${name}\\s*:`, "g"))].length, 2, `${name} is set for light and dark`);
    }
    assert.match(globals, /\.chart-fill\s*\{[^}]*var\(--chart-top\)[^}]*var\(--chart-base\)/);
  });

  it("keeps the dark neutrals on one petrol hue", () => {
    const dark = tokens.slice(tokens.indexOf('[data-theme="dark"]'));
    const neutrals = ["--background", "--surface", "--panel", "--border"].map((name) => Number(dark.match(new RegExp(`${name}:\\s*oklch\\([^)]*\\s(\\d+)\\)`))?.[1]));
    for (const hue of neutrals) assert.ok(hue >= 218 && hue <= 228, `neutral hue ${hue} is petrol`);
  });

  it("draws a badge from tokens with a dot and one class per tone", () => {
    assert.match(globals, /\.badge::before\s*\{[^}]*background:\s*var\(--badge-tone\)/);
    for (const tone of ["info", "success", "warning", "danger"]) {
      assert.match(globals, new RegExp(`\\.badge-${tone}\\s*\\{[^}]*--badge-tone:\\s*var\\(--(accent|success|warning|danger)\\)`), `badge-${tone}`);
    }
  });

  it("folds a dashboard section by its height and takes the closed body out of the tab order", () => {
    assert.match(globals, /\.fold\[data-open="false"\]\s+\.fold-body\s*\{[^}]*grid-template-rows:\s*0fr/);
    assert.match(globals, /\.fold\[data-open="false"\]\s+\.fold-inner\s*\{[^}]*visibility:\s*hidden/);
    assert.match(globals, /\.fold-body\s*\{[^}]*transition:\s*grid-template-rows var\(--duration-slow\)/);
  });
});

/** The text of the `@layer components { ... }` block of globals.css. */
function componentsLayer(): string {
  const start = globals.indexOf("@layer components {");
  let depth = 0;
  for (let i = globals.indexOf("{", start); i < globals.length; i++) {
    if (globals[i] === "{") depth++;
    else if (globals[i] === "}" && --depth === 0) return globals.slice(start, i + 1);
  }
  return "";
}

describe("components every module can use", () => {
  const layer = componentsLayer();
  const rule = (selector: string) => layer.match(new RegExp(`${selector.replace(/[.[\]()|]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it("defines the segmented control, the figures, the notice and the table in the components layer", () => {
    for (const selector of [".seg", ".stats", ".stat", ".stat-label", ".stat-value", ".stat-sub", ".notice", ".notice-info", ".notice-error", ".table-scroll", ".data-table"]) {
      assert.notEqual(rule(selector), "", `${selector} is defined`);
    }
  });

  it("draws all of them from tokens: no colour value in the whole components layer", () => {
    assert.doesNotMatch(layer.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(/);
  });

  it("marks the current segment by aria and a tick, not by colour alone", () => {
    assert.match(layer, /\.seg \[aria-current="page"\]::before/);
    assert.match(layer, /\.seg \[aria-pressed="true"\]/);
  });

  it("lets a module tone a figure and thicken its line through variables, with the platform default", () => {
    assert.match(rule(".stat"), /--stat-tone:\s*var\(--accent\)/);
    assert.match(rule(".stat"), /border-top:\s*var\(--stat-line,\s*1px\)/);
    assert.match(rule(".stat-value"), /color:\s*var\(--stat-tone\)/);
  });

  it("fills the row with figures however many there are, two to a row on a phone", () => {
    assert.match(rule(".stats"), /repeat\(auto-fit,\s*minmax\(10\.625rem,\s*1fr\)\)/);
    assert.match(layer, /@media \(max-width: 900px\)\s*\{\s*\.stats\s*\{[^}]*repeat\(2,/);
  });

  it("gives errors and information their own tones, and warnings the default", () => {
    assert.match(rule(".notice"), /--warning-soft/);
    assert.match(rule(".notice-error"), /--danger-soft/);
    assert.match(rule(".notice-info"), /--accent-soft/);
  });

  it("keeps a larger target for the segmented control on coarse pointers", () => {
    assert.match(layer, /@media \(pointer: coarse\)\s*\{[^@]*\.seg a[^}]*min-height:\s*2\.75rem/);
  });
});
