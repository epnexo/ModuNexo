import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const src = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith(".tsx") ? [join(dir, name)] : []));
const read = (path: string) => readFileSync(path, "utf8");

describe("guard elements", () => {
  it("marks every alert of the platform as a guard, so no custom stylesheet can hide or restyle what it says", () => {
    const unmarked: string[] = [];
    for (const file of files(src)) {
      // The editor of the custom CSS shows its own refusals; those are its own, not the platform's warnings.
      if (file.endsWith("custom-css-form.tsx")) continue;
      for (const match of read(file).matchAll(/<[a-zA-Z][^<>]*?role="alert"[^<>]*>/g)) {
        if (!/\bdata-guard\b/.test(match[0])) unmarked.push(`${file.slice(src.length + 1)}: ${match[0].slice(0, 70)}`);
      }
    }
    assert.deepEqual(unmarked, []);
  });

  it("marks the dashboard's alerts as a guard", () => {
    assert.match(read(join(src, "app", "(shell)", "page.tsx")), /<Section id="alerts"[^>]*\bguard\b/);
  });
});
