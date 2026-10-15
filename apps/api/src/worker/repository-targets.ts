// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import {
  defaultRepositoryTarget,
  discoverRepositoryTargets,
} from "@ploydok/shared"
import { FatalDeployError } from "./errors"

/** Resolve only an unspecified root. Explicit paths/commands are authoritative. */
export async function resolveRepositoryRoot(options: {
  workspacePath: string
  rootDir: string | null
  hasExplicitConfig: boolean
}): Promise<string | null> {
  if (options.rootDir !== null || options.hasExplicitConfig)
    return options.rootDir
  const proc = Bun.spawn(
    ["git", "-C", options.workspacePath, "ls-files", "-z"],
    { stdout: "pipe", stderr: "pipe" }
  )
  const [output, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0)
    throw new FatalDeployError(
      "Cannot inspect repository application directories"
    )
  const root = await realpath(options.workspacePath)
  const targets = await discoverRepositoryTargets(
    output.split("\0").filter(Boolean),
    async (file) => {
      const candidate = path.join(root, file)
      const resolved = await realpath(candidate)
      const stat = await lstat(candidate)
      if (
        !resolved.startsWith(`${root}${path.sep}`) ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 64 * 1024
      ) {
        throw new FatalDeployError(
          `Cannot inspect application manifest: ${file}`
        )
      }
      return readFile(candidate, "utf8")
    }
  )
  const target = defaultRepositoryTarget(targets)
  if (target) return target.rootDir === "." ? null : target.rootDir
  if (targets.length > 1) {
    throw new FatalDeployError(
      `Multiple applications detected: ${targets.map((item) => item.rootDir).join(", ")}. Select the application's root directory or configure Compose.`
    )
  }
  return null
}
