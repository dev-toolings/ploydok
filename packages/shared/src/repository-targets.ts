// SPDX-License-Identifier: AGPL-3.0-only
import { parseDockerfileArgs, requiredDockerfileArgs } from "./dockerfile-args"
import {
  ALL_PROBE_KEYS,
  MANIFEST_FILE_PROBE_KEYS,
  classifyStackWithManifests,
} from "./stack-classifier"
import type {
  ManifestContents,
  ProbeResults,
  StackClassification,
} from "./stack-classifier"

/** Thrown by manifest readers when a file exceeds the inspection size cap. */
export class ManifestTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManifestTooLargeError"
  }
}

export interface RepositoryTarget {
  rootDir: string
  classification: StackClassification
  /** Versioned SQLite files under this root: embedded, not a managed service. */
  sqliteFiles?: string[]
  /** Dockerfile `ARG`s without a default: the build needs a value for each. */
  requiredBuildArgs?: string[]
}

const SQLITE_FILE = /\.(sqlite3?|db3)$/i
const MAX_SQLITE_FILES = 5

function sqliteFilesUnder(files: Set<string>, rootDir: string): string[] {
  const prefix = rootDir === "." ? "" : `${rootDir}/`
  return [...files]
    .filter((file) => file.startsWith(prefix) && SQLITE_FILE.test(file))
    .sort()
    .slice(0, MAX_SQLITE_FILES)
}

function withSqliteFiles(
  target: RepositoryTarget,
  files: Set<string>
): RepositoryTarget {
  const sqliteFiles = sqliteFilesUnder(files, target.rootDir)
  return sqliteFiles.length > 0 ? { ...target, sqliteFiles } : target
}

const markers = ALL_PROBE_KEYS.filter(
  (key) =>
    !key.startsWith(".env") &&
    ![
      "bun.lock",
      "bun.lockb",
      ".ruby-version",
      "main.py",
      "app.py",
      "wsgi.py",
    ].includes(key)
)
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".output",
  ".next",
])

async function readRequiredBuildArgs(
  path: string,
  readFile: (path: string) => Promise<string>
): Promise<string[]> {
  try {
    return requiredDockerfileArgs(parseDockerfileArgs(await readFile(path)))
  } catch (error) {
    // An oversized Dockerfile only loses the hint, never the detection.
    if (error instanceof ManifestTooLargeError) return []
    throw error
  }
}

/** Paths come from a provider tree or a cloned Git index, never guessed folders. */
export async function discoverRepositoryTargets(
  paths: readonly string[],
  readFile: (path: string) => Promise<string>
): Promise<RepositoryTarget[]> {
  const files = new Set(
    paths.filter((path) => {
      const parts = path.split("/")
      return (
        !path.startsWith("/") &&
        !path.includes("\\") &&
        parts.every(
          (part) =>
            part !== ".." && part !== "." && !ignoredDirectories.has(part)
        )
      )
    })
  )
  const orderedMarkers = [...markers].sort((a, b) => b.length - a.length)
  const roots = new Set<string>()
  for (const file of files) {
    // Match the longest marker first (bin/console belongs to the app above bin).
    const marker = orderedMarkers.find(
      (key) => file === key || file.endsWith(`/${key}`)
    )
    if (marker)
      roots.add(file === marker ? "." : file.slice(0, -(marker.length + 1)))
  }
  if (roots.size > 40)
    throw new Error(
      "Too many application directories; select a root directory manually"
    )
  const targets: RepositoryTarget[] = []
  // Bound provider requests rather than reading every manifest in parallel.
  for (const rootDir of [...roots].sort()) {
    const prefix = rootDir === "." ? "" : `${rootDir}/`
    const probes: ProbeResults = Object.fromEntries(
      ALL_PROBE_KEYS.map((key) => [key, files.has(`${prefix}${key}`)])
    )
    const explicit = classifyStackWithManifests(probes)
    if (
      explicit.recommendedBuild === "dockerfile" ||
      explicit.recommendedBuild === "compose"
    ) {
      const target = withSqliteFiles(
        { rootDir, classification: explicit },
        files
      )
      const requiredBuildArgs =
        explicit.recommendedBuild === "dockerfile"
          ? await readRequiredBuildArgs(`${prefix}Dockerfile`, readFile)
          : []
      targets.push(
        requiredBuildArgs.length > 0 ? { ...target, requiredBuildArgs } : target
      )
      continue
    }
    const manifests: ManifestContents = {}
    for (const key of MANIFEST_FILE_PROBE_KEYS) {
      if (!files.has(`${prefix}${key}`)) continue
      try {
        manifests[key] = await readFile(`${prefix}${key}`)
      } catch (error) {
        // An oversized optional manifest must not abort detection.
        if (!(error instanceof ManifestTooLargeError)) throw error
      }
    }
    // A metadata/workspace package is not an executable application by itself.
    if (probes["package.json"] && manifests["package.json"]) {
      const pkg = JSON.parse(manifests["package.json"]) as Record<
        string,
        unknown
      >
      const scripts = pkg.scripts as Record<string, unknown> | undefined
      const dependencies = { ...(pkg.dependencies as object) }
      const otherRuntime = markers.some(
        (key) => key !== "package.json" && probes[key]
      )
      const workspaceOnly =
        Boolean(pkg.workspaces) &&
        !scripts?.start &&
        !pkg.main &&
        Object.keys(dependencies).length === 0 &&
        !otherRuntime
      if (
        workspaceOnly ||
        (!otherRuntime &&
          !scripts?.start &&
          !scripts?.build &&
          !pkg.main &&
          !pkg.bin &&
          Object.keys(dependencies).length === 0)
      )
        continue
    }
    const cargo = manifests["Cargo.toml"]
    if (
      cargo &&
      /^\s*\[workspace\]/m.test(cargo) &&
      !/^\s*\[package\]/m.test(cargo)
    )
      continue
    const pom = manifests["pom.xml"]
    if (pom && /<packaging>\s*pom\s*<\/packaging>/.test(pom)) continue
    const classification = classifyStackWithManifests(probes, manifests)
    if (classification.stack !== "unknown" || classification.ambiguous)
      targets.push(withSqliteFiles({ rootDir, classification }, files))
  }
  return targets
}

/** Explicit root orchestration wins; other multi-app repos require a choice. */
export function defaultRepositoryTarget(
  targets: readonly RepositoryTarget[]
): RepositoryTarget | undefined {
  const root = targets.find((target) => target.rootDir === ".")
  if (
    root &&
    !root.classification.ambiguous &&
    (root.classification.recommendedBuild === "dockerfile" ||
      root.classification.recommendedBuild === "compose")
  )
    return root
  return targets.length === 1 && !targets[0]?.classification.ambiguous
    ? targets[0]
    : undefined
}
