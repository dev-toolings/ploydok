# Testing — DoD avant "done"

Rappel CLAUDE.md : **aucun `git push` avant DoD sprint vérifiée bout en bout**. Type-check seul n'est **pas** suffisant.

## Boucle locale obligatoire

```bash
bun run typecheck      # turbo typecheck
bun run lint           # turbo lint (eslint + @tanstack/eslint-config)
bun test               # turbo test (bun test partout)
bun run check:spdx     # headers AGPL-3.0-only
```

Tous verts ⇒ passage possible aux e2e.

## Unit tests (Bun)

- Runner : `bun test` (pas vitest). Fichiers : `*.test.ts` à côté du code.
- Assertions : `expect` de bun. Mocks : `mock.module()` ou injection directe — **pas** de framework de mock lourd.
- API : tester les handlers Hono en montant l'app (`import { app } from "./app"`) et en appelant `app.request(...)`. Voir `apps/api/src/*.test.ts`.
- Web : `@testing-library/react` + `happy-dom`. Le composant doit marcher sans routeur réel quand possible — sinon mock `@tanstack/react-router`.

## E2E (Playwright)

- Config : `apps/web/playwright.config.ts`. Specs : `apps/web/e2e/`.
- `workers: 1`, `fullyParallel: false` — l'auth + la DB Postgres partagée ne tolèrent pas le parallélisme.
- Pré-requis : `make dev` tourne **et** `make infra-up` si le test touche Caddy/BuildKit/Registry.
- Specs Sprint-3 qui spawn des containers : timeout `180_000` ms par `describe`, pas global.
- Lancer : `bun --cwd apps/web exec playwright test` (ajouter `--ui` pour debug).

## Suites Postgres (`make test-pg`)

Les suites API qui lisent `PLOYDOK_TEST_PG_URL` (`*.pg.test.ts`, `*.e2e.test.ts`
et les blocs `describe.skipIf` de `routes/*.test.ts`, `auth/*.test.ts`,
`worker/*.test.ts`) sont **skippées en silence** quand la variable manque : un
`bun test` vert sans elle ne prouve rien sur les leases, l'outbox ou le
reconciler. Avant de dire "done" sur un changement DB/worker :

```bash
make test-pg   # cree ploydok_test sur le Postgres dev si besoin, puis 1 fichier = 1 process
```

Le script `scripts/test-pg.ts` dérive `PLOYDOK_TEST_PG_URL` (base
`ploydok_test`) et `PLOYDOK_TEST_REDIS_URL` (db `15`) de `.env.local` ; les
exporter à la main pour viser une autre base. Les migrations sont appliquées
par `apps/api/src/test/db-helpers.ts`. Ne jamais pointer la base de dev.

## E2E API (server.e2e.test.ts)

- `apps/api/src/server.e2e.test.ts` et `apps/api/src/auth/auth.e2e.test.ts` démarrent un vrai serveur Hono sur un port random — garder isolé du runner unit pour ne pas fuiter.

## Cleanup containers e2e — obligatoire

Les specs Playwright qui spawn des containers (`deploy-image.spec.ts`, `cross-project-blocked.spec.ts`, `same-project-allowed.spec.ts`, etc.) laissent derrière elles des `ploydok-app-e2e-*` et `ploydok-app-iso-*` dans Docker (le blue/green switch n'est pas déclenché en test, donc le slot `-blue` reste debout).

À la fin de toute session qui a lancé des e2e (`make dod`, `playwright test`, spec ad-hoc), **toujours** purger :

```bash
docker ps -a --filter "name=ploydok-app-e2e-" --filter "name=ploydok-app-iso-" -q | xargs -r docker rm -f
```

Règles :

- Ne jamais toucher aux containers `ploydok-app-*-green` sans suffixe `e2e-` / `iso-` — ce sont de vraies apps déployées.
- Si on ajoute une nouvelle spec qui spawn un container, préfixer le nom par `e2e-` ou `iso-` pour qu'il soit capturé par le filtre ci-dessus.
- Idéalement câbler le cleanup dans un `afterAll` / `test.afterEach` de la spec, mais le purge manuel reste le filet de sécurité.

## SPDX

- Tout `.ts`, `.tsx`, `.rs` dans `apps/`, `packages/`, `agent/`, `scripts/` doit commencer par :
  ```ts
  // SPDX-License-Identifier: AGPL-3.0-only
  ```
- Ignorés : `*.gen.ts`, `routeTree.gen.ts`, `target/`, `dist/`, `.turbo/`, `.output/`, `node_modules/`.
- CI bloque sur `bun run check:spdx`.

## Régression UI

Les changements front doivent être testés dans un vrai browser avant "done" (screenshot ou Playwright). Le type-check ne prouve pas qu'un bouton marche.
