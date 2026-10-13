import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_APPEARANCE, appearanceCss, resolveAppearance, themeInitScript, validateAppearanceValue } from "../src/settings/appearance.ts";

const rows = (entries: Record<string, unknown>) => Object.entries(entries).map(([key, value]) => ({ key, value }));

describe("resolveAppearance", () => {
  it("is the defaults when nothing is stored", () => {
    assert.deepEqual(resolveAppearance([]), { platform: DEFAULT_APPEARANCE, modules: {} });
  });

  it("reads the platform values and the per-module overrides", () => {
    const state = resolveAppearance(
      rows({
        "appearance.theme": "dark",
        "appearance.accentHue": 140,
        "appearance.radius": "round",
        "appearance.module.alpha.accentHue": 20,
        "appearance.module.alpha.radius": "sharp",
        "appearance.module.beta-two.accentHue": 300,
      }),
    );
    assert.deepEqual(state.platform, { theme: "dark", accentHue: 140, radius: "round" });
    assert.deepEqual(state.modules, { alpha: { accentHue: 20, radius: "sharp" }, "beta-two": { accentHue: 300 } });
  });

  it("falls back to the default for a stored value it does not accept, and ignores keys it does not know", () => {
    const state = resolveAppearance(
      rows({
        "appearance.theme": "neon",
        "appearance.accentHue": 999,
        "appearance.radius": 5,
        "appearance.module.alpha.accentHue": "red",
        "appearance.module.Bad Id.accentHue": 10,
        "appearance.module.alpha.theme": "dark",
        "something.else": 1,
      }),
    );
    assert.deepEqual(state, { platform: DEFAULT_APPEARANCE, modules: {} });
  });
});

describe("validateAppearanceValue", () => {
  it("accepts a theme, a hue from 0 to 360 and a radius, from text or from the value", () => {
    assert.deepEqual(validateAppearanceValue("theme", "light"), { ok: true, value: "light" });
    assert.deepEqual(validateAppearanceValue("accentHue", "140"), { ok: true, value: 140 });
    assert.deepEqual(validateAppearanceValue("accentHue", 0), { ok: true, value: 0 });
    assert.deepEqual(validateAppearanceValue("accentHue", " 360 "), { ok: true, value: 360 });
    assert.deepEqual(validateAppearanceValue("accentHue", "12.5"), { ok: true, value: 12.5 });
    assert.deepEqual(validateAppearanceValue("radius", "sharp"), { ok: true, value: "sharp" });
  });

  it("refuses anything else with a message naming the setting", () => {
    for (const [name, input] of [
      ["theme", "neon"],
      ["theme", ""],
      ["accentHue", "-1"],
      ["accentHue", "361"],
      ["accentHue", "red"],
      ["accentHue", ""],
      ["accentHue", NaN],
      ["radius", "huge"],
      ["unknown", "x"],
    ] as const) {
      const result = validateAppearanceValue(name, input);
      assert.equal(result.ok, false, `${name}=${String(input)}`);
      if (!result.ok) assert.match(result.message, new RegExp(name));
    }
  });
});

describe("appearanceCss", () => {
  const css = (entries: Record<string, unknown> = {}) => appearanceCss(resolveAppearance(rows(entries)));

  it("sets the radius and the accent for light and for dark from the platform hue", () => {
    const out = css({ "appearance.accentHue": 140, "appearance.radius": "round" });
    assert.match(out, /:root\{[^}]*--radius:1rem/);
    assert.match(out, /:root\[data-theme="light"\]\{[^}]*--accent:oklch\(0\.49 0\.15 140\)/);
    assert.match(out, /:root\[data-theme="dark"\]\{[^}]*--accent:oklch\(0\.7 0\.13 140\)/);
    assert.match(out, /--ring:oklch\(0\.49 0\.15 140 \/ 0\.55\)/);
  });

  it("uses the shipped look for the defaults", () => {
    const out = css();
    assert.match(out, /--radius:0\.625rem/);
    assert.match(out, /--accent:oklch\(0\.49 0\.15 258\)/);
    assert.doesNotMatch(out, /data-module/);
  });

  it("scopes a module's override to the module and only for what it overrides", () => {
    const out = css({ "appearance.module.alpha.accentHue": 20 });
    assert.match(out, /\[data-module="alpha"\]\{[^}]*--accent:oklch\(0\.49 0\.15 20\)/);
    assert.match(out, /\[data-theme="dark"\] \[data-module="alpha"\]\{[^}]*--accent:oklch\(0\.7 0\.13 20\)/);
    assert.doesNotMatch(out, /\[data-module="alpha"\]\{[^}]*--radius/);
    const withRadius = css({ "appearance.module.alpha.radius": "sharp" });
    assert.match(withRadius, /\[data-module="alpha"\]\{[^}]*--radius:0\.25rem/);
  });

  it("emits only a fixed alphabet, whatever the stored values were", () => {
    const out = css({
      "appearance.accentHue": 12.345678,
      "appearance.module.alpha.accentHue": 1e-7,
      "appearance.module.a1.radius": "round",
      "appearance.theme": "dark",
    });
    assert.match(out, /^[a-zA-Z0-9\s.:;,\-()/[\]="%{}]*$/);
    assert.match(out, /oklch\(0\.49 0\.15 12\.35\)/);
  });
});

describe("themeInitScript", () => {
  it("falls back to the system preference when the default is system, and to the given theme otherwise", () => {
    assert.match(themeInitScript("system", "epnexo.theme"), /prefers-color-scheme: dark/);
    const dark = themeInitScript("dark", "epnexo.theme");
    assert.match(dark, /"dark"/);
    assert.doesNotMatch(dark, /matchMedia/);
  });

  it("reads the saved choice from the given storage key and survives blocked storage", () => {
    const script = themeInitScript("light", "epnexo.theme");
    assert.match(script, /localStorage\.getItem\("epnexo\.theme"\)/);
    assert.match(script, /catch/);
  });
});
