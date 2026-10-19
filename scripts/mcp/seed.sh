#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Seed a Ploydok instance with demo apps and MCP tokens, then write this
# repository's .mcp.json so Claude Code (restarted in this directory) talks
# to it. Re-runnable: existing demo apps are reused, previous seed tokens are
# revoked and replaced.
#
#   bash scripts/mcp/seed.sh                  # staging (deploy/shuttle-staging.json)
#   bash scripts/mcp/seed.sh --target local   # local dev stack (API :3335)
#   bash scripts/mcp/seed.sh --org inopan     # another organization (default claude-agent)
#   bash scripts/mcp/seed.sh --no-apps        # tokens and .mcp.json only
#
# Tokens are written with their hashes directly in PostgreSQL (staging over
# SSH): an MCP token is issued from a browser session only, and API tokens
# cannot mint tokens. Demo apps go through the public REST API with a
# short-lived seed token revoked on exit.
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

target=staging
org_slug=claude-agent
seed_apps=1
token_days=7
while (($#)); do
  case "$1" in
    --target) target="${2:?}"; shift 2 ;;
    --org) org_slug="${2:?}"; shift 2 ;;
    --no-apps) seed_apps=0; shift ;;
    --days) token_days="${2:?}"; shift 2 ;;
    -h|--help) sed -n '3,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$org_slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "invalid --org" >&2; exit 2; }
[[ "$token_days" =~ ^[0-9]+$ ]] && ((token_days >= 1 && token_days <= 90)) ||
  { echo "--days must be 1..90" >&2; exit 2; }
for bin in jq curl bun; do
  command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 2; }
done

log() { printf '[mcp-seed] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

case "$target" in
  staging)
    cfg=deploy/shuttle-staging.json
    ssh_host="$(jq -r '.server.user + "@" + .server.host' "$cfg")"
    ssh_port="$(jq -r '.server.port' "$cfg")"
    ssh_key="$(jq -r '.server.identity_file' "$cfg")"
    ssh_key="${ssh_key/#\~/$HOME}"
    api_url="${PLOYDOK_STAGING_URL:-http://192-168-1-235.sslip.io}/api"
    name_prefix=ploydok-staging
    psql() {
      ssh -o BatchMode=yes -p "$ssh_port" -i "$ssh_key" "$ssh_host" \
        'c=$(sudo docker ps -qf name=ploydok_postgres) && sudo docker exec -i "$c" psql -U ploydok -d ploydok -v ON_ERROR_STOP=1 -qAt'
    }
    ;;
  local)
    api_url="${PLOYDOK_LOCAL_API_URL:-http://localhost:3335}"
    name_prefix=ploydok-local
    psql() { docker exec -i ploydok-postgres psql -U ploydok -d ploydok -v ON_ERROR_STOP=1 -qAt; }
    ;;
  *) die "--target must be staging or local" ;;
esac
mcp_url="$api_url/mcp"

# -- Preconditions ------------------------------------------------------------

# A non-token Bearer clears the /mcp CSRF exemption and fails authentication:
# 401 proves the endpoint exists (an older release answers 403 or 404).
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$mcp_url" \
  -H 'Authorization: Bearer probe')"
[[ "$status" == 401 ]] ||
  die "$mcp_url answered $status, expected 401: is the MCP release deployed?"
[[ "$(psql <<<"select count(*) from information_schema.columns where table_name='api_tokens' and column_name='kind'")" == 1 ]] ||
  die "api_tokens.kind is missing: migration 0097 has not run"

row="$(psql <<SQL
select p.id || '|' || m.user_id from projects p
join memberships m on m.org_id = p.id and m.role = 'owner' and m.accepted_at is not null
where p.slug = '$org_slug' order by m.accepted_at limit 1
SQL
)"
[[ -n "$row" ]] || die "organization '$org_slug' with an accepted owner not found"
org_id="${row%%|*}"
user_id="${row##*|}"
log "target=$target org=$org_slug ($org_id) owner=$user_id"

# -- Token helpers --------------------------------------------------------------

# Prints "<token> <id> <sha256> <bcrypt>", formats used by the API.
new_token() {
  (cd apps/api && bun -e '
    const bcrypt = require("bcryptjs")
    const { createHash, randomBytes } = require("node:crypto")
    const token = "plk_live_" + randomBytes(32).toString("base64url")
    const id = randomBytes(16).toString("hex")
    const sha = createHash("sha256").update(token).digest("hex")
    console.log(token, id, sha, bcrypt.hashSync(token, 10))
  ')
}

# insert_token <name> <kind> <scopes json> <app_ids json|null> <ttl sql interval>
insert_token() {
  local name="$1" kind="$2" scopes="$3" app_ids="$4" ttl="$5" token id sha bc
  read -r token id sha bc < <(new_token)
  psql >/dev/null <<SQL
insert into api_tokens (id, user_id, name, token_hash, bcrypt_hash, scopes,
  created_at, expires_at, kind, org_id, app_ids)
values ('$id', '$user_id', '$name', '$sha', '$bc', '$scopes'::jsonb, now(),
  now() + interval '$ttl', '$kind',
  $( [[ "$kind" == mcp ]] && echo "'$org_id'" || echo null ),
  $( [[ "$app_ids" == null ]] && echo null || echo "'$app_ids'::jsonb" ));
SQL
  printf '%s %s\n' "$token" "$id"
}

# -- Demo apps ------------------------------------------------------------------

demo_app_ids=()
if ((seed_apps)); then
  read -r seed_token seed_token_id < <(insert_token \
    "mcp-seed: temporary" api '["apps:read","apps:write","apps:deploy"]' null '15 minutes')
  trap 'psql <<<"update api_tokens set revoked_at = now() where id = '"'$seed_token_id'"'" >/dev/null || true' EXIT

  api() { # api <method> <path> [json]
    local csrf=seed
    curl -sS -X "$1" "$api_url$2" \
      -H "Authorization: Bearer $seed_token" \
      -H "Cookie: csrf=$csrf" -H "x-csrf-token: $csrf" \
      -H 'content-type: application/json' ${3:+--data "$3"}
  }

  existing="$(api GET "/apps?organizationId=$org_id")"
  jq -e '.apps' >/dev/null <<<"$existing" || die "listing apps failed: $existing"

  while IFS='|' read -r name image port; do
    app_id="$(jq -r --arg n "$name" '.apps[] | select(.name == $n) | .id' <<<"$existing")"
    if [[ -z "$app_id" ]]; then
      body="$(jq -nc --arg n "$name" --arg o "$org_id" --arg i "$image" --argjson p "$port" \
        '{name:$n, organizationId:$o, gitProvider:"image", imageRef:$i, runtimePort:$p}')"
      created="$(api POST /apps "$body")"
      app_id="$(jq -r '.app.id // .id // empty' <<<"$created")"
      [[ -n "$app_id" ]] || die "creating $name failed: $created"
      log "created $name ($app_id)"
    else
      log "reusing $name ($app_id)"
    fi
    demo_app_ids+=("$app_id")

    last="$(api GET "/apps/$app_id/builds?limit=1" | jq -r '.builds[0].status // "none"')"
    if [[ "$last" != succeeded* && "$last" != pending && "$last" != running ]]; then
      api POST "/apps/$app_id/deploy" >/dev/null
      log "deploy requested for $name"
    fi
  done <<'APPS'
mcp-demo-echo|mendhak/http-https-echo:37|8080
mcp-demo-nginx|nginx:1.27-alpine|80
APPS

  # Wait for the builds, then hit each app so request logs exist.
  for app_id in "${demo_app_ids[@]}"; do
    for _ in $(seq 60); do
      st="$(api GET "/apps/$app_id/builds?limit=1" | jq -r '.builds[0].status // "none"')"
      [[ "$st" == pending || "$st" == running || "$st" == none ]] || break
      sleep 5
    done
    url="$(api GET "/apps/$app_id" | jq -r '.app.publicUrl // .publicUrl // empty')"
    log "app $app_id: build $st${url:+, $url}"
    if [[ -n "$url" ]]; then
      for path in / /health /missing; do curl -s -o /dev/null -m 5 "$url$path" || true; done
    fi
  done
fi

# -- MCP tokens -------------------------------------------------------------------

psql >/dev/null <<SQL
update api_tokens set revoked_at = now()
where user_id = '$user_id' and kind = 'mcp' and name like 'mcp-seed:%' and revoked_at is null
SQL

read -r full_token _ < <(insert_token "mcp-seed: $org_slug full" mcp \
  '["apps:read","services:read","databases:read","apps:deploy"]' null "$token_days days")
servers="$(jq -nc --arg n "$name_prefix" --arg u "$mcp_url" --arg t "$full_token" \
  '{($n): {type:"http", url:$u, headers:{Authorization:("Bearer " + $t)}}}')"

if ((${#demo_app_ids[@]})); then
  read -r ro_token _ < <(insert_token "mcp-seed: $org_slug readonly" mcp \
    '["apps:read","services:read","databases:read"]' \
    "$(jq -nc --arg a "${demo_app_ids[0]}" '[$a]')" "$token_days days")
  servers="$(jq -c --arg n "$name_prefix-readonly" --arg u "$mcp_url" --arg t "$ro_token" \
    '. + {($n): {type:"http", url:$u, headers:{Authorization:("Bearer " + $t)}}}' <<<"$servers")"
fi

# .mcp.json holds live tokens: gitignored, private, rewritten on every run.
umask 077
jq -n --argjson s "$servers" '{mcpServers: $s}' >"$root/.mcp.json"
chmod 600 "$root/.mcp.json"

log "wrote .mcp.json: $(jq -r '.mcpServers | keys | join(", ")' "$root/.mcp.json")"
log "restart Claude Code in $root and approve the project MCP servers"
