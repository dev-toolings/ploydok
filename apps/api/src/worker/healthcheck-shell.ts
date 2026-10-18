// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quote one literal for a POSIX shell command.
 *
 * A single-quoted shell string cannot contain an unescaped single quote. The
 * standard POSIX representation closes the string, emits a literal quote,
 * then opens it again: ' -> '\''.
 */
export function quotePosixShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// Slim runtime images (node:*-slim, oven/bun, python:*-slim) ship no curl or
// wget: probe with the language runtime instead. 2xx-4xx counts as alive, like
// the curl branch.
const JS_PROBE =
  'fetch(process.argv.at(-1),{redirect:"manual",signal:AbortSignal.timeout(5000)})' +
  ".then((r)=>process.exit(r.status>=200&&r.status<500?0:1),()=>process.exit(1))"
const PYTHON_PROBE =
  "import sys,urllib.request,urllib.error\n" +
  "try:\n urllib.request.urlopen(sys.argv[1],timeout=5)\n" +
  "except urllib.error.HTTPError as e:\n sys.exit(0 if e.code<500 else 1)\n" +
  "except Exception:\n sys.exit(1)"

/**
 * Build the HTTP healthcheck used by Docker and Swarm containers.
 *
 * The host is expanded by the shell, while the port and path are emitted as
 * one single-quoted literal suffix. Adjacent shell words concatenate, so the
 * resulting URL remains `http://$host:<port><path>` without letting the path
 * alter the surrounding command.
 */
export function healthcheckShell(port: number, path: string): string {
  const urlSuffix = quotePosixShellLiteral(`:${port}${path}`)
  const url = `"http://$host"${urlSuffix}`
  return (
    `for host in 127.0.0.1 "$(hostname 2>/dev/null)"; do ` +
    `[ -z "$host" ] && continue; ` +
    `if command -v curl >/dev/null 2>&1; then ` +
    `code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://$host"${urlSuffix} || true)"; ` +
    `case "$code" in [234][0-9][0-9]) exit 0;; esac; ` +
    `fi; ` +
    `if command -v wget >/dev/null 2>&1; then ` +
    `wget -q -O /dev/null --timeout=5 "http://$host"${urlSuffix} && exit 0; ` +
    `fi; ` +
    `if command -v node >/dev/null 2>&1; then ` +
    `node -e ${quotePosixShellLiteral(JS_PROBE)} ${url} && exit 0; ` +
    `elif command -v bun >/dev/null 2>&1; then ` +
    `bun -e ${quotePosixShellLiteral(JS_PROBE)} ${url} && exit 0; ` +
    `fi; ` +
    `if command -v python3 >/dev/null 2>&1; then ` +
    `python3 -c ${quotePosixShellLiteral(PYTHON_PROBE)} ${url} && exit 0; ` +
    `fi; ` +
    `done; exit 1`
  )
}
