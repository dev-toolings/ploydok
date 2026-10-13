#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# e2e-spawn-nginx.sh — Integration test: spawn nginx via debug API, verify
# Caddy routing, then teardown. Requires a running API, Caddy, and agent.
#
# Usage:
#   API_BASE=http://127.0.0.1:3001 ./scripts/e2e-spawn-nginx.sh
#
# The script exits 0 on success, 1 on any failure.
# Set PLOYDOK_DEBUG_UNAUTHENTICATED=1 on the API side to bypass auth (CI only).

set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:3335}"
CADDY_ADMIN="${CADDY_ADMIN:-http://127.0.0.1:2020}"
CADDY_HTTP="${CADDY_HTTP:-http://127.0.0.1:8181}"

# Couleurs pour la lisibilité des logs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
log_err()  { echo -e "${RED}[ERR]${NC} $*" >&2; }
log_info() { echo -e "${YELLOW}[...]${NC} $*"; }

# APP_ID tracked for cleanup trap. Once teardown is done manually, set to "".
APP_ID=""

cleanup() {
  if [[ -n "$APP_ID" ]]; then
    log_info "Cleanup : suppression du container ploydok-${APP_ID} (best-effort)"
    curl -sf -X DELETE \
      -H "X-Test-User: ci-test-user" \
      "${API_BASE}/debug/spawn-nginx/${APP_ID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Étape 1 : POST /debug/spawn-nginx → récupère appId + url
# ---------------------------------------------------------------------------
log_info "Étape 1 : spawn nginx via POST ${API_BASE}/debug/spawn-nginx"

# `curl -sf` hides the status and body, which turns any API-side failure into an
# opaque exit 22 in CI. Capture both so the log states what actually happened.
SPAWN_HTTP=$(curl -s -o /tmp/ploydok-e2e-spawn.json -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Test-User: ci-test-user" \
  "${API_BASE}/debug/spawn-nginx" || echo "000")
SPAWN_RESPONSE=$(cat /tmp/ploydok-e2e-spawn.json 2>/dev/null || true)

if [[ "$SPAWN_HTTP" != "201" ]]; then
  log_err "POST /debug/spawn-nginx a répondu ${SPAWN_HTTP}. Corps: ${SPAWN_RESPONSE:-<vide>}"
  exit 1
fi

if [[ -z "$SPAWN_RESPONSE" ]]; then
  log_err "Réponse vide de POST /debug/spawn-nginx"
  exit 1
fi

echo "Réponse spawn: $SPAWN_RESPONSE"

APP_ID=$(echo "$SPAWN_RESPONSE" | jq -r '.appId // empty')
CONTAINER_URL=$(echo "$SPAWN_RESPONSE" | jq -r '.url // empty')

if [[ -z "$APP_ID" ]]; then
  log_err "appId absent de la réponse. Réponse: $SPAWN_RESPONSE"
  exit 1
fi

log_ok "Étape 1 : appId=${APP_ID} url=${CONTAINER_URL}"

# ---------------------------------------------------------------------------
# Étape 2 : Vérifie le container Docker (running)
# ---------------------------------------------------------------------------
log_info "Étape 2 : vérification container ploydok-${APP_ID} running"

CONTAINER_LINE=$(docker ps --filter "name=ploydok-${APP_ID}" --format "{{.Names}}\t{{.Status}}" 2>/dev/null || true)
if [[ -z "$CONTAINER_LINE" ]]; then
  log_err "Container ploydok-${APP_ID} introuvable dans docker ps"
  docker ps --filter "name=ploydok-${APP_ID}" || true
  exit 1
fi

echo "Container: $CONTAINER_LINE"
log_ok "Étape 2 : container ploydok-${APP_ID} running"

# ---------------------------------------------------------------------------
# Étape 3 : Vérifie que Caddy a bien la route
# ---------------------------------------------------------------------------
log_info "Étape 3 : vérification route Caddy ${CADDY_ADMIN}/id/ploydok-${APP_ID}"

CADDY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "${CADDY_ADMIN}/id/ploydok-${APP_ID}" 2>/dev/null || echo "000")

if [[ "$CADDY_STATUS" != "200" ]]; then
  log_err "Route Caddy ploydok-${APP_ID} absente (HTTP ${CADDY_STATUS})"
  curl -s "${CADDY_ADMIN}/config/" | jq '.apps.http.servers // {}' 2>/dev/null || true
  exit 1
fi

log_ok "Étape 3 : route Caddy présente (HTTP 200)"

# ---------------------------------------------------------------------------
# Étape 4 : Curl via Caddy avec Host header — vérifie nginx répond
# ---------------------------------------------------------------------------
log_info "Étape 4 : vérification nginx via Caddy (Host: ${APP_ID}.localtest.me)"

NGINX_OK=false
NGINX_BODY=""
for i in $(seq 1 15); do
  NGINX_BODY=$(curl -sf \
    -H "Host: ${APP_ID}.localtest.me" \
    "${CADDY_HTTP}/" 2>/dev/null || true)

  if echo "$NGINX_BODY" | grep -qi "welcome to nginx"; then
    NGINX_OK=true
    break
  fi

  log_info "  tentative ${i}/15 — nginx pas encore prêt, retry dans 1s..."
  sleep 1
done

if [[ "$NGINX_OK" != "true" ]]; then
  log_err "nginx n'a pas répondu 'Welcome to nginx' après 15 tentatives"
  log_err "Dernière réponse: $(echo "$NGINX_BODY" | head -5)"
  docker logs "ploydok-${APP_ID}" 2>&1 | tail -20 || true
  exit 1
fi

log_ok "Étape 4 : nginx répond via Caddy (Welcome to nginx détecté)"

# ---------------------------------------------------------------------------
# Étape 5 : DELETE /debug/spawn-nginx/:appId → teardown
# ---------------------------------------------------------------------------
log_info "Étape 5 : teardown via DELETE ${API_BASE}/debug/spawn-nginx/${APP_ID}"

DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "X-Test-User: ci-test-user" \
  "${API_BASE}/debug/spawn-nginx/${APP_ID}" 2>/dev/null || echo "000")

if [[ "$DELETE_STATUS" != "200" ]]; then
  log_err "DELETE /debug/spawn-nginx/${APP_ID} a renvoyé HTTP ${DELETE_STATUS}"
  exit 1
fi

# Mémoriser l'appId avant de désactiver le cleanup automatique
FINAL_APP_ID="$APP_ID"
# Désactiver le cleanup automatique (teardown déjà fait)
APP_ID=""

log_ok "Étape 5 : teardown OK (HTTP 200)"

# ---------------------------------------------------------------------------
# Étape 6 : Vérifie que le container est bien supprimé
# ---------------------------------------------------------------------------
log_info "Étape 6 : vérification container ploydok-${FINAL_APP_ID} supprimé"

# Petit délai pour que Docker termine la suppression
sleep 1

REMAINING=$(docker ps -a --filter "name=ploydok-${FINAL_APP_ID}" --format "{{.Names}}" 2>/dev/null || true)
if [[ -n "$REMAINING" ]]; then
  log_err "Container ploydok-${FINAL_APP_ID} encore présent : $REMAINING"
  exit 1
fi

log_ok "Étape 6 : container absent (supprimé)"

# ---------------------------------------------------------------------------
# Étape 7 : Vérifie que la route Caddy est supprimée (404 attendu)
# ---------------------------------------------------------------------------
log_info "Étape 7 : vérification route Caddy ploydok-${FINAL_APP_ID} supprimée"

CADDY_STATUS_AFTER=$(curl -s -o /dev/null -w "%{http_code}" \
  "${CADDY_ADMIN}/id/ploydok-${FINAL_APP_ID}" 2>/dev/null || echo "000")

if [[ "$CADDY_STATUS_AFTER" != "404" ]]; then
  log_err "Route Caddy ploydok-${FINAL_APP_ID} toujours présente (HTTP ${CADDY_STATUS_AFTER}, attendu 404)"
  exit 1
fi

log_ok "Étape 7 : route Caddy supprimée (HTTP 404)"

# ---------------------------------------------------------------------------
# Succès
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  e2e-spawn-nginx : TOUS LES TESTS OK      ${NC}"
echo -e "${GREEN}============================================${NC}"
exit 0
