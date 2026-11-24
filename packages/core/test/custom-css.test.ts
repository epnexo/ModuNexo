import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { servedCustomCss } from "../src/settings/appearance-service.ts";
import { CUSTOM_CSS_TOKENS, MAX_CUSTOM_CSS_BYTES, sanitizeCustomCss } from "../src/settings/custom-css.ts";

const accepted = (input: string): string => {
  const result = sanitizeCustomCss(input);
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.errors));
  return result.css;
};
const refused = (input: string, message: RegExp, line?: number): void => {
  const result = sanitizeCustomCss(input);
  assert.equal(result.ok, false, `accepted: ${input}`);
  if (result.ok) return;
  assert.ok(
    result.errors.some((error) => message.test(error.message) && (line === undefined || error.line === line)),
    `${JSON.stringify(result.errors)} should match ${message}${line === undefined ? "" : ` on line ${line}`}`,
  );
};

describe("sanitizeCustomCss: what it accepts", () => {
  it("accepts nothing at all, and turns it into no stylesheet", () => {
    assert.equal(accepted(""), "");
    assert.equal(accepted("  \n /* only a comment */ \n"), "");
  });

  it("rewrites what it accepts into the custom layer, normalised, from the parsed rules and not from the text", () => {
    assert.equal(accepted(":root{ --accent : oklch(0.5 0.1 30) }"), "@layer custom{:root{--accent:oklch(0.5 0.1 30);}}");
    assert.equal(accepted("/* mine */ .card { border-color: var(--accent); padding: 1rem }"), "@layer custom{.card{border-color:var(--accent);padding:1rem;}}");
  });

  it("accepts the tokens in the theme variants of the root, a module's scope with its descendants, and a core class with a state", () => {
    assert.match(accepted(':root[data-theme="dark"]{--surface:oklch(0.2 0.02 220)}'), /^@layer custom\{:root\[data-theme="dark"\]\{--surface:/);
    assert.match(accepted('[data-module="ai-usage"] .au-card{background-color:oklch(0.3 0.02 220)}'), /\[data-module="ai-usage"\] \.au-card\{background-color:/);
    assert.match(accepted(".card:hover, .card-link:focus-visible{border-color:var(--accent)}"), /\.card:hover,\.card-link:focus-visible\{/);
  });

  it("accepts a media query of a fixed alphabet around those rules", () => {
    assert.match(accepted("@media (min-width: 40rem){.card{padding:1.5rem}}"), /@media \(min-width: 40rem\)\{\.card\{padding:1\.5rem;\}\}/);
    assert.match(accepted("@media (prefers-color-scheme: dark){.badge{opacity:0.8}}"), /prefers-color-scheme: dark/);
  });

  it("accepts the calculations a stylesheet needs, over the platform's tokens", () => {
    assert.match(accepted(".card{padding:calc(var(--card-pad) * 1.2)}"), /calc\(var\(--card-pad\) \* 1\.2\)/);
    assert.match(accepted(".card{box-shadow:0 1px 2px oklch(0 0 0 / 0.2)}"), /box-shadow:0 1px 2px oklch\(0 0 0 \/ 0\.2\)/);
    assert.match(accepted(".card{transition-duration:150ms;font-weight:600;line-height:1.4}"), /transition-duration:150ms;font-weight:600;line-height:1\.4/);
  });
});

describe("sanitizeCustomCss: what it refuses, and where", () => {
  it("refuses every at-rule that loads or declares something, and any at-rule inside a media query", () => {
    refused('@import "https://evil.example/x.css";', /@import is not allowed/, 1);
    refused('@font-face{font-family:x;src:url(https://evil.example/f.woff)}', /@font-face is not allowed/);
    refused("@charset \"utf-8\";", /@charset is not allowed/);
    refused("@layer other{.card{padding:1rem}}", /@layer is not allowed/);
    refused("@keyframes x{from{opacity:1}to{opacity:1}}", /@keyframes is not allowed/);
    refused('@media (min-width:1px){@import "x.css";}', /@import is not allowed/);
  });

  it("refuses a selector outside the root, a module's scope and the documented core classes", () => {
    refused("body{color:red}", /selector "body" is not allowed/);
    refused("div .card{padding:1rem}", /is not allowed/);
    refused("#app{padding:1rem}", /is not allowed/);
    refused("*{padding:1rem}", /is not allowed/);
    refused(".card, a{padding:1rem}", /selector "a" is not allowed/);
    refused('[data-module="Bad Id"]{padding:1rem}', /is not allowed/);
    refused(".card::selection{padding:1rem}", /is not allowed/);
  });

  it("refuses to reach anything marked as a guard, however the selector gets there", () => {
    refused("[data-guard]{padding:1rem}", /guard/);
    refused('.card [data-guard="alert"]{padding:1rem}', /guard/);
    refused('[data-module="agenda"] [data-guard]{padding:1rem}', /guard/);
  });

  it("refuses a property outside the list: what hides, moves, loads or injects", () => {
    for (const property of ["position:fixed", "display:none", "visibility:hidden", "z-index:9999", "content:'x'", "background-image:none", "background:red", "transform:scale(0)", "clip-path:inset(50%)", "pointer-events:none", "font-family:serif", "cursor:wait", "filter:blur(1px)", "width:1px", "height:1px", "overflow:hidden"]) {
      refused(`.card{${property}}`, /property "[a-z-]+" is not allowed/);
    }
  });

  it("refuses a custom property that is not one of the documented tokens, and a token's own value that is not a value", () => {
    refused(":root{--evil:1}", /custom property "--evil" is not one of the platform's tokens/);
    refused(".card{color:var(--evil)}", /"--evil" is not one of the platform's tokens/);
    refused(":root{color:red}", /only the platform's tokens can be set on the root/);
  });

  it("refuses everything that loads from outside or runs, in every value", () => {
    for (const value of ["url(https://evil.example/x)", "url('x')", "image-set(url(x) 1x)", "expression(alert(1))", "javascript:alert(1)", "attr(data-x)", "env(x)", "src(x)", "paint(x)", "var(--accent, url(x))", "red\\;x", "\\72 ed", "red /* x */ url(x)"]) {
      const result = sanitizeCustomCss(`.card{color:${value}}`);
      assert.equal(result.ok, false, value);
    }
  });

  it("refuses !important: the custom layer already wins over the module's", () => {
    refused(".card{color:red !important}", /!important is not allowed/);
  });

  it("keeps spacing, size and visibility inside bounds that cannot hide or break a page", () => {
    refused(".card{padding:100rem}", /padding: .* between 0 and/);
    refused(".card{margin:-1rem}", /margin: .* between 0 and/);
    refused(".card{gap:5000px}", /gap: .* between 0 and/);
    refused(".card{font-size:1px}", /font-size: .* between/);
    refused(".card{font-size:90rem}", /font-size: .* between/);
    refused(".card{opacity:0}", /opacity: .* between 0\.3 and 1/);
    refused(".card{opacity:2}", /opacity: .* between 0\.3 and 1/);
    refused(".card{color:transparent}", /color: transparent is not allowed/);
    refused(".card{transition-duration:30s}", /transition-duration: .* at most/);
  });

  it("reports the line of what it refused, and every refusal, not only the first", () => {
    const result = sanitizeCustomCss(".card{padding:1rem}\n\nbody{color:red}\n.card{position:fixed}\n");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.errors.map((error) => error.line), [3, 4]);
  });

  it("refuses text that is not a stylesheet, without a stack, with the line of the syntax error", () => {
    refused(".card{color:red", /syntax error/i, 1);
    refused(".card{color:red}</style><script>alert(1)</script>", /./);
    refused("<style>.card{color:red}</style>", /./);
  });

  it("refuses more than the size cap, before parsing", () => {
    refused(`.card{padding:1rem}\n${"/* x */".repeat(Math.ceil(MAX_CUSTOM_CSS_BYTES / 7))}`, /larger than 16 KB/);
  });

  it("refuses an unreasonable number of rules", () => {
    refused(Array.from({ length: 301 }, () => ".card{padding:1rem}").join("\n"), /more than 300 rules/);
  });
});

describe("sanitizeCustomCss: what it costs", () => {
  const time = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  it("decides a hostile selector of any length in linear time, because it runs on every page read", () => {
    for (const hostile of [`.card ${"a".repeat(5000)}!`, `.card ${"a".repeat(5000)}`, `.card ${".a".repeat(2000)}!`, `.card ${"a1".repeat(2500)}:`]) {
      const ms = time(() => sanitizeCustomCss(`${hostile}{padding:1rem}`));
      assert.ok(ms < 100, `${ms.toFixed(1)} ms for a selector of ${hostile.length} characters`);
    }
  });

  it("checks the largest stylesheet it allows in a fraction of a frame's budget", () => {
    const rules = Array.from({ length: 300 }, (_, i) => `.card:hover .part-${i}{padding:1rem;border-color:var(--accent);box-shadow:0 1px 2px oklch(0 0 0 / 0.2)}`).join("\n");
    const largest = rules.slice(0, MAX_CUSTOM_CSS_BYTES - 200).replace(/\}[^}]*$/, "}");
    assert.ok(Buffer.byteLength(largest) > 15_000, "close to the 16 KB cap");
    const ms = time(() => assert.ok(sanitizeCustomCss(largest).ok));
    assert.ok(ms < 150, `${ms.toFixed(1)} ms`);

    // What a page pays: the same text again is answered from memory, not parsed again.
    assert.equal(servedCustomCss(largest), servedCustomCss(largest));
    assert.ok(time(() => servedCustomCss(largest)) < 2, "the second read parses nothing");
    assert.equal(servedCustomCss("@import 'x';"), "", "and a stylesheet that does not pass is never served");
  });

  it("takes the platform's own duration tokens where a time goes", () => {
    assert.match(accepted(".card{transition-duration:var(--duration)}"), /transition-duration:var\(--duration\)/);
    assert.match(accepted(".card{transition-duration:var(--duration-fast), 200ms}"), /var\(--duration-fast\), 200ms/);
    refused(".card{transition-duration:var(--evil)}", /"--evil" is not one of the platform's tokens/);
  });
});

describe("sanitizeCustomCss: what it never lets through", () => {
  it("writes only a fixed alphabet, and never a url, an escape, an angle bracket or an import, whatever the input was", () => {
    const hostile = [
      ".card{padding:1rem}",
      '.card{color:var(--accent)}/*</style>*/',
      "@media (min-width:1px){.card{padding:1rem}}",
      ':root{--accent:oklch(0.5 0.1 30)}',
      '.card{border-color:oklch(0.5 0.1 30)}.card:hover{opacity:0.9}',
    ];
    for (const input of hostile) {
      const result = sanitizeCustomCss(input);
      if (!result.ok) continue;
      assert.match(result.css, /^[a-zA-Z0-9\s.,%#()/+\-*:;{}[\]="@>_]*$/);
      assert.doesNotMatch(result.css, /url\(|\\|<|@import|expression/i);
    }
  });

  it("allows only tokens that exist in tokens.css", () => {
    const tokens = readFileSync(new URL("../../../apps/web/src/styles/tokens.css", import.meta.url), "utf8");
    for (const name of CUSTOM_CSS_TOKENS) assert.match(tokens, new RegExp(`${name}\\s*:`), `${name} is declared in tokens.css`);
  });
});
