import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_APPEARANCE, DENSITY_REM, appearanceCss, resolveAppearance, themeInitScript, validateAppearanceValue } from "../src/settings/appearance.ts";

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
    assert.deepEqual(state.platform, { theme: "dark", accentHue: 140, radius: "round", density: "default", motion: "full" });
    assert.deepEqual(state.modules, { alpha: { accentHue: 20, radius: "sharp" }, "beta-two": { accentHue: 300 } });
  });

  it("only reads override keys whose module id is kebab-case, as the manifest validator requires", () => {
    const state = resolveAppearance(
      rows({
        "appearance.module.alpha-beta.accentHue": 10,
        "appearance.module.a1.accentHue": 20,
        "appearance.module.1a.accentHue": 30,
        "appearance.module.a_b.accentHue": 40,
        "appearance.module.-a.accentHue": 50,
        "appearance.module.a-.accentHue": 60,
        "appearance.module.a--b.accentHue": 70,
      }),
    );
    assert.deepEqual(state.modules, { "alpha-beta": { accentHue: 10 }, a1: { accentHue: 20 } });
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
    assert.match(out, /:root\[data-theme="light"\]\{[^}]*--accent:oklch\(0\.45 0\.075 140\)/);
    assert.match(out, /:root\[data-theme="dark"\]\{[^}]*--accent:oklch\(0\.826 0\.07 140\)/);
    assert.match(out, /--ring:oklch\(0\.45 0\.075 140 \/ 0\.55\)/);
  });

  it("uses the shipped look for the defaults", () => {
    const out = css();
    assert.match(out, /--radius:0\.625rem/);
    assert.match(out, /--accent:oklch\(0\.45 0\.075 220\)/);
    assert.doesNotMatch(out, /data-module/);
  });

  it("scopes a module's override to the module and only for what it overrides", () => {
    const out = css({ "appearance.module.alpha.accentHue": 20 });
    assert.match(out, /\[data-module="alpha"\]\{[^}]*--accent:oklch\(0\.45 0\.075 20\)/);
    assert.match(out, /\[data-theme="dark"\] \[data-module="alpha"\]\{[^}]*--accent:oklch\(0\.826 0\.07 20\)/);
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
    assert.match(out, /^[a-zA-Z0-9\s.:;,\-()/[\]="%{}@]*$/);
    assert.match(out, /oklch\(0\.45 0\.075 12\.35\)/);
  });
});

describe("themeInitScript", () => {
  it("falls back to the system preference when the default is system, and to the given theme otherwise", () => {
    assert.match(themeInitScript("system", "modunexo.theme"), /prefers-color-scheme: dark/);
    const dark = themeInitScript("dark", "modunexo.theme");
    assert.match(dark, /"dark"/);
    assert.doesNotMatch(dark, /matchMedia/);
  });

  it("reads the saved choice from the given storage key and survives blocked storage", () => {
    const script = themeInitScript("light", "modunexo.theme");
    assert.match(script, /localStorage\.getItem\("modunexo\.theme"\)/);
    assert.match(script, /catch/);
  });
});

describe("density and motion", () => {
  const css = (entries: Record<string, unknown> = {}) => appearanceCss(resolveAppearance(rows(entries)));

  it("defaults to the shipped spacing and to full motion, and accepts only the named values", () => {
    assert.equal(DEFAULT_APPEARANCE.density, "default");
    assert.equal(DEFAULT_APPEARANCE.motion, "full");
    for (const [name, value] of [["density", "compact"], ["density", "comfortable"], ["motion", "reduced"]] as const) assert.deepEqual(validateAppearanceValue(name, value), { ok: true, value });
    for (const [name, value] of [["density", "huge"], ["density", 3], ["motion", "off"], ["motion", ""]] as const) {
      const checked = validateAppearanceValue(name, value);
      assert.equal(checked.ok, false, `${name}=${String(value)}`);
      if (!checked.ok) assert.match(checked.message, new RegExp(`^appearance\\.${name}: must be one of`));
    }
  });

  it("reads them for the platform and as module overrides, and ignores a value it no longer accepts", () => {
    const state = resolveAppearance(rows({ "appearance.density": "compact", "appearance.motion": "reduced", "appearance.module.alpha.density": "comfortable", "appearance.module.alpha.motion": "full", "appearance.module.beta.density": "huge" }));
    assert.equal(state.platform.density, "compact");
    assert.equal(state.platform.motion, "reduced");
    assert.deepEqual(state.modules, { alpha: { density: "comfortable", motion: "full" } });
  });

  it("writes the three spacing tokens of the density for the platform and, scoped, for a module", () => {
    const platform = css({ "appearance.density": "compact" });
    const compact = DENSITY_REM.compact;
    assert.match(platform, new RegExp(`:root\\{[^}]*--layout-gap:${compact.layoutGap};--card-pad:${compact.cardPad};--card-gap:${compact.cardGap}`));
    const mod = css({ "appearance.module.alpha.density": "comfortable" });
    const comfortable = DENSITY_REM.comfortable;
    assert.match(mod, new RegExp(`\\[data-module="alpha"\\]\\{[^}]*--layout-gap:${comfortable.layoutGap};--card-pad:${comfortable.cardPad};--card-gap:${comfortable.cardGap}`));
    assert.doesNotMatch(css({ "appearance.module.alpha.accentHue": 20 }), /\[data-module="alpha"\]\{[^}]*--card-pad/, "a module that sets no density follows the platform");
  });

  it("turns motion off with the duration tokens, and turns it on only where the visitor did not ask for less", () => {
    const reduced = css({ "appearance.motion": "reduced" });
    assert.match(reduced, /:root\{[^}]*--duration-fast:1ms;--duration:1ms;--duration-slow:1ms;--stagger:0ms/);
    assert.match(reduced, /\.page-enter\{animation:none\}/);
    const full = css({ "appearance.module.alpha.motion": "full" });
    assert.match(full, /@media \(prefers-reduced-motion: no-preference\)\{\[data-module="alpha"\]\{[^}]*--duration:180ms;[^}]*--stagger:60ms/);
    assert.doesNotMatch(css(), /prefers-reduced-motion/, "the default writes nothing for motion");
  });
});
