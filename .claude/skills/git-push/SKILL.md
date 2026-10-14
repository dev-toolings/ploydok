---
name: git-push
description: Stage every change in the Ploydok worktree, write one English Conventional Commit that describes the current git status and diff, then push the current branch. Use only when the user invokes /git-push or explicitly asks to "add, commit and push" everything in one go. Do not use for partial commits, amends, or pushes the user did not ask for.
---

# git-push

## Goal

Ship the whole working tree in one step: `git add .`, a single English commit
that accurately summarizes what changed, then `git push` of the current branch.

Invoking this skill is the user's explicit authorization to stage everything
and push. It overrides the repo rule against `git add .` for this run only.
Every other rule in `.claude/rules/commits.md` still applies.

## Boundaries

- Run from the repository root (`/home/kev/lab/tools/ploydok`).
- Before staging, read `git status --porcelain`. Stop and report, without
  committing, if it lists anything that must never be committed: `.env*`
  files other than `.env.example`, `test-results/`, `playwright-report/`,
  database dumps (`*.sql`, `*.dump`) outside `packages/db/migrations/`,
  private keys or certificates (`*.pem`, `*.key`), or build output
  (`dist/`, `.output/`, `target/`). Nothing to commit also means stop.
- One commit, never more, never an amend. Never `--no-verify`, never
  `--force`. If a hook fails, report its output and stop; fix nothing silently.
- Never push to a branch other than the current one, and never force-push.
  If the branch has no upstream, use `git push -u origin <branch>`.
  If the push is rejected (remote ahead), stop and report; do not pull,
  rebase or merge on your own.

## Commit message

Base it on the staged diff (`git diff --cached --stat` and the diff itself),
not only on file names.

- English, Conventional Commits: `<type>(<scope>): <subject>`.
  Types: `feat` `fix` `chore` `docs` `refactor` `test` `ci` `perf` `build`
  `style`. Scopes: `api`, `web`, `db`, `ui`, `shared`, `agent`, `infra`,
  `auth`, `ci`, `lint`. Omit the scope when the change spans several.
- Subject: imperative, lowercase, no trailing period, 72 characters max.
- When the diff covers several topics, the subject names the main one and
  the body lists the others as short `- ` bullets.
- No em dash inside a sentence.
- Always sign off for the DCO: `git commit -s`.
- End the message with the attribution trailer the harness provides, if any.

## Verify and report

After pushing, run `git status -sb` and `git log -1 --stat`. Report to the
user, in their language: the commit hash and subject, the branch and remote
it went to, and the number of files. If any step stopped the flow, say which
one and paste the relevant output.
