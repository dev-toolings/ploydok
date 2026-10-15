# DB — Drizzle + Postgres

DB de dev : **Postgres** dans le container `ploydok-postgres` (image `postgres`), exposé sur `127.0.0.1:5434`. Creds générés par `make secrets-init` dans `apps/api/.env.local` (var `DATABASE_URL`). Plus de SQLite — la migration vers Postgres a été faite au sprint-3bis-pg.

## Pré-requis dev

```bash
make secrets-init    # génère PLOYDOK_PG_PASSWORD + DATABASE_URL dans .env.local
make infra-up        # docker compose : postgres + redis + caddy + registry + agent
make db-ensure-auth  # attend Postgres + réaligne le rôle si le volume a dérivé
make db-migrate      # applique les migrations sur Postgres
```

## Dérive du mot de passe Postgres

`POSTGRES_PASSWORD` n'est appliqué qu'au **premier `initdb`**, sur un `PGDATA` vide. Si le volume `ploydok_postgres-data` survit à une rotation de `PLOYDOK_PG_PASSWORD`, le hash SCRAM de `pg_authid` reste sur l'ancienne valeur et toute connexion TCP échoue en `28P01`, alors que `pg_isready` et `docker exec psql` répondent OK (loopback en `trust` dans `pg_hba.conf`).

`make db-ensure-auth` (`scripts/db-ensure-auth.ts`) sonde la vraie URL, et sur `28P01` réaligne le rôle par `ALTER ROLE` via le socket local du service compose. Les données sont préservées. Ne **jamais** régler ce symptôme en supprimant le volume : c'est la DB de dev complète qui part.

## Workflow modif schema

1. Édite le schema : `packages/db/src/schema/*.ts` (un fichier par domaine : `apps.ts`, `auth.ts`, …).
2. Expose dans `packages/db/src/schema/index.ts`.
3. Génère la migration : `bun --cwd packages/db run generate` (dialecte `postgresql` via drizzle-kit).
4. Relis le SQL produit dans `packages/db/migrations/NNNN_*.sql` — drizzle-kit peut générer des DROP surprenants. Corrige à la main si besoin.
5. Applique : `make db-migrate` (wrapper qui source `.env.local` avant `bun --cwd packages/db run migrate`).
6. Commit **schema + migration ensemble** dans le même commit.

## Queries

- **Toutes** les queries cross-routes vivent dans `packages/db/src/queries/` et sont importées via `@ploydok/db/queries`. Il n'existe plus de couche `apps/api/src/queries/`.
- Les fichiers dans `packages/db/src/queries/` importent uniquement depuis `../schema`, `../client`, `drizzle-orm`, ou des libs standard — jamais depuis `@ploydok/db` (évite la référence circulaire).
- Exposés dans `packages/db/src/queries/index.ts` et accessibles via le subpath export `@ploydok/db/queries`.
- Toujours typer le retour — pas de `any` sur un `.select()`.
- Préfère `db.transaction()` pour toute séquence read-then-write.
- Client : `postgres` (porsager) via Drizzle — pas de pool custom, le driver gère.

## Migrations

- Fichiers versionnés dans `packages/db/migrations/`. Le journal `meta/_journal.json` est managed par drizzle-kit.
- **Jamais** éditer une migration déjà appliquée en prod — en créer une nouvelle.
- Seed dev : `make db-seed` (ou `bun --cwd packages/db run seed`) — 1 user `dev@ploydok.local` + 1 project + backup code fixe `DEVD-EVDE-VDEV`.

## Tests

- Tests unitaires schema/queries : à côté du code (`*.test.ts`). Mock Drizzle à la frontière plutôt qu'une DB réelle.
- Tests d'intégration qui touchent la vraie DB Postgres : marquer `*.e2e.test.ts` et requièrent `make infra-up` + migrations appliquées.
