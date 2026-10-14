# AGENTS.md — Ploydok

This file is the repo-level agent guide for Codex-style coding agents. Keep it focused on durable, repo-specific instructions: how the codebase is organized, which commands are safe, what must be validated, and which invariants must not be broken.

## Scope And Precedence

- This file applies to the whole repository.
- If a deeper `AGENTS.md` exists in a subdirectory, the deeper file takes precedence for files under that subtree.
- Direct user or system instructions override this file.

## Références externes (benchmark UX/feature parity)

Deux repos clonés localement servent de référence pour aligner Ploydok sur l'état de l'art self-hosted PaaS. À consulter avant de concevoir une nouvelle feature, refondre la sidebar, ou trancher un choix UX :

- `/tmp/dokploy` — Dokploy (Next.js + tRPC + Drizzle + Docker Swarm). Cible principale pour la sidebar, l'orga des routes, le découpage des settings, et les flows app/database/compose.
- `/tmp/coolify` — Coolify (Laravel + Livewire + PHP). Cible pour la richesse fonctionnelle (notifications, destinations, sources, teams, backups, terminal in-browser, S3 storages).

Règles d'usage :

- Ne **jamais** copier-coller du code (licences différentes, stacks différentes). Lire pour s'inspirer du modèle, pas pour le porter.
- Quand on cite une idée venant de l'un des deux, le préciser dans le commit/PR (`Inspired by dokploy/<path>`).
- Si l'un des deux clones manque, le re-cloner : `git clone --depth 1 https://github.com/Dokploy/dokploy.git /tmp/dokploy` et `git clone --depth 1 https://github.com/coollabsio/coolify.git /tmp/coolify`.

## Repository Shape

- Monorepo layout:
  - `apps/web`: TanStack Start + TanStack Router frontend
  - `apps/api`: API server
  - `packages/*`: shared packages
  - `agent/*`: Rust agent / CLI
  - `infra/*`: local infra and deployment helpers
  - `installer/*`: VPS installer and host descriptors
  - `scripts/*`: one-shot tooling and validation scripts
- Frontend tests:
  - unit/light integration tests live in `apps/web/src/tests`
  - Playwright e2e tests live in `apps/web/e2e`

## Search And Read Workflow

- Prefer `ig` over `rg` or `grep` for repo search.
- Useful commands:
  - `ig "pattern" apps/web`
  - `ig read path/to/file --signatures`
  - `ig smart apps/web/src`
  - read `.ig/context.md` for a repo overview before broad exploration
- Fall back to `rg` only if `ig` is unavailable or insufficient.

## Non-Negotiable Runtime Rules

- Do not start, restart, or kill long-running dev servers.
- Forbidden examples:
  - `make dev`
  - `bun run dev`
  - `bun run build --watch`
  - `nohup ...`
  - killing the API or web dev process
- The user owns long-running processes. If a restart is needed, tell the user which command to run instead of doing it yourself.
- Safe one-shot commands are allowed: typecheck, unit tests, lint, targeted scripts, migrations, `curl` against an already-running service.

## Local Environment Facts

- Reserved local ports:
  - API: `3335`
  - Web: `5173`
  - Caddy: `8181`, `8543`, `2020`
- Agent socket: `/tmp/ploydok-agent.sock`
- Do not touch ports `80`, `443`, or `3000` on this machine.
- Local dev secrets live in `apps/api/.env.local`.
- Do not regenerate local auth secrets unless the user explicitly asks; that invalidates active JWTs/sessions.

## Auth And SSR Invariants

- Auth cookies:
  - `ploydok_access`: 10 minutes, HttpOnly
  - `ploydok_refresh`: 7 days, HttpOnly
  - `SameSite=Lax`
  - `Secure` only in production
- Refresh flow:
  - frontend auto-retries exactly once on `401` via `/auth/refresh`
  - `/auth/refresh` is exempt from CSRF server-side because it relies on the refresh cookie
- SSR in `apps/web`:
  - `apiFetch` must forward request cookies through `@tanstack/react-start/server`
  - auth decisions in route guards must remain request-scoped in SSR
  - `GET /me` deduplication is allowed on the client, but must not leak across SSR requests
- Route guard semantics:
  - `401` / expired session => auth redirect
  - infra errors (`5xx`, network, malformed response) => surface to error boundaries, not fake-login redirects

## Code Placement And Change Style

- Keep changes local to the subsystem you are modifying.
- Prefer extending existing modules over creating parallel abstractions.
- Do not introduce state management libraries or app-wide context unless there is a clear, demonstrated need.
- For frontend state:
  - prefer local state first
  - use existing query/cache mechanisms before adding new global state
  - use Zustand only if a shared client store is genuinely required
- Remove dead code created by your change. Do not leave behind unused helpers, compatibility shims, or stale tests.

## Typography (mandatory)

- Use locally loaded **Inter Variable** throughout the interface, including
  headings, forms, buttons, navigation, tables, dialogs, and charts.
- Shared font tokens live in `packages/ui/src/styles/globals.css`.
  `font-sans` and `font-heading` must resolve to the same Inter stack.
- Reserve **JetBrains Mono Variable** for code, logs, terminals, secrets, and
  technical identifiers. Ordinary labels, badges, and counters use Inter.
- Do not introduce per-component font stacks or external font CDNs.
- Follow `.claude/rules/style.md` for the complete typography policy and verify
  that the font files actually load in the browser.

## Button Loading State (mandatory)

Any button that fires a state-changing request must show an in-button spinner while that request is in flight. A click with no visual feedback is a bug, not a detail.

- Use the shared primitive: `<Button loading={mutation.isPending}>`. `loading` renders the spinner, disables the button, and sets `aria-busy`. Source: `packages/ui/src/components/button.tsx`.
- Applies to: `POST`, `PUT`, `PATCH`, `DELETE`, form submits, and any explicitly user-triggered async action (deploy, sync, revoke, reset, import). Includes actions that end in a redirect: the spinner covers the round trip before the browser navigates.
- Does not apply to: pure navigation (links, tabs, `asChild` anchors), local UI toggles (open a dialog, expand a form), and background refetches the user did not trigger.
- Read-only exception: an explicit "Refresh" button may use `loading={isFetching}`. Automatic polling must never spin a button.
- Do not hand-roll `animate-spin` inside a `Button`. Leave the idle icon in place: the primitive hides every non-spinner icon while loading, so exactly one spinner shows.
- Do not pass `disabled={isPending}` alongside `loading={isPending}`. `loading` already disables. Keep `disabled` for the other reasons only, such as an invalid form.
- Keep or swap the label (`Save` becomes `Saving...`), but never leave the button visually idle.
- `asChild` buttons get no injected spinner (Radix `Slot` accepts a single child). If an anchor-shaped action needs a pending state, render a real `button`.

### Pending state must cover the navigation, not just the mutation

The perceived wait ends when the next page paints, not when the request resolves. A pending flag released at the mutation boundary flashes and is worse than none.

- Use `usePendingAction` (`apps/web/src/lib/hooks/use-pending-action.ts`) for any action that navigates. It floors the pending window at 500ms and lets it run to the end of the navigation: `await run()` does not settle before the floor, so a caller that navigates afterwards inherits the guarantee.
- `keepPendingOnSuccess` for anything that leaves the page (full-page redirect, `router.navigate`): the flag must never fall back to idle before the component unmounts.
- A code path that navigates **without** any mutation still needs a pending state. An early `return` that just routes is the most common source of a dead click.
- An async `onSuccess` callback must be awaited before releasing the pending flag. Firing it with `void` and releasing in `finally` re-enables the button while the app is still working, and lets the user click twice.
- Every client navigation is also covered globally by `NavigationProgress` (`apps/web/src/components/layout/NavigationProgress.tsx`), mounted in `__root.tsx`. It reads `useRouterState({ select: (s) => s.isLoading })`. Do not use `s.isTransitioning`: it exists in the router types but is never set in this build.
- A confirm button inside an `AlertDialog` unmounts with the dialog on click, so its spinner is never seen. Put the pending state on the trigger, which stays on screen.

## i18n (mandatory)

`apps/web` is localized EN/FR via i18next. Cookie `ploydok-locale`. Catalogs: `apps/web/src/locales/{en,fr}/*.json`. Detail: `.claude/rules/i18n.md`.

- Any **new or changed** user-visible copy (JSX, toasts, aria-labels, placeholders, empty states, nav, command palette) must go through `t()` / `i18n.t()`. Do not leave a hardcoded English or French string in the UI.
- Add the key to **both** `en` and `fr` of the matching namespace in the same change. Identical `{{var}}` interpolations. No empty values.
- Do not translate: env var names, technical tokens (`Dockerfile`, `TOTP`, `OAuth`), raw logs, comments, changelog markdown, unmapped API `error.message`.
- Dialog/Sheet close labels: use the wrappers in `apps/web/src/components/i18n/` (they inject `t("common:close")`). Do not import i18next from `@workspace/ui`.
- After catalog edits, from `apps/web`: `bun test src/lib/i18n/`.

## Validation Commands

- Prefer targeted validation for the area you changed before broader checks.
- Common web commands:
  - `bun test apps/web/src/tests/`
  - `bunx tsc -p apps/web/tsconfig.json --noEmit`
- Monorepo/root commands may exist, but do not run broad expensive suites unless the task warrants it.
- Before any push or PR-style completion, the relevant Definition of Done must be satisfied with real validation, not just inspection.

## Database Migrations

- Before introducing schema-dependent code, verify the migration exists, is listed in `packages/db/migrations/meta/_journal.json`, and has a strictly newer `when` than migrations already applied in the target local database.
- After adding or changing migrations, run `bun --env-file=apps/api/.env.local run db:migrate` against the local dev database when the task is meant to be testable locally.
- After migration, verify the real database shape, not only TypeScript schema files. Use `information_schema.columns` / `information_schema.tables` or a targeted query against the new columns/tables.
- If a schema object was added in a migration whose journal `when` is older than already-applied migrations, add a new idempotent drift-repair migration instead of editing history that may already be applied elsewhere.
- For API routes that select whole tables, test at least one real query path after migration; missing columns should be caught before handing back UI work.

## Git Workflow (develop-based)

```text
.---------------------------.
|  main : release branch    |
|  CI on, no direct work    |
'-------------+-------------'
              ^
              | merge develop, only on explicit release request
              |
.-------------+-------------.
| develop : integration     |
| CI OFF for now            |
'-------------+-------------'
       ^                ^
       | merge --no-ff  | merge --no-ff
       |                |
.------+--------.  .----+------------.
| feat/DEV-333- |  | fix/<slug>      |
| <slug>        |  | docs/<slug> ... |
| (OpenTrack)   |  | (custom)        |
'---------------'  '-----------------'
```

- Never commit on `main`. `main` only receives `develop` when the user asks
  for a release. CI (`ci.yml`, `ci-integration.yml`, `release-images.yml`)
  runs on `main` only.
- Start every task from an up-to-date `develop`
  (`git fetch origin && git switch develop && git pull --ff-only`), then
  create a dedicated branch. Do not commit directly on `develop` either.
- Branch names, always created from `develop`:
  - OpenTrack issue: `<type>/DEV-<n>-<short-slug>`, e.g.
    `fix/DEV-333-backup-schedule`. Reference the issue in the commit body
    (`Refs DEV-333`).
  - Work without an issue: `<type>/<short-slug>`, e.g. `docs/git-workflow`.
  - `<type>` is the Conventional Commit type: `feat`, `fix`, `chore`,
    `docs`, `refactor`, `test`, `perf`, `ci`.
  - A problem found along the way gets its own `fix/<slug>` branch from
    `develop`, never folded into the current branch.
- CI does not run on `develop` yet, so local validation is the merge gate.
  Before merging a branch into `develop`, run the checks for what it touches
  (see Validation Commands and `.claude/rules/testing.md`): API tests one
  file per process (`bun run test` in `apps/api`), `tsc` for api/web,
  `bun run check:spdx`, `bun run scripts/check-migrations.ts`, `cargo test`
  for `agent/`. Report what ran and what did not.
- Integrate with `git merge --no-ff <branch>` into `develop` (or a PR into
  `develop`). Never rebase or force-push a shared branch.
- Pushing: work branches and `develop` may be pushed once validated and the
  user asked to push. `main` is pushed only as part of a release request.
- After merge, delete the local branch; delete the remote branch once the
  user no longer needs it. Remove temporary worktrees.
- Migrations from two branches: when the target already has the same
  `NNNN` index, renumber the incoming migrations after the target's last
  journal entry with a strictly newer `when`, and keep them idempotent.
  Never renumber migrations already merged into `develop` or `main`.

## Git And Delivery Rules

- Branches follow the Git Workflow above; do not create branches outside it.
- Do not amend existing commits unless explicitly asked.
- Do not revert unrelated user changes.
- Keep the worktree intentional and easy to review.
- If you used a temporary Claude/Codex worktree under `.claude/worktrees/*` for implementation, remove it once the work is finished and no handoff still depends on it.
- If you are preparing code for handoff, summarize exactly what was validated and what was not.

## Repo-Specific References

- Read these only when relevant to the task:
  - `.claude/rules/commands.md`
  - `.claude/rules/monorepo.md`
  - `.claude/rules/auth.md`
  - `.claude/rules/db.md`
  - `.claude/rules/testing.md`
  - `.claude/rules/commits.md`
  - `.claude/rules/style.md`
  - `.claude/rules/agent-rust.md`
  - `.claude/rules/infra.md`
  - `.claude/rules/i18n.md`

## What Good Agent Work Looks Like Here

- Search the real code before deciding.
- Respect the auth and SSR invariants above.
- Make small, reviewable patches.
- Add or update regression tests when fixing logic bugs.
- Prefer precise commands and concrete file references over generic advice.
