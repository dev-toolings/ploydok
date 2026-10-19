# Agent Rust (`agent/`)

Workspace Cargo (édition Rust 2021). Deux binaires :

- `ploydok-agent` : daemon long-run. Unix socket (`/tmp/ploydok/agent.sock` en dev), protocole gRPC. Appelé par l'API pour opérations host (spawn container, refresh Caddy, etc.).
- `ploydok-cli` : outil ops. Il expose actuellement `admin-recovery` et
  `audit verify`. Vérifier le contrat réel du sous-commande avant de le citer
  dans un runbook : le chemin historique `admin-recovery` cible encore SQLite
  et n'est pas le mécanisme de récupération PostgreSQL de production.

## Conventions

- Édition Rust 2021, toolchain stable telle que définie par le workflow CI.
- SPDX header en tête de chaque `.rs` : `// SPDX-License-Identifier: AGPL-3.0-only`.
- Pas de `unwrap()` dans les chemins de prod — `?` avec `anyhow::Result` ou un type d'erreur dédié via `thiserror`.
- Logs : `tracing` (pas `println!`), niveaux explicites (`info!`, `warn!`, `error!`).
- Async : `tokio` multi-thread runtime. Socket unix via `tokio::net::UnixListener`.

## Sécurité

- Mode `PLOYDOK_AGENT_INSECURE=1` **uniquement** en dev. En prod : mTLS obligatoire (implémenté sprint-2+).
- Valider toutes les requêtes gRPC à la frontière — ne jamais faire confiance au client API (defense-in-depth).
- Commandes spawn : whitelist d'images OCI, pas d'exécution shell arbitraire.

## Tests

```bash
cd agent && cargo test              # tests unitaires + intégration
cd agent && cargo clippy --workspace -- -D warnings
cd agent && cargo fmt --check
```

- Tests d'intégration dans `agent/*/tests/`.
- Mock du socket unix pour les tests — pas de socket réel dans les unit tests.

## Build / run dev

```bash
make dev-agent     # cargo run --release -p ploydok-agent, insecure, socket /tmp/ploydok/agent.sock
```

## Proto

Les `.proto` définissent le contrat API ↔ agent. Stubs TS générés → `packages/agent-proto/`. Régénérer via le script du package quand un `.proto` change — committer les deux côtés ensemble.
