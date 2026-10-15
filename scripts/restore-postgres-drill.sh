#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Restore a plain pg_dumpall object from an S3-compatible destination into a
# task-owned, fresh PostgreSQL container. The script never deletes the remote
# object and only removes the container and temporary files that it created.

set -Eeuo pipefail

readonly SCRIPT_NAME="restore-postgres-drill"
readonly S3_CLIENT_IMAGE="amazon/aws-cli:2.17.65"

s3_endpoint=${S3_ENDPOINT:-}
s3_region=${S3_REGION:-auto}
s3_bucket=${S3_BUCKET:-}
s3_key=${S3_KEY:-}
s3_access_key=${AWS_ACCESS_KEY_ID:-}
s3_secret_key=${AWS_SECRET_ACCESS_KEY:-}
source_snapshot_at=${SOURCE_SNAPSHOT_AT:-}
verify_database=${VERIFY_DATABASE:-}
target_image=${TARGET_POSTGRES_IMAGE:-postgres:16-alpine}
target_password=${TARGET_POSTGRES_PASSWORD:-}
age_identity_file=${AGE_IDENTITY_FILE:-}
target_container=${TARGET_CONTAINER:-ploydok-restore-drill-$$}
keep_target=0
declare -a expected_rows=()

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY TARGET_POSTGRES_PASSWORD

usage() {
  sed -n '1,9p' "$0"
  cat <<'EOF'

Usage:
  scripts/restore-postgres-drill.sh [options]

Required environment or options:
  S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_KEY
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  TARGET_POSTGRES_PASSWORD  temporary password for the fresh target container
  SOURCE_SNAPSHOT_AT       UTC timestamp of the source database snapshot
  VERIFY_DATABASE           database restored by pg_dumpall to check
  EXPECT_ROWS               comma-separated table:count entries

Options:
  --s3-endpoint URL         S3-compatible endpoint
  --s3-region REGION        S3 region (default: auto)
  --s3-bucket BUCKET        bucket containing the dump
  --s3-key KEY              object key containing the dump
  --source-snapshot-at TS   source snapshot timestamp, for RPO
  --verify-database NAME    database containing the verification tables
  --expect-rows TABLE:N     expected row count, repeatable
  --target-image IMAGE      PostgreSQL image (default: postgres:16-alpine)
  --target-container NAME   task-owned container name
  --age-identity FILE       decrypt an object ending in .age
  --keep-target             keep the target container after verification
  --help                    show this help

The AWS CLI runs in a short-lived container with host networking. The target
container must be new and its name must start with ploydok-restore-drill-.
EOF
}

fail() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --s3-endpoint)
        (($# >= 2)) || fail "--s3-endpoint needs a value"
        s3_endpoint=$2
        shift 2
        ;;
      --s3-region)
        (($# >= 2)) || fail "--s3-region needs a value"
        s3_region=$2
        shift 2
        ;;
      --s3-bucket)
        (($# >= 2)) || fail "--s3-bucket needs a value"
        s3_bucket=$2
        shift 2
        ;;
      --s3-key)
        (($# >= 2)) || fail "--s3-key needs a value"
        s3_key=$2
        shift 2
        ;;
      --source-snapshot-at)
        (($# >= 2)) || fail "--source-snapshot-at needs a value"
        source_snapshot_at=$2
        shift 2
        ;;
      --verify-database)
        (($# >= 2)) || fail "--verify-database needs a value"
        verify_database=$2
        shift 2
        ;;
      --expect-rows)
        (($# >= 2)) || fail "--expect-rows needs a value"
        expected_rows+=("$2")
        shift 2
        ;;
      --target-image)
        (($# >= 2)) || fail "--target-image needs a value"
        target_image=$2
        shift 2
        ;;
      --target-container)
        (($# >= 2)) || fail "--target-container needs a value"
        target_container=$2
        shift 2
        ;;
      --age-identity)
        (($# >= 2)) || fail "--age-identity needs a value"
        age_identity_file=$2
        shift 2
        ;;
      --keep-target)
        keep_target=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "unknown option: $1"
        ;;
    esac
  done

  if [[ -n ${EXPECT_ROWS:-} ]]; then
    local -a env_expected=()
    IFS=',' read -r -a env_expected <<<"$EXPECT_ROWS"
    expected_rows+=("${env_expected[@]}")
  fi
}

validate_inputs() {
  [[ -n "$s3_endpoint" ]] || fail "S3_ENDPOINT is required"
  [[ -n "$s3_bucket" ]] || fail "S3_BUCKET is required"
  [[ -n "$s3_key" ]] || fail "S3_KEY is required"
  [[ -n "$s3_access_key" ]] || fail "AWS_ACCESS_KEY_ID is required"
  [[ -n "$s3_secret_key" ]] || fail "AWS_SECRET_ACCESS_KEY is required"
  [[ -n "$target_password" ]] || fail "TARGET_POSTGRES_PASSWORD is required"
  [[ -n "$source_snapshot_at" ]] || fail "SOURCE_SNAPSHOT_AT is required for RPO"
  [[ -n "$verify_database" ]] || fail "VERIFY_DATABASE is required"
  ((${#expected_rows[@]} > 0)) || fail "at least one --expect-rows entry is required"

  [[ "$target_container" =~ ^ploydok-restore-drill-[a-zA-Z0-9_.-]+$ ]] ||
    fail "target container must start with ploydok-restore-drill-"
  [[ "$verify_database" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] ||
    fail "VERIFY_DATABASE must be a simple PostgreSQL identifier"
  [[ "$s3_bucket" != */* ]] || fail "S3_BUCKET must not contain a slash"
  [[ "$s3_key" != /* ]] || fail "S3_KEY must be relative to the bucket"

  local entry table count
  for entry in "${expected_rows[@]}"; do
    [[ "$entry" == *:* ]] || fail "invalid row expectation: $entry"
    table=${entry%%:*}
    count=${entry##*:}
    [[ "$table" =~ ^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$ ]] ||
      fail "row expectation table must be schema.table or table: $table"
    [[ "$count" =~ ^[0-9]+$ ]] || fail "row expectation count must be an integer: $count"
  done

  if [[ -n "$age_identity_file" ]]; then
    [[ -r "$age_identity_file" ]] || fail "AGE_IDENTITY_FILE is not readable"
  elif [[ "$s3_key" == *.age ]]; then
    fail "an object ending in .age requires --age-identity"
  fi
}

parse_epoch() {
  date -u -d "$1" +%s 2>/dev/null ||
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null ||
    fail "could not parse UTC timestamp: $1"
}

wait_for_postgres() {
  local attempt
  for attempt in $(seq 1 90); do
    if docker exec --user postgres "$target_container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "target PostgreSQL did not become ready"
}

cleanup() {
  local status=$?
  if ((keep_target == 0)) && ((target_started == 1)); then
    docker rm -fv "$target_container" >/dev/null 2>&1 || true
  fi
  if [[ -n ${workdir:-} && -d "$workdir" ]]; then
    case "$workdir" in
      /tmp/ploydok-restore-drill.*) rm -rf -- "$workdir" ;;
    esac
  fi
  exit "$status"
}

parse_args "$@"
validate_inputs
require_command docker
require_command date
require_command mktemp
require_command grep
require_command awk

if docker container inspect "$target_container" >/dev/null 2>&1; then
  fail "target container already exists: $target_container"
fi

source_epoch=$(parse_epoch "$source_snapshot_at")
drill_started_epoch=$(date -u +%s)
workdir=$(mktemp -d -t ploydok-restore-drill.XXXXXX)
target_started=0
trap cleanup EXIT

downloaded="$workdir/backup"
(
  export AWS_ACCESS_KEY_ID="$s3_access_key"
  export AWS_SECRET_ACCESS_KEY="$s3_secret_key"
  docker run --rm --network host \
    -e AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY \
    -v "$workdir:/work" \
    "$S3_CLIENT_IMAGE" \
    s3 cp "s3://$s3_bucket/$s3_key" /work/backup \
    --endpoint-url "$s3_endpoint" \
    --region "$s3_region" \
    --only-show-errors >/dev/null
)
[[ -s "$downloaded" ]] || fail "downloaded S3 object is empty"

dump_file="$downloaded"
if [[ "$s3_key" == *.age ]]; then
  require_command age
  decrypted="$workdir/backup.sql"
  age --decrypt --identity "$age_identity_file" --output "$decrypted" "$downloaded" >/dev/null
  dump_file=$decrypted
fi

(
  export POSTGRES_PASSWORD="$target_password"
  docker run -d \
    --name "$target_container" \
    --label "ploydok.task=DEV-333-restore-drill" \
    --label "ploydok.owner=restore-postgres-drill.sh" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD \
    -e POSTGRES_DB=postgres \
    "$target_image" >/dev/null
)
target_started=1
wait_for_postgres

restore_log="$workdir/restore.log"
set +e
docker exec --user postgres -i "$target_container" \
  psql -X -U postgres -d postgres -v ON_ERROR_STOP=0 \
  <"$dump_file" >"$restore_log" 2>&1
restore_status=$?
set -e

unexpected_errors=$(awk '
  /^ERROR:/ {
    if ($0 !~ /^ERROR:[[:space:]]+role "postgres" already exists$/ &&
        $0 !~ /^ERROR:[[:space:]]+database "postgres" already exists$/) {
      count++
    }
  }
  END { print count + 0 }
' "$restore_log")
if ((restore_status != 0)); then
  fail "psql restore command failed"
fi
if ((unexpected_errors > 0)); then
  fail "psql restore reported $unexpected_errors unexpected SQL error(s)"
fi

verify_rows() {
  local entry table expected actual sql
  for entry in "${expected_rows[@]}"; do
    table=${entry%%:*}
    expected=${entry##*:}
    if [[ "$table" == *.* ]]; then
      sql="SELECT count(*) FROM $table;"
    else
      sql="SELECT count(*) FROM public.$table;"
    fi
    actual=$(docker exec --user postgres "$target_container" \
      psql -X -At -U postgres -d "$verify_database" -c "$sql" | tr -d '[:space:]')
    [[ "$actual" == "$expected" ]] ||
      fail "row count mismatch for $table: expected $expected, got $actual"
    printf 'ROW_COUNT table=%s expected=%s actual=%s\n' "$table" "$expected" "$actual"
  done
}

verify_rows

completed_epoch=$(date -u +%s)
rpo_seconds=$((drill_started_epoch - source_epoch))
rto_seconds=$((completed_epoch - drill_started_epoch))
((rpo_seconds >= 0)) || fail "source snapshot timestamp is in the future"

printf 'S3_OBJECT=s3://%s/%s\n' "$s3_bucket" "$s3_key"
printf 'SOURCE_SNAPSHOT_AT=%s\n' "$source_snapshot_at"
printf 'RPO_SECONDS=%s\n' "$rpo_seconds"
printf 'RTO_SECONDS=%s\n' "$rto_seconds"
printf 'RESTORE_STATUS=verified\n'
