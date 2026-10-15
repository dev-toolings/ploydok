# Infra locale (`infra/`)

Docker Compose orchestre le control-plane local pour le développement :

| Service     | Rôle                                                                             | Port local                                |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `caddy`     | Reverse proxy + TLS. Admin API 2020.                                             | 8181 (http) / 8543 (https) / 2020 (admin) |
| `registry`  | Registry v2 local, push des images buildées.                                     | 5000                                      |
| `postgres`  | Base de données de développement.                                                | 5434                                      |
| `redis`     | File de travaux et données éphémères.                                            | 6381                                      |
| `agent`     | Frontière gRPC des opérations Docker privilégiées.                               | socket Unix                               |
| `adminer`   | UI de diagnostic DB locale.                                                      | via Caddy                                 |

## Commandes

```bash
make infra-up       # docker network create ploydok-public + compose up -d
make infra-down     # compose down + cleanup network
make infra-logs     # tail caddy logs
```

Les réseaux `ploydok-public`/`ploydok-ingress` sont créés par `infra-up` pour
le développement. Ne pas étendre ces réseaux par commodité : les workloads et
les interfaces d'administration doivent conserver les frontières définies par
le compose et par le descriptor de production.

## Caddy

- Config dynamique via Admin API `http://127.0.0.1:2020/config/`. L'API Ploydok (`apps/api/src/caddy/client.ts`) patche la config — **ne pas** éditer le `Caddyfile` statique à la main pour le dev.
- Data volume : `infra/caddy/data` (certs Let's Encrypt en prod). Ne pas commiter le contenu.

## BuildKit

- En dev, les images se construisent avec le BuildKit du moteur Docker via
  buildx, comme Dokploy et Coolify : `make infra-up` crée le builder
  `ploydok-dev` (driver `docker-container`, `network=ploydok_ploydok`, config
  `infra/buildkit/buildkitd.toml`) et `make secrets-init` pose
  `PLOYDOK_BUILDKIT_ADDR=buildx://ploydok-dev`. Aucun `buildctl` ni démon
  rootless à installer sur l'hôte : Ubuntu 24.04+ refuse ce dernier
  (`apparmor_restrict_unprivileged_userns=1`).
- Toute autre adresse (`docker-container://…`, `tcp://…`, `unix://…`) passe
  par `buildctl`, comme en prod. Les opérations Docker privilégiées hors build
  restent déléguées à l'agent.
- Build dir côté API : `~/.ploydok-dev/builds/` (var `PLOYDOK_BUILD_DIR`). Garbage-collecté périodiquement — ne pas y stocker de données persistantes.

## Registry

- `http://127.0.0.1:5000` — pas d'auth en dev. Vérifier le catalogue : `curl http://127.0.0.1:5000/v2/_catalog`.
- Credentials prod : `PLOYDOK_REGISTRY_USER/PASS` (env API).

## Sites statiques — deux chemins, pas un

Un deploy statique écrit dans `PLOYDOK_STATIC_ROOT` et publie
`PLOYDOK_CADDY_STATIC_ROOT` dans la config Caddy. Les deux diffèrent en dev :

| Var                         | Dev                        | Prod                       |
| --------------------------- | -------------------------- | -------------------------- |
| `PLOYDOK_STATIC_ROOT`       | `~/.ploydok-dev/static`    | `/var/lib/ploydok/static`  |
| `PLOYDOK_CADDY_STATIC_ROOT` | `/var/lib/ploydok/static`  | idem (hérite du précédent) |

- **Chemin hôte variable, chemin container fixe.** En dev l'API tourne sous
  l'uid de l'utilisateur, qui n'écrit pas dans `/var/lib` ; le bind compose
  (`${PLOYDOK_STATIC_ROOT}:/var/lib/ploydok/static:ro`) réaligne les deux vues.
  `make secrets-init` renseigne les deux vars dans `.env.local` et crée le
  dossier — Docker créerait sinon la racine en root au premier `infra-up`, et
  tout deploy statique finirait en `EACCES`.
- Même règle pour `PLOYDOK_BUILD_DIR`. Le default vit dans `defaultStateDir`
  (`apps/api/src/env.ts`) : `/var/lib/ploydok/<name>` en prod, sous `HOME`
  sinon. En prod `HOME` vaut `/` (uid numérique) sur un rootfs `read_only` —
  un default dérivé du home y serait non inscriptible, d'où le pin explicite
  dans le `.env` généré par `installer/install.sh`.
- Un défaut de permission sur ces racines est **fatal**, pas transient
  (`apps/api/src/worker/errors.ts`) : rejouer le build ne répare pas un mount.

## Règles

- **Ne pas** toucher aux ports 80/443/3000 (occupés par d'autres services sur la machine dev).
- **Ne pas** ajouter un service au compose sans mettre à jour `commands.md` + `make infra-up` → reste la source de vérité.
- Tester `make infra-up && make infra-down` est idempotent avant de commiter une modif compose.
- Secrets prod (mTLS certs, registry creds) : **jamais** dans le repo. Passer par env + secret manager.
