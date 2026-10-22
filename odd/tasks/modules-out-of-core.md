# modules-out-of-core

Objective: the core repo ships no business module; modules are separate packages a user installs. Show the platform version on every shell screen.
Branch: feat/modules-out-of-core. Delivery: single slice, merge to main on the user's word. Test runner: `node --import tsx --test`.

## Specs

- S1. "en la web no se ve la version que estamos manejando": every shell screen shows `Modunexo <CORE_VERSION>` (the footer), not only `/status`.
- S2. "sacalo": the `inbox` module leaves the core repo (`modules-src/inbox/` and its three tests in `packages/core/test/`).
- S3. "para que el core quede en blanco y los modulos solo crear el archivo para instalarlo no crearlo directamente en el core": modules are made outside the core and installed as an archive (`modules pack` then `modules add`). [assumption: a sibling repo `modunexo-modules` beside this one holds the inbox; no remote is created or pushed without the user's word]
- S4. The inbox keeps its 26 tests passing in its new home, and its packed archive installs with `modules add` / `modules apply`.

## Tasks

- T1 (S1) footer shows the version, e2e asserts it on the home screen. inline.
- T2 (S4) core exports the pieces a module's tests need (`runner`, `jobs/runtime`, `settings/service`). inline.
- T3 (S2, S3, S4) create the sibling repo with the inbox, its tests and a pack script. inline.
- T4 (S2) remove the inbox and its tests from the core; fix README and the `modules new` wording. inline.
- T5 (S4) verify: module tests green in the new repo, archive packs and passes `modules add`, core suite and typecheck green.

## Log

- L1: "sacalo y en la web no se ve la version que estamos manejando" (after: "quiero quitar el inbox del desplique ... y segir con los otros modulos de vocero", "uninstall purge para que el core quede en blanco y los modulos solo crear el archivo para instalarlo no crearlo directamente en el core").
- L2: inbox uninstalled with `--purge --rebuild` on :3000 (schema gone, /inbox 404, health 200). The core suite does not need the inbox installed.
