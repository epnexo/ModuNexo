# Security policy

## Reporting a vulnerability

Report it privately: on GitHub, use **Security > Report a vulnerability** (private vulnerability reporting) on this repository. Do not open a public issue or pull request that describes it. Include what you
found, how to reproduce it, and which version or commit you tested. You will get an acknowledgement, and a fix or a
mitigation plan, before anything is disclosed.

## What the platform does and does not protect

- Sign-in uses Better Auth with a secret derived from `MODUNEXO_MASTER_KEY`; stored settings marked secret are encrypted
  with the same key. Keep the key outside the repository and outside the backups (see the README, "Backup and restore").
- A module runs in the web app's own process with the same privileges as the platform. A module package is checked for
  integrity (SHA-256) and shown to the administrator for confirmation before it is installed, but that proves it was not
  altered, not who wrote it. **Install only modules you trust.**
- Module database access (`getDb`) is scoped to the module's own schema and read-only across modules by contract, not by
  sandbox. See the README, "Building a module".
- With sign-in disabled the app answers only the local network. Do not expose it to the internet in that mode.

## Supported versions

Only the latest commit on the main branch receives fixes.
