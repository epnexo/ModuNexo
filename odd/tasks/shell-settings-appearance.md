# Settings and appearance (stage A3)

Objective: store and edit, from the UI and the CLI, the settings modules declare in their manifests and the
platform's own appearance, with secrets encrypted at rest, and apply appearance through the design tokens, for the
whole shell and per module.
Branch `feat/shell-settings-appearance`, stacked on `feat/shell-ui-auth` (head `8c796f3`). Delivery strategy
`auto-chain`; chain strategy not chosen (no remote). Test runner: `npm test`, `npm run typecheck`, the end-to-end
test in `apps/web/test`. Strict test-first.

## Specs

Quoted fragments are the owner's words; the rest is the plan agreed in the session, assumptions marked.

- **S1 Module settings are stored by the platform.** "todo configurable desde la UI (env solo cuando sea
  obligatorio)". Values for the settings a manifest declares (`string`, `number`, `boolean`, `select`, `secret`,
  `path`) live in the database, not in environment variables. Only declared keys are accepted; the value is
  validated by its declared type and refused with a message naming the key and the rule.
- **S2 Secrets are encrypted and write-only.** Assumption (agreed earlier, reopens "secrets never in the
  database"): a `secret` value is stored encrypted with AES-256-GCM under a key derived from
  `EPNEXO_MASTER_KEY`, bound to its module and key. It is never returned by the UI, the CLI or the audit log;
  they show only "set" or "not set". Module server code can read it. If the master key changes the value is
  reported as unreadable, not as an error that stops the page.
- **S3 Defaults and required.** The effective value is the stored one, else the declared default. A module with
  a `required` setting that has neither is reported as incomplete in the settings screen and by the CLI. Assumption:
  it is only reported; it does not block enabling the module in this feature.
- **S4 Platform appearance.** "la apariencia de la UI configurable". Three platform settings: theme (`system`,
  `light`, `dark`), accent hue (0 to 360) and corner radius (`sharp`, `default`, `round`). They change the design
  tokens only (assumption agreed earlier: no free CSS from the UI).
- **S5 Appearance per module.** "incluso por modulo". A module may have its own accent hue and radius; its pages
  use them, and the rest of the shell keeps the platform's.
- **S6 Settings screen.** `/settings` shows Appearance and one section per enabled module that declares
  settings. Saving shows the validation message beside the field; a secret field shows "set" and can be replaced
  or cleared, never read. Only an administrator or the local operator may change settings.
- **S7 CLI parity.** `epnexo settings list|get|set|unset`, with `--module <id>` for module settings. A secret's
  value is read from standard input, never from an argument, and never printed.
- **S8 No new environment variable.** Everything above lives in the database.
- **S9 Data follows the module lifecycle.** Uninstall with `--keep` keeps a module's settings; `--purge` deletes
  them (and their audit rows stay, without values).
- **S10 Documentation.** The README explains the screen, the CLI, how a manifest declares settings, and what is
  encrypted.

## Tasks

- [x] **T1** (S2, S9) Encryption of secrets and the settings tables (migration `0005_settings.sql`:
  `core.module_settings`, `core.settings_events`); purge removes a module's settings. Route: inline. Risk: item 1
  (data) and item 2 (secrets).
- [x] **T2** (S1, S3, S8) Value validation by declared type and the settings service in `@epnexo/core`: describe,
  get, set, unset, status, audit. Route: inline. Risk: item 2.
- [x] **T3** (S4, S5) Appearance model: platform settings and per-module overrides, and the pure functions that
  turn them into token values. Route: inline.
- [x] **T4** (S7) CLI `settings` commands. Route: inline.
- [ ] **T5** (S4, S5, S6) Web: apply appearance, the settings screen and its server actions. Route: inline. Risk:
  item 2 (a write path behind the gate).
- [ ] **T6** (S10) End-to-end test, README, independent verifier over the whole feature, native reviews. Route:
  inline plus verifier.

Forecast: about 1,800 authored changed lines, above the 400-line review budget, so one slice per task.

## Log

- **L1** (2026-10-13, owner, verbatim): "listo ya los cree continua". Context: the reply to the question
  "¿Arranco con A3?" (ajustes y apariencia) asked at the close of A2; the standing instruction to continue tasks
  and reviews automatically and stop only for a big decision still holds.
- **L2** Original request that defines this feature (from the project's first turn, summarised): everything
  configurable from the UI, environment only when mandatory; UI appearance configurable, including per module.
  Earlier plan decisions kept: theming by tokens with no free CSS; secrets encrypted in the database.
- **L3** (2026-10-13) Exploration. The manifest already declares `settings` (`key`, `label`, `type`, `default`,
  `required`, `options`, `description`); nothing stores them. `core.platform_settings` (key, jsonb value,
  `updated_by`) exists since A2 and is reused for the platform appearance keys. `deriveSecret(masterKey,
  purpose)` exists (HKDF-SHA256) and is the way to get the settings encryption key.
- **L4** (2026-10-13) T1 done. `settings/crypto.ts`: AES-256-GCM, key from `deriveSecret(master, "settings")`,
  token `v1.<iv>.<tag>.<ciphertext>`, module and key as associated data, so a token moved to another slot, a
  changed token or another master key is `SecretUnreadableError` (message names the slot, never a value or the
  key). Migration `0005_settings.sql`: `core.module_settings` (one of value or secret, enforced by a check) and
  `core.settings_events` (no values; not tied to the settings rows so it outlives a purge). Purge deletes a
  module's settings when the table exists. RED first (module missing, tables missing), then GREEN: 6 crypto
  tests, 5 table tests. Three existing tests that pinned exact lists were updated on purpose: the purge
  statement sequence and the core's tables and migrations. `npm test` 494 pass, 0 fail, 0 skipped.
- **L5** (2026-10-13) T2, T3 and T4 done, tests first (RED observed for each file: module missing, then
  GREEN).
  - T2: `settings/validate.ts` (a refusal names the key and the rule and never echoes the input: for a secret
    the input is the secret; numbers accept decimal text only, so `1e3`, `0x10` and `Infinity` are refused; a
    path must be absolute without `..` segments) and `SettingsService` (`describe`, `get`, `set`, `unset`,
    `incomplete`). A stored value the declaration no longer accepts falls back to the default and is flagged
    `invalid`; a secret under another master key is flagged `unreadable` in the listing and throws only from
    `get`, so one stale secret cannot take down the screen. A refused change leaves no audit row.
  - T3: `settings/appearance.ts` (pure: validation, `resolveAppearance`, `appearanceCss`, `themeInitScript`)
    and `AppearanceService` over `core.platform_settings`. Only a number from 0 to 360 and one of three radius
    names ever reach a stylesheet, and the test pins the output to a fixed alphabet. A module's override keys
    are `appearance.module.<id>.accentHue|radius`; purge deletes them with `starts_with`, not `LIKE`, because a
    module id may contain `_`. The theme is the visitor's and cannot be overridden per module.
  - T4: `epnexo settings list|get|set|unset [--module <id>]`. Platform appearance needs no master key;
    anything that touches module settings does. A secret is read from standard input, refused as an argument
    (exit 2) and as an empty value (exit 3), and is never printed. `get` of an unreadable secret exits 1.
  Existing tests that pin exact statement lists were updated for the two new purge statements. `npm test`
  551 pass, 0 fail, 0 skipped; typecheck clean.
