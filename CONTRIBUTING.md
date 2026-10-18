# Contributing

Thanks for helping. A few rules keep the project healthy and its license intact.

## Licensing of contributions

By contributing you agree that your contribution is licensed under the terms of the part you change (see
[`LICENSING.md`](LICENSING.md)): AGPL-3.0-only with the module exception for the platform, MPL-2.0 for `packages/sdk`.
You also confirm the [Developer Certificate of Origin](https://developercertificate.org): you wrote it, or you have the
right to submit it. Sign every commit off with `git commit -s`, which adds a `Signed-off-by:` line.

Do not submit code you did not write or that comes from a project with an incompatible license.

## Before you open a pull request

```bash
docker compose up -d db
export TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test
npm run typecheck
npm test
```

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`).
- A behaviour change comes with its test and its documentation. Add or change a command, option or message: update the
  help text and the README too.
- Security issues go through [`SECURITY.md`](SECURITY.md), not a public issue.
