// SPDX-License-Identifier: AGPL-3.0-only

// Predefined by BuildKit: never reported as missing.
const AUTOMATIC_BUILD_ARG =
  /^(?:(?:TARGET|BUILD)(?:PLATFORM|OS|ARCH|VARIANT)|(?:HTTPS?|FTP|NO|ALL)_PROXY)$/i

export interface DockerfileArg {
  name: string
  hasDefault: boolean
}

/** `ARG` declarations of a Dockerfile, merged across stages. */
export function parseDockerfileArgs(content: string): DockerfileArg[] {
  const args = new Map<string, boolean>()
  const logical = content.replace(/\\\r?\n/g, " ")
  for (const line of logical.split(/\r?\n/)) {
    const match = /^\s*ARG\s+(.+)$/i.exec(line)
    if (!match) continue
    for (const token of match[1]!.trim().split(/\s+/)) {
      const [name, ...rest] = token.split("=")
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
      // A stage-level `ARG X` inherits a global `ARG X=value`.
      args.set(name, (args.get(name) ?? false) || rest.length > 0)
    }
  }
  return [...args].map(([name, hasDefault]) => ({ name, hasDefault }))
}

/** Declared build args with no default value that the user must provide. */
export function requiredDockerfileArgs(
  args: readonly DockerfileArg[]
): string[] {
  return args
    .filter(
      ({ name, hasDefault }) => !hasDefault && !AUTOMATIC_BUILD_ARG.test(name)
    )
    .map(({ name }) => name)
}
