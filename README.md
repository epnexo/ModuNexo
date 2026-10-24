<div align="center">

# ModuNexo

**A small, self-hosted core for running your business software as modules.**
Install, enable, upgrade and remove modules, each with its own code, database schema and permissions, from one web shell.

[![CI](https://github.com/epnexo/ModuNexo/actions/workflows/ci.yml/badge.svg)](https://github.com/epnexo/ModuNexo/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.3.0-0D9488)
![License](https://img.shields.io/badge/license-AGPL--3.0%20%2B%20module%20exception-162c4c)
![Node](https://img.shields.io/badge/node-%E2%89%A522.9-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

[Features](#features) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Build a module](#build-a-module) · [Documentation](#documentation) · [License](#license)

</div>

---

## Why ModuNexo

Small businesses end up with a CRM here, an inbox there and a spreadsheet in between. ModuNexo gives them one
platform with a single sign-in, one database and one place to manage everything, while each capability stays an
independent module that can be added, upgraded or removed without touching the rest.

- **Own your data.** Self-hosted, on PostgreSQL, with a documented backup and restore path.
- **Grow by modules.** The core ships no business logic. Modules live in their own repositories and install from a packed archive.
- **Keep your module yours.** The platform is AGPL-3.0 with a module exception: a module you write can have any license, proprietary included.

## Features

| | |
| --- | --- |
| **Module lifecycle** | Install, enable, disable, upgrade and uninstall, with dependency checks and a failure-safe flow. |
| **Isolated data** | Every module owns a Postgres schema and ships plain SQL migrations, checksummed and run under an advisory lock. |
| **Web shell** | Next.js app with sidebar, dashboard, settings, appearance and an Apps screen to manage modules. |
| **Access control** | Sign-in, roles, per-module permissions, service tokens and trusted-proxy handling. |
| **Dashboard** | Alerts and figures that modules declare, run read-only with a time limit under a restricted database role. |
| **Background work** | Jobs, events with realtime delivery, stored files and optional language-model access for modules. |
| **Typed SDK** | `@modunexo/sdk` with a validated manifest, `getDb`, `getSetting` and a scaffold command for new modules. |
| **Operations** | Health endpoint, logs, backup scripts, container image running as a non-root user, and CI on every push. |

## Quick start

### With Docker

```bash
export MODUNEXO_MASTER_KEY="$(openssl rand -base64 48)"   # keep it: it signs sessions and encrypts secrets
docker compose --profile app up -d --build                # database + web on 127.0.0.1:3000
docker compose exec web npm run modunexo -- admin create --email you@example.com --name "Your Name"
```

Open <http://127.0.0.1:3000> and sign in. Set `WEB_PUBLIC_URL` to your public `https` origin when the app sits
behind a TLS proxy.

### Setup

For development you need Node.js 22.9 or later and Docker for the database.

```bash
npm install
docker compose up -d db                                   # Postgres 16 on 127.0.0.1:5436
echo "DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo" > .env
echo "TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test" >> .env
echo "MODUNEXO_MASTER_KEY=$(openssl rand -base64 48)" >> .env
npm run db:migrate                                        # creates the core schema
npm run modunexo -- admin create --email you@example.com --name "Your Name"
npm run web:dev                                           # development server
```

Run the checks with `npm test` and `npm run typecheck`. With the database up, the suite reports 0 skipped.

## How it works

```mermaid
flowchart LR
    CLI[CLI] --> Core
    Shell[Web shell<br/>Next.js] --> Core
    subgraph Core[Core]
        direction TB
        Registry[Registry and lifecycle]
        Migrations[Migration runner]
        Codegen[Registration codegen]
    end
    Core --> DB[(PostgreSQL)]
    Core -. loads .-> M1[Module A<br/>own schema]
    Core -. loads .-> M2[Module B<br/>own schema]
```

The core never imports a module by name, and modules never import each other's code. A module declares what it
needs in a manifest (pages, navigation, settings, permissions, migrations, hooks), and the core generates the web
registration from the modules that are enabled.

| Path | What it is |
| --- | --- |
| `packages/sdk` | `@modunexo/sdk`: manifest types, `defineModule`, `validateManifest`, `getDb`, `getSetting` |
| `packages/core` | `@modunexo/core`: registry, migrations, lifecycle, registration codegen and the CLI |
| `apps/web` | The Next.js shell: dashboard, Apps, Status and Settings screens |
| `docs/` | Reference and architecture decision records |

## Build a module

```bash
npm run modunexo -- modules new field-notes --name "Field Notes"   # scaffold a working module
npm run modunexo -- modules pack modules-src/field-notes --out field-notes.tgz
npm run modunexo -- modules add field-notes.tgz --sha256 <hex>     # stage and review
npm run modunexo -- modules apply <hex>                            # install, rebuild, restart
```

A module is a package with a `manifest.ts`:

```ts
import { defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "field-notes",
  version: "1.0.0",
  name: "Field Notes",
  platform: "^0.1.0",                // SDK range the module supports
  dependsOn: {},
  schema: "field_notes",             // the Postgres schema this module owns
  migrationsDir: "migrations",
  nav: [{ label: "Field Notes", href: "/field-notes", icon: "documents", group: "Tools", order: 10 }],
  pages: [{ path: "/field-notes", entry: "./web/page.tsx", kind: "page" }],
});
```

Ready-made modules for an inbox and contacts live in [ModuNexo-modules](https://github.com/epnexo/ModuNexo-modules).
Installing a module is a trust decision: it runs with full access to the platform and its database, so the Apps
screen asks for explicit acknowledgement and shows the SHA-256 of the archive.

## Documentation

| Topic | Where |
| --- | --- |
| Full technical reference | [`docs/REFERENCE.md`](docs/REFERENCE.md) |
| Module contract, data access and lifecycle | [Building a module](docs/REFERENCE.md#building-a-module), [Module lifecycle](docs/REFERENCE.md#module-lifecycle) |
| CLI | [CLI](docs/REFERENCE.md#cli) |
| Web app, sign-in and permissions | [Web app](docs/REFERENCE.md#web-app), [Permissions](docs/REFERENCE.md#permissions-and-trusted-proxies) |
| Packages and the Apps screen | [Module packages](docs/REFERENCE.md#module-packages), [The Apps screen](docs/REFERENCE.md#the-apps-screen) |
| Backup, health and logs | [Operations](docs/REFERENCE.md#operations) |
| Hardening | [Hardening](docs/REFERENCE.md#hardening) |
| Architecture decisions | [`docs/adr`](docs/adr) |
| Release history and versioning | [`CHANGELOG.md`](CHANGELOG.md), [Versioning](docs/REFERENCE.md#versioning) |

## Contributing and security

Contributions are welcome: read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. To report a vulnerability, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## License

Copyright (C) 2026 Eduardo Pedraza.

- **Platform** (`apps/web`, `packages/core`): [GNU AGPL-3.0](LICENSE) with a module exception.
- **SDK** (`packages/sdk`): [MPL-2.0](packages/sdk/LICENSE).
- **Your modules**: yours, under any license you choose, proprietary included.

Details and the exception text are in [`LICENSING.md`](LICENSING.md).
