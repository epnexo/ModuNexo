# Licensing

Copyright (C) 2026 Eduardo Pedraza.

| Part | License | File |
|---|---|---|
| The platform: `apps/web`, `packages/core`, `scripts`, the container files | GNU AGPL-3.0-only, plus the module exception below | [`LICENSE`](LICENSE) |
| The module SDK: `packages/sdk` | MPL-2.0 | [`packages/sdk/LICENSE`](packages/sdk/LICENSE) |
| A module you write (a folder with a `manifest.ts`, created with `modules new`) | **Yours.** Any license you choose, proprietary included | none required |

## What this means

- **Improving the platform.** If you modify the platform and let people use your modified version, over a network
  included, you must offer them the source of your changes under the AGPL. That is the AGPL's own rule, and the
  point of using it: improvements to the base come back to the community.
- **Improving the SDK.** Changes to the files of `packages/sdk` stay under the MPL-2.0 (file-level copyleft). A module
  that only imports the SDK is not a change to it.
- **Writing modules.** A module that talks to the platform only through the public contract does not have to be open
  source, and nobody who uses it is owed its source. You (or your client) pick its license.

## Module exception (additional permission under section 7 of the GNU AGPL, version 3)

As a special exception, the copyright holder gives you permission to combine the platform with a Module and to run,
modify and convey the combination, and to license the Module under terms of your choice, including proprietary terms,
without the AGPL applying to the Module and without any duty to offer the Module's source to users of the platform.

A **Module** is a work that:

1. is packaged as the platform's module contract describes (a `manifest.ts`, optional migrations, optional pages,
   routes and hooks, as documented in the README under "The module contract");
2. uses the platform only through that contract and through the exports of `@modunexo/sdk` (`defineModule`, `getDb`,
   `getSetting` and the rest of the package); and
3. contains no file of the platform (`apps/web`, `packages/core`) and does not modify one.

This exception covers the Module only. It does not cover your modifications to the platform itself, which remain
under the AGPL, and it does not remove the AGPL's conditions for the platform's own files. If you convey a modified
version of the platform, you may extend this exception to your version, but you are not required to.

## Third-party software

The platform depends on open-source packages that keep their own licenses. Checked on the installed tree: almost all
are MIT, ISC, Apache-2.0 or BSD (Next.js, React, Better Auth, `pg`, Kysely). The exceptions are used unmodified and
none conflicts with the AGPL or the MPL:

- `@img/sharp-libvips-*` (LGPL-3.0-or-later): a native library that Next.js loads for image optimization.
- `lightningcss` (MPL-2.0): a build tool pulled in by Tailwind CSS.
- `caniuse-lite` (CC-BY-4.0): browser-support data, with attribution.
- `geist` (SIL Open Font License 1.1): the typeface.

`package-lock.json` is the list of what is installed; each package carries its own license file.

## A note on this document

This is the project's statement of intent, not legal advice. Whoever depends on the module boundary for a business
should have a lawyer read the exception above once.
