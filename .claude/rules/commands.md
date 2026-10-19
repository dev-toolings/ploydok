# Commandes & ports

## Ports réservés (ne pas utiliser 80/443/3000)

| Service                   | Port / socket                                   |
| ------------------------- | ----------------------------------------------- |
| API (Hono)                | `http://localhost:3335`                         |
| Web (Vite/TanStack Start) | `http://localhost:5173`                         |
| Postgres                  | `127.0.0.1:5434` (container `ploydok-postgres`) |
| Redis                     | `127.0.0.1:6381` (container `ploydok-redis`)    |
| Caddy data                | `8181` (http) / `8543` (https)                  |
| Caddy admin               | `http://127.0.0.1:2020/config/`                 |
| BuildKit                  | builder buildx `ploydok-dev` (`buildx://ploydok-dev`, réseau `ploydok_ploydok`) |
| Registry v2               | `http://127.0.0.1:5000/v2/`                     |
| Agent Rust                | `unix:///tmp/ploydok/agent.sock`                |

## Domaine des apps en dev

Base par défaut : **`demo.localhost`** (`deriveDefaultAppDomainBase`, `apps/api/src/routes/apps.ts`).
Une app déployée est donc joignable sur `http://<slug>-<id>.demo.localhost:8181/`.

`.localhost` résout vers la loopback sans DNS ni `/etc/hosts`, wildcards compris.
Ne **pas** revenir à un TLD `.local` : la plupart des `nsswitch.conf` Linux routent
ces noms vers mDNS avec `[NOTFOUND=return]`, la résolution s'arrête là et n'atteint
jamais le resolver DNS. Caddy sert correctement, mais le navigateur n'arrive pas.

Domaines créés avant la bascule : `bun run scripts/rebase-dev-domains.ts --apply`
(réécrit `apps.domain` + `domains.hostname` et repatche la route Caddy ; dry run par défaut).

## Processus dev — interdits pour Claude

**Ne jamais lancer, build-watch, ni tuer les process longs** : `make install`, `make dev`, `bun run dev`, `bun run --watch`, `nohup` API/web, `kill` d'un process dev. Seul l'utilisateur s'en charge. `make install` enchaîne sur `make dev` à la fin : il reste au premier plan, donc il est interdit lui aussi. Claude peut :

- **Proposer** la commande à taper (ex. : « relance `make dev` dans un autre shell »).
- **Lancer** des one-shots : `bun test`, `bun run typecheck`, `bun run lint`, `make check`, `make db-ensure-auth`, `make db-migrate`, `curl` contre un serveur déjà up. Pour rejouer le setup sans démarrer les serveurs : `make infra-up && make db-ensure-auth && make db-migrate && make check`.

Si une vérif nécessite que le serveur tourne, d'abord **demander** si API:3335 / Web:5173 est up — ne pas le démarrer soi-même.

## Makefile (source de vérité pour le dev)

```bash
make install        # setup complet PUIS démarrage : deps + infra + auth + migrations + check + dev
make check          # sonde toute la stack (TCP/HTTP/socket) + affiche l'URL /setup avec son token
make dev            # turbo dev → web:5173 + api:3335
make dev-agent      # agent Rust (insecure, socket /tmp/ploydok/agent.sock)
make db-ensure-auth # attend Postgres + réaligne le rôle si le volume a dérivé
make db-migrate     # drizzle-kit migrate sur Postgres (DATABASE_URL de .env.local)
make reset          # wipe containers runtime + schemas Postgres + Redis, puis réapplique les migrations
make db-seed        # seed dev (dev@ploydok.local / backup code DEVD-EVDE-VDEV)
make secrets-init  # génère PLOYDOK_PG_PASSWORD/REDIS + DATABASE_URL/REDIS_URL + PLOYDOK_SETUP_TOKEN + PLOYDOK_STATIC_ROOT dans .env.local
make infra-up      # docker compose : postgres + redis + caddy + registry + agent, puis builder buildx ploydok-dev
make infra-down    # cleanup infra
make infra-logs    # tail logs caddy
make dod           # lance les 11 specs Playwright DoD Sprint 3 (requiert infra + agent + dev up)
make build | test | lint | typecheck | clean
```

## Workspace (Bun + Turbo uniquement — jamais npm/pnpm/yarn)

```bash
bun install                       # racine
bun --cwd apps/api run dev        # API seule
bun --cwd apps/web run dev        # Web seule
bun --cwd packages/db run migrate
bun --cwd packages/db run seed
bun run check:spdx                # lint SPDX headers
```

Turbo délègue `build|lint|typecheck|test|dev` via `turbo.json`. Tâche `test` dépend de `^build`.

## Secrets dev

`apps/api/.env.local` (gitignored). **Ne jamais régénérer `SESSION_SECRET` sans prévenir** — ça invalide tous les JWT existants. Variables parsées par `apps/api/src/env.ts` (Zod).

`PLOYDOK_SETUP_TOKEN` (généré par `make secrets-init`, ≥ 16 caractères) fige le token du wizard `/setup` : sans lui l'API en tire un aléatoire de 30 min, imprimé une seule fois dans ses logs. L'API le lit **au boot** — si tu l'ajoutes pendant que `make dev` tourne, relance `make dev`.

`PLOYDOK_STATIC_ROOT` / `PLOYDOK_CADDY_STATIC_ROOT` (générés eux aussi par `make secrets-init`) sont lus **à la fois** par l'API et par `docker compose --env-file apps/api/.env.local` : la première fixe le dossier hôte où le worker publie les sites statiques, la seconde le chemin que Caddy voit. Les changer impose `make infra-down && make infra-up` (le bind mount de Caddy en dépend) puis un redémarrage de `make dev`. Détail dans `.claude/rules/infra.md` § Sites statiques.

En dev, `http://localhost:5173/setup` s'ouvre **sans query string** : la page appelle `POST /auth/setup/session` et l'API dépose le token dans le cookie `ploydok_setup`. Voir `.claude/rules/auth.md` § Setup session pour les trois garde-fous (hors prod, CSRF, Origin).
