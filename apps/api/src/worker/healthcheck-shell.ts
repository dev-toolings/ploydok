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
    `done; exit 1`
  )
}
