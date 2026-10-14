# Infrastructure locale Ploydok

Ce dossier décrit uniquement l'environnement de développement Compose. Le
descriptor de production est `installer/templates/docker-stack.yml`.

## Démarrage rapide

```bash
# Depuis la racine du repo
make infra-up
```

Le Compose local démarre Postgres, Redis, Caddy, BuildKit, le registry et
l'agent. Caddy écoute sur `8181`/`8543`; son API d'administration interne `2019`
est publiée uniquement sur `127.0.0.1:2020`.

## Vérifier l'admin API

```bash
curl -sf http://127.0.0.1:2020/config/
```

Une réponse `null` (config vide) ou un objet JSON indique que Caddy fonctionne.

## Variables d'environnement

Les secrets locaux persistants vivent dans `apps/api/.env.local`. Initialisez
les valeurs absentes avec :

```bash
make secrets-init
```

Ne régénérez pas `SESSION_SECRET` ou `MASTER_KEY` sur une installation active :
cela invaliderait respectivement les sessions et les données chiffrées.

## Arrêt

```bash
make infra-stop
```

Utilisez `make infra-down` uniquement lorsqu'il faut retirer les conteneurs et
réseaux de développement. Les volumes de données ne sont pas supprimés par
cette commande.

## Sécurité — Admin API

**L'admin API Caddy ne doit JAMAIS être exposée publiquement.**

Le mapping `127.0.0.1:2020:2019` empêche une exposition sur les interfaces
publiques de l'hôte. Ne le remplacez jamais par un binding `0.0.0.0`.

Cette protection locale ne décrit pas à elle seule la frontière de production :
le réseau d'administration Caddy du stack doit également rester inaccessible
aux workloads utilisateurs.

## Configuration Caddy

Le `Caddyfile` dans `infra/caddy/Caddyfile` sert uniquement de bootstrap :
- `auto_https off` pour le développement local.
- En production, retirer cette directive ; Caddy gérera TLS via ACME (Let's Encrypt).
- La configuration opérationnelle (routes, upstreams) est injectée dynamiquement via
  `CaddyClient` depuis `apps/api/src/caddy/`.

## Agent

Le service `agent` est actif dans `infra/docker-compose.yml` et construit depuis
`agent/Dockerfile`. En développement il expose le socket gRPC
`/tmp/ploydok/agent.sock` dans un volume partagé avec l'API.
