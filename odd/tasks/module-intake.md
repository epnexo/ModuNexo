# Module package intake (stage A4a)

Objective: let a module package built somewhere else reach the platform safely. An archive is checked,
unpacked into a staging area and described to the administrator before anything is installed, and nothing in
it is executed. Installing it (migrations, build, restart, rollback) is the next feature, A4b; the Apps
screen is A4c.
Branch `feat/module-intake`, stacked on `feat/shell-hardening` (head `0889cfb`). Delivery strategy `auto-chain`;
chain strategy not chosen (no remote). Test runner: `npm test`, `npm run typecheck`. Strict test-first.

## Why this comes first

Installing a module runs its code with access to the database (migrations, hooks) and then serves its pages
inside the shell. The owner's rule from the start: modules are built elsewhere and uploaded ("subir un .py o
.zip y que el modulo se agregue"), install plus restart is fine. The dangerous part is not the install, it is
the moment before it: reading a package you do not trust. This feature makes that moment inert.

## Specs

Quoted fragments are the owner's words; the rest is the plan agreed in the session, assumptions marked.

- **S1 Package format.** Assumption: a gzip tarball like the one `npm pack` makes, with one top-level folder
  holding `package.json`, `manifest.ts`, `manifest.json`, `migrations/*.sql`, the module's web sources and an
  optional hooks file. `manifest.json` is the manifest as data, written by the packaging command, so the
  platform can read what a package says without running it.
- **S2 Packaging command.** `epnexo modules pack <folder> [--out <file>]` evaluates the folder's `manifest.ts`
  (the author's own machine, the author's own code), writes `manifest.json`, leaves out `node_modules`, `.git`,
  `.next` and similar, and prints the archive's size and SHA-256.
- **S3 Intake command.** `epnexo modules add <archive> [--sha256 <hex>]` stages the archive and prints a review:
  id, version, name, size, SHA-256, pages, navigation, permissions, settings, migrations, whether it runs hooks
  at install, the platform range it needs and the modules it depends on, and every dependency it asks for.
  Exit `0` staged, `3` refused with every problem listed, `1` an environment error.
- **S4 Nothing is trusted, nothing runs.** No file of the package is imported, required, executed, built or
  type-checked during intake. Extraction refuses absolute paths, `..`, links of any kind, device and other
  special files, a second top-level folder, duplicate names (case-insensitively), `node_modules` and `.git`, and
  anything over the limits: archive 50 MB, unpacked 200 MB, 5,000 files, 255 characters per path.
- **S5 Integrity.** The archive's SHA-256 is computed by the platform. When `--sha256` is given it must match or
  the package is refused. The value is recorded.
- **S6 Dependencies are the platform's.** Assumption (the safe default): a module may not bring npm packages of
  its own. Each name in its `dependencies` and `peerDependencies` must already be installed in the platform and
  satisfy the declared range; otherwise the package is refused, naming the package. `scripts`, `bin` and
  lifecycle scripts are never run. Adopting a module that needs a new library means the owner adds that library
  to the platform deliberately.
- **S7 Consistency.** The package name, the manifest id and version, `manifest.json`, the files named by
  `pages[].entry` and `hooks`, and the migrations folder must agree with each other and with the platform's own
  manifest rules (the same validator the SDK uses).
- **S8 Audit.** Every intake is recorded in `core.module_packages` with who, when, size, SHA-256, id and
  version, and whether it was staged or refused and why. The archive is kept under
  `var/packages/<sha256>.tgz` and the unpacked tree under `var/staging/<sha256>/`; `var/` is not tracked.
- **S9 Nothing is installed.** `modules/`, the lifecycle state and the generated registry are not touched.
- **S10 Documentation.** The README explains the format, both commands and the policy above.

## Tasks

- [x] **T1** (S8) Migration `0006_module_packages.sql`, the store, and the `var/` locations. Route: inline. Commit `6cf0413`.
- [x] **T2** (S1, S4) Archive inspection and safe extraction with limits, tested with hand-made hostile
  tarballs. Route: inline. Risk: item 2 (it reads untrusted input). Commit `e3c2752`.
- [x] **T3** (S6, S7) Package validation: `package.json`, `manifest.json`, files, migrations, dependency
  policy, platform and `dependsOn` report. Route: inline. Risk: item 2. Commit `f7aa1d5`.
- [x] **T4** (S3, S5, S8, S9) The intake service: hash, stage, validate, record, review; idempotent. Route:
  inline. Commit `683b510`.
- [x] **T5** (S2, S3) The commands `modules pack` and `modules add`. Route: inline. Commit `6c7d64b`.
- [ ] **T6** (S4, S10) The "nothing runs" test over the whole path, README, independent verifier, native
  reviews. Route: inline plus verifier.

Forecast: about 1,300 authored changed lines; one slice per task.

## Log

- **L1** (2026-10-13, owner, verbatim): "se ve vien continuemos". Context: said after seeing the UI, in answer
  to the question of whether to do A4 now or users and roles first; read as "go on with the plan", and A4 is
  the next step of it. The earlier agreed plan for this stage (stage A4, package upload with checksum,
  automated build, restart, rollback, audit, admin only) and "install plus restart is fine" still hold.
- **L2** Decisions taken without asking, each with a safe default that can be loosened later and none of which
  changes what the owner asked for: A4 is split in three features (intake, install pipeline, screen); the package
  carries its manifest as data so it can be read without running it; a module cannot bring npm dependencies of
  its own (a package that needs one is refused, naming it, and the owner adds the library to the platform on
  purpose); nothing from a package executes during intake.
- **L3** (2026-10-13) The preview server used to show the UI was stopped before building (it serves the same
  `.next` that tests rebuild). Sign-in was left switched off in the project database; the server is bound to
  loopback whenever started, so it only serves the machine itself until an administrator is created and
  `auth require` is run.
