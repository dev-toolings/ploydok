.DEFAULT_GOAL := help
.PHONY: help install update check dev stop dev-agent agent-restart agent-logs db-ensure-auth db-migrate reset db-seed infra-up infra-down infra-stop infra-logs build start test test-pg lint typecheck clean secrets-init dod

# Ports locaux : API 3335, Web 5173, Caddy 8181/8543/2020, agent unix /tmp/ploydok/agent.sock

# Docker buildx builder used for local image builds (see infra-up).
BUILDX_BUILDER := ploydok-dev
# Compose network (project `ploydok`, network key `ploydok`) the builder joins.
BUILDX_NETWORK := ploydok_ploydok

ifneq (,$(findstring xterm,$(TERM))$(MAKE_TERMOUT))
C_SECTION := \033[1;33m
C_TARGET := \033[0;36m
C_OK := \033[0;32m
C_WARN := \033[0;33m
C_ERR := \033[0;31m
C_RESET := \033[0m
else
C_SECTION :=
C_TARGET :=
C_OK :=
C_WARN :=
C_ERR :=
C_RESET :=
endif

# ─── Help ───
help: ## Affiche les cibles disponibles, regroupees par section
	@awk -v section_color="$(C_SECTION)" -v target_color="$(C_TARGET)" -v reset="$(C_RESET)" ' \
	  /^# ─── / { section = $$0; sub(/^# ─── /, "", section); sub(/ ───$$/, "", section); printf "\n%s%s%s\n", section_color, section, reset; next } \
	  /^[[:alnum:]_-]+:.*## / { target = $$1; sub(/:$$/, "", target); description = $$0; sub(/^.*## /, "", description); printf "  %s%-20s%s %s\n", target_color, target, reset, description }' $(MAKEFILE_LIST)

# ─── Install / Setup ───
install: ## Installe les dependances, configure l'infra et demarre le dev
	@printf '$(C_TARGET)[install]$(C_RESET) installing workspace dependencies...\n'
	bun install
	@printf '$(C_TARGET)[install]$(C_RESET) bringing up local infra (postgres + redis + caddy + registry + agent + buildx builder)...\n'
	$(MAKE) infra-up
	@printf '$(C_TARGET)[install]$(C_RESET) waiting for postgres and checking credentials...\n'
	$(MAKE) db-ensure-auth
	@printf '$(C_TARGET)[install]$(C_RESET) applying database migrations...\n'
	$(MAKE) db-migrate
	@printf '$(C_TARGET)[install]$(C_RESET) verifying the stack end to end...\n'
	$(MAKE) check
	@printf '$(C_OK)[install]$(C_RESET) setup done, starting dev servers (web:5173 + api:3335), Ctrl-C to stop\n'
	$(MAKE) dev

update: ## Met a jour les dependances du workspace avec bun update
	bun update

# L'API refuse de booter sans Postgres ni Redis, et turbo tue alors toute la run
# (web compris). `dev` remonte donc l'infra et attend qu'elle soit prête avant
# de lancer turbo. Idempotent : ~2 s quand tout tourne déjà.
# ─── Dev servers ───
dev: ## Demarre le web et l'API apres verification de l'infra
	@docker info >/dev/null 2>&1 || { \
	  printf '$(C_ERR)[dev]$(C_RESET) docker daemon injoignable. Demarre Docker, puis relance make dev\n'; \
	  exit 1; \
	}
	@busy=""; \
	for port in 3335 5173; do \
	  if lsof -nP -iTCP:$$port -sTCP:LISTEN -t >/dev/null 2>&1; then \
	    busy="$$busy $$port"; \
	  fi; \
	done; \
	if [ -n "$$busy" ]; then \
	  printf '$(C_WARN)[dev]$(C_RESET) port(s) deja occupe(s) :%s\n' "$$busy"; \
	  printf "$(C_WARN)[dev]$(C_RESET) un 'make dev' tourne surement dans un autre shell. Ferme-le avant de relancer\n"; \
	  exit 1; \
	fi
	@$(MAKE) --no-print-directory infra-up
	@sh scripts/dev-workloads.sh restore
	@printf '$(C_TARGET)[dev]$(C_RESET) waiting for postgres + redis to report healthy...\n'
	@docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml up -d --no-recreate --wait --wait-timeout 120 postgres redis
	@$(MAKE) --no-print-directory db-ensure-auth
	@# Wait only for a running compose agent: a stopped one means the native
	@# agent (make dev-agent) owns the socket and must not be displaced.
	@if [ -n "$$(docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml ps --status running -q agent)" ]; then \
	  printf '$(C_TARGET)[dev]$(C_RESET) waiting for the agent socket (a cold Rust build can take minutes)...\n'; \
	  docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml up -d --no-recreate --wait --wait-timeout 660 agent; \
	else \
	  printf '$(C_WARN)[dev]$(C_RESET) compose agent not running, not waiting for it\n'; \
	fi
	@printf '$(C_OK)[dev]$(C_RESET) starting web:5173 + api:3335\n'
	bunx turbo dev

stop: infra-stop ## Arrete l'infra locale, le builder et les workloads Swarm

dev-agent: ## Lance l'agent Rust en mode natif pour le debug
	@printf '$(C_TARGET)[dev-agent]$(C_RESET) Starting ploydok-agent in native mode (insecure, /tmp/ploydok/agent.sock)...\n'
	@printf '$(C_WARN)[dev-agent]$(C_RESET) Stop the compose agent service first: docker compose -f infra/docker-compose.yml stop agent\n'
	mkdir -p /tmp/ploydok
	cd agent && PLOYDOK_AGENT_INSECURE=1 PLOYDOK_AGENT_SOCKET=/tmp/ploydok/agent.sock PLOYDOK_VALIDATOR_CONFIG=$(CURDIR)/agent/config/dev-validator.toml cargo run --release -p ploydok-agent

agent-restart: ## Redemarre le container ploydok-agent
	docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml restart agent
	@printf '$(C_OK)[agent-restart]$(C_RESET) agent restarted, tail with: make agent-logs\n'

agent-logs: ## Affiche les logs du container ploydok-agent
	docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml logs -f agent

# Le volume postgres fige le mot de passe du rôle à l'initdb : une rotation de
# PLOYDOK_PG_PASSWORD casse l'auth tant que le rôle n'est pas réaligné.
# ─── Database ───
db-ensure-auth: ## Verifie et réaligne le role Postgres si necessaire
	bun run scripts/db-ensure-auth.ts

db-migrate: ## Applique les migrations Postgres
	set -a; . apps/api/.env.local; set +a; bun run --cwd packages/db migrate

reset: ## Reinitialise la base et Redis pour une installation vierge
	@printf '$(C_WARN)[reset]$(C_RESET) removing runtime app/database containers...\n'
	@containers=$$({ docker ps -aq --filter 'name=^/ploydok-app-'; docker ps -aq --filter 'name=^/ploydok-db-'; } | sort -u); \
	if [ -n "$$containers" ]; then \
	  docker rm -f $$containers >/dev/null; \
	  printf '$(C_OK)[reset]$(C_RESET) removed runtime containers: %s\n' "$$containers"; \
	else \
	  printf '$(C_WARN)[reset]$(C_RESET) no runtime containers to remove\n'; \
	fi
	@printf '$(C_WARN)[reset]$(C_RESET) dropping public + drizzle schemas...\n'
	@docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml exec -T postgres psql -U ploydok -d ploydok -v ON_ERROR_STOP=1 --quiet -c 'SET client_min_messages = warning; DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ploydok; GRANT ALL ON SCHEMA public TO public;' >/dev/null
	@printf '$(C_WARN)[reset]$(C_RESET) flushing redis...\n'
	@set -a; . apps/api/.env.local; set +a; docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml exec -T redis redis-cli --no-auth-warning -a "$$PLOYDOK_REDIS_PASSWORD" FLUSHDB >/dev/null
	@printf '$(C_TARGET)[reset]$(C_RESET) applying migrations...\n'
	@set -a; . apps/api/.env.local; set +a; bun run --cwd packages/db migrate
	@printf '$(C_OK)[reset]$(C_RESET) done, instance is back to a fresh-install state (no users, no projects)\n'
	@printf '                next: make check prints the /setup URL with the PLOYDOK_SETUP_TOKEN of .env.local\n'

db-seed: ## Cree les donnees de developpement
	bun run --cwd packages/db seed

# ─── Infra ───
secrets-init: ## Genere les secrets de developpement dans .env.local
	@ENV_FILE=apps/api/.env.local; \
	touch "$$ENV_FILE"; \
	if ! grep -q '^PLOYDOK_PG_PASSWORD=' "$$ENV_FILE" 2>/dev/null; then \
	  PG_PASS=$$(openssl rand -hex 32); \
	  echo "PLOYDOK_PG_PASSWORD=$$PG_PASS" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) PLOYDOK_PG_PASSWORD generated\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) PLOYDOK_PG_PASSWORD already present, skipped\n'; \
	fi; \
	if ! grep -q '^PLOYDOK_REDIS_PASSWORD=' "$$ENV_FILE" 2>/dev/null; then \
	  REDIS_PASS=$$(openssl rand -hex 32); \
	  echo "PLOYDOK_REDIS_PASSWORD=$$REDIS_PASS" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) PLOYDOK_REDIS_PASSWORD generated\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) PLOYDOK_REDIS_PASSWORD already present, skipped\n'; \
	fi; \
	if ! grep -q '^DATABASE_URL=' "$$ENV_FILE" 2>/dev/null; then \
	  PG_PASS=$$(grep '^PLOYDOK_PG_PASSWORD=' "$$ENV_FILE" | head -n1 | cut -d= -f2-); \
	  echo "DATABASE_URL=postgres://ploydok:$$PG_PASS@127.0.0.1:5434/ploydok" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) DATABASE_URL generated\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) DATABASE_URL already present, skipped\n'; \
	fi; \
	if ! grep -q '^REDIS_URL=' "$$ENV_FILE" 2>/dev/null; then \
	  REDIS_PASS=$$(grep '^PLOYDOK_REDIS_PASSWORD=' "$$ENV_FILE" | head -n1 | cut -d= -f2-); \
	  echo "REDIS_URL=redis://:$$REDIS_PASS@127.0.0.1:6381/0" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) REDIS_URL generated\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) REDIS_URL already present, skipped\n'; \
	fi; \
	if ! grep -q '^MASTER_KEY=' "$$ENV_FILE" 2>/dev/null; then \
	  MASTER_KEY=$$(openssl rand -base64 32); \
	  echo "MASTER_KEY=$$MASTER_KEY" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) MASTER_KEY generated\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) MASTER_KEY already present, skipped\n'; \
	fi; \
	if ! grep -q '^SESSION_SECRET=' "$$ENV_FILE" 2>/dev/null; then \
	  SESSION_SECRET=$$(openssl rand -hex 32); \
	  echo "SESSION_SECRET=$$SESSION_SECRET" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) SESSION_SECRET generated\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) SESSION_SECRET already present, skipped\n'; \
	fi; \
	if ! grep -q '^PLOYDOK_SETUP_TOKEN=' "$$ENV_FILE" 2>/dev/null; then \
	  SETUP_TOKEN=$$(openssl rand -hex 32); \
	  echo "PLOYDOK_SETUP_TOKEN=$$SETUP_TOKEN" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) PLOYDOK_SETUP_TOKEN generated\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) PLOYDOK_SETUP_TOKEN already present, skipped\n'; \
	fi; \
	if ! grep -q '^PLOYDOK_STATIC_ROOT=' "$$ENV_FILE" 2>/dev/null; then \
	  echo "PLOYDOK_STATIC_ROOT=$$HOME/.ploydok-dev/static" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) PLOYDOK_STATIC_ROOT set to %s\n' "$$HOME/.ploydok-dev/static"; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) PLOYDOK_STATIC_ROOT already present, skipped\n'; \
	fi; \
	if ! grep -q '^PLOYDOK_CADDY_STATIC_ROOT=' "$$ENV_FILE" 2>/dev/null; then \
	  echo "PLOYDOK_CADDY_STATIC_ROOT=/var/lib/ploydok/static" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) PLOYDOK_CADDY_STATIC_ROOT set to /var/lib/ploydok/static\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) PLOYDOK_CADDY_STATIC_ROOT already present, skipped\n'; \
	fi; \
	if ! grep -q '^PLOYDOK_BUILDKIT_ADDR=' "$$ENV_FILE" 2>/dev/null; then \
	  echo "PLOYDOK_BUILDKIT_ADDR=buildx://$(BUILDX_BUILDER)" >> "$$ENV_FILE"; \
	  printf '$(C_OK)[secrets-init]$(C_RESET) PLOYDOK_BUILDKIT_ADDR set to buildx://$(BUILDX_BUILDER)\n'; \
	else \
	  printf '$(C_WARN)[secrets-init]$(C_RESET) PLOYDOK_BUILDKIT_ADDR already present, skipped\n'; \
	fi; \
	STATIC_ROOT=$$(grep '^PLOYDOK_STATIC_ROOT=' "$$ENV_FILE" | head -n1 | cut -d= -f2-); \
	mkdir -p "$$STATIC_ROOT" "$$HOME/.ploydok-dev/builds"

infra-up: secrets-init ## Demarre les services infra du projet
	@docker network create ploydok-public 2>/dev/null || true
	@docker network create ploydok-ingress 2>/dev/null || true
	docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml up -d
	@# Builds go through the Docker engine's buildx, like Dokploy and Coolify:
	@# no host buildctl, no rootless daemon blocked by AppArmor userns rules.
	@# The builder joins the compose network so the push URL registry:5000 resolves.
	@# A builder created with another network (old network=host) is recreated.
	@if docker buildx inspect $(BUILDX_BUILDER) 2>/dev/null | grep -q 'network="$(BUILDX_NETWORK)"'; then \
	  docker buildx inspect --bootstrap $(BUILDX_BUILDER) >/dev/null; \
	  printf '$(C_OK)[infra-up]$(C_RESET) buildx builder $(BUILDX_BUILDER) already on $(BUILDX_NETWORK)\n'; \
	else \
	  if docker buildx inspect $(BUILDX_BUILDER) >/dev/null 2>&1; then \
	    printf '$(C_WARN)[infra-up]$(C_RESET) buildx builder $(BUILDX_BUILDER) uses another network, recreating\n'; \
	    docker buildx rm $(BUILDX_BUILDER) >/dev/null; \
	  fi; \
	  docker buildx create --name $(BUILDX_BUILDER) --driver docker-container \
	    --driver-opt network=$(BUILDX_NETWORK) --buildkitd-config infra/buildkit/buildkitd.toml \
	    --bootstrap >/dev/null; \
	fi
	@# buildx create hardcodes unless-stopped. Pin restart=no so a dockerd
	@# restart does not resurrect the builder while the stack is down.
	@sh scripts/dev-workloads.sh buildx-pin
	@printf '$(C_OK)[infra-up]$(C_RESET) Caddy admin   : http://127.0.0.1:2020/config/\n'
	@printf '$(C_OK)[infra-up]$(C_RESET) Registry v2   : http://127.0.0.1:5000/v2/\n'
	@printf '$(C_OK)[infra-up]$(C_RESET) BuildKit      : buildx://$(BUILDX_BUILDER)\n'
	@printf '$(C_OK)[infra-up]$(C_RESET) Postgres      : postgresql://ploydok:***@127.0.0.1:5434/ploydok\n'
	@printf '$(C_OK)[infra-up]$(C_RESET) Redis         : redis://:***@127.0.0.1:6381/0\n'

infra-down: ## Arrete et supprime les containers et reseaux du projet
	@sh scripts/dev-workloads.sh quiesce
	@sh scripts/dev-workloads.sh buildx-pin
	-docker buildx stop $(BUILDX_BUILDER)
	-docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml down --timeout 10
	-docker network rm ploydok-public 2>/dev/null
	-docker network rm ploydok-ingress 2>/dev/null

infra-stop: ## Arrete l'infra, le builder buildx et les workloads Swarm locaux
	@sh scripts/dev-workloads.sh quiesce
	@sh scripts/dev-workloads.sh buildx-pin
	docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml stop --timeout 15
	-docker buildx stop $(BUILDX_BUILDER)

infra-logs: ## Affiche les logs Caddy
	docker compose --env-file apps/api/.env.local -f infra/docker-compose.yml logs -f caddy

# Sonde réelle de chaque brique (TCP, HTTP, socket) + affiche l'URL /setup avec
# le token de .env.local. Sort en 1 si une brique requise est morte.
# ─── Build / Check ───
check: ## Sonde la stack et affiche l'URL /setup avec son token
	@bun run scripts/check-stack.ts

build: ## Construit les paquets via turbo
	bunx turbo build

start: ## Demarre l'API
	cd apps/api && bun run start

test: ## Lance les tests via turbo
	bunx turbo test

test-pg: ## Lance les suites API Postgres (base ploydok_test creee au besoin)
	@bun run scripts/test-pg.ts

lint: ## Lance le lint via turbo
	bunx turbo lint

typecheck: ## Lance le typecheck via turbo
	bunx turbo typecheck

clean: ## Nettoie les artefacts de build
	bunx turbo clean || true
	rm -rf apps/web/.vite apps/web/dist apps/api/dist .turbo */.turbo **/*/.turbo 2>/dev/null || true

# Exécute les 11 specs Playwright DoD Sprint 3 contre l'infra réelle.
# Écrit un rapport local gitignoré sous .ai/reports/.
dod: ## Lance les specifications Playwright DoD Sprint 3
	@echo "+----------------------------------------------------------------+"
	@echo "| Prerequis avant make dod                                       |"
	@echo "| 1. make infra-up       > postgres/redis/caddy/registry/agent   |"
	@echo "| 2. make dev            > dans un autre shell (web + api)       |"
	@echo "| 3. make db-seed        > une fois (dev login + backup code)    |"
	@echo "| 4. GitHub App installee sur le compte de test                  |"
	@echo "|    (via /settings/github dans l'UI web)                        |"
	@echo "+----------------------------------------------------------------+"
	@echo ""
	@echo "Duree : ~5-15 min selon vitesse BuildKit + reseau GitHub."
	@echo "Logs détaillés : test-results/dod-*/"
	@echo ""
	PLOYDOK_E2E_REAL=1 bun scripts/run-dod.ts

# Seed dev DB : user dev@ploydok.local + project + backup code fixe (DEVD-EVDE-VDEV).
# Utilisé par `make dod` pour skipper l'export des creds.
