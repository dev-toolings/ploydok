# SPDX-License-Identifier: AGPL-3.0-only
# Fixed legacy HTTP probe, embedded in the native executable. Port and path
# arrive as positional arguments, never as caller-supplied shell source.
for host in 127.0.0.1 "$(hostname 2>/dev/null)"; do
  [ -z "$host" ] && continue
  url="http://$host:$1$2"
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$url" || true)"
    case "$code" in [234][0-9][0-9]) exit 0;; esac
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null --timeout=5 "$url" && exit 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'fetch(process.argv.at(-1),{redirect:"manual",signal:AbortSignal.timeout(5000)}).then((r)=>process.exit(r.status>=200&&r.status<500?0:1),()=>process.exit(1))' "$url" && exit 0
  elif command -v bun >/dev/null 2>&1; then
    bun -e 'fetch(process.argv.at(-1),{redirect:"manual",signal:AbortSignal.timeout(5000)}).then((r)=>process.exit(r.status>=200&&r.status<500?0:1),()=>process.exit(1))' "$url" && exit 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request,urllib.error
try:
 urllib.request.urlopen(sys.argv[1],timeout=5)
except urllib.error.HTTPError as e:
 sys.exit(0 if e.code<500 else 1)
except Exception:
 sys.exit(1)' "$url" && exit 0
  fi
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'healthcheck impossible: /bin/sh exists but no supported HTTP client (curl, wget, node, bun or python3) is installed' >&2
else
  printf '%s\n' 'healthcheck failed: shell HTTP probe received no successful response (connection refused, timeout, invalid HTTP or 5xx)' >&2
fi
exit 1
