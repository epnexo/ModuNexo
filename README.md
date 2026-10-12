# epnexo platform

A module platform: a small core that installs, enables, disables, upgrades and uninstalls
modules, each living in its own repository. This repository holds the core and the SDK that
modules compile against. The feature plan lives in `odd/tasks/`.

## Layout

- `packages/sdk` - `@epnexo/sdk`: module manifest v2 types, `defineModule`, `validateManifest`.
  No database access.
- `packages/core` - `@epnexo/core`: the platform core. Today it holds the module `Registry`
  (manifest validation, `platform` and `dependsOn` range checks, dependency order, dependents
  lookup) and the core's own manifest; the migration runner, lifecycle and CLI follow.
- `modules/` - installed module packages, one folder per module. Not tracked in git.
- `apps/` - applications built on the core.

Everything is TypeScript consumed from source; there is no build step for packages.

## Commands

```bash
npm install
npm test          # node:test through tsx, packages/*/test/**/*.test.ts
npm run typecheck # tsc --noEmit
```

Configuration is read from `.env` (copy `.env.example`): `DATABASE_URL` and `TEST_DATABASE_URL`.
`docker-compose.yml` defines a local Postgres 16 on `127.0.0.1:5436`.
