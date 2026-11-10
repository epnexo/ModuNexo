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
