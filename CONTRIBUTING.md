# Contributing to Ploydok

Thanks for your interest in Ploydok. This project is AGPL-3.0-only — by contributing you agree your work is licensed under the same terms.

## Setup

```bash
bun install
make infra-up
make db-ensure-auth
make db-migrate
make dev          # runs web + api after local infrastructure is ready
```

Requirements: Bun 1.3, Node.js 22 or newer for tooling, Docker, and Rust stable
when changing the agent or host CLI.

## Developer Certificate of Origin (DCO)

All commits must be **signed-off**:

```bash
git commit -s -m "feat(foo): do the thing"
```

This appends a `Signed-off-by:` trailer certifying you have the right to submit the contribution under AGPL-3.0-only (see https://developercertificate.org).

PRs with unsigned commits will be blocked by CI.

## Commit style

Conventional Commits:

- `feat(scope): …` — new feature
- `fix(scope): …` — bug fix
- `chore(scope): …` — tooling, deps
- `docs(scope): …` — docs only
- `refactor(scope): …` — no behavior change
- `test(scope): …` — tests only
- `ci(scope): …` — CI / workflows

One focused change per commit when reasonable.

## SPDX headers

Every source file (`.ts`, `.tsx`, `.rs`) must start with:

```ts
// SPDX-License-Identifier: AGPL-3.0-only
```

The `scripts/check-spdx.ts` linter enforces this in CI. Run it locally with `bun run check:spdx`.

## Branches

- `develop` is the integration branch. Branch from it and open PRs against it.
- `main` is the release branch: it only receives `develop` at release time.
- Name branches `<type>/<issue>-<short-slug>` (for example
  `fix/DEV-333-backup-schedule`) or `<type>/<short-slug>` without an issue.
- CI currently runs on `main` only. On `develop`, list the local checks you
  ran in the PR's test plan.

## Pull requests

- Open one PR per focused change, targeting `develop`
- Ensure `bun run lint`, `bun run typecheck`, `bun test`, and
  `bun run check:spdx` all pass
- Update docs when behavior changes
- Add or update tests for any code change
- Reference the relevant `PRD-PLAN.md` item or issue in the PR description

## Security

Do **not** open issues for security bugs. See [SECURITY.md](./SECURITY.md).

## Code of Conduct

This project adheres to the Contributor Covenant 2.1. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
