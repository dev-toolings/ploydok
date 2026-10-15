// SPDX-License-Identifier: AGPL-3.0-only
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
      targets.push({ rootDir, classification: explicit })
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
    if (classification.stack !== "unknown")
      targets.push({ rootDir, classification })
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
    (root.classification.recommendedBuild === "dockerfile" ||
      root.classification.recommendedBuild === "compose")
  )
    return root
  return targets.length === 1 ? targets[0] : undefined
}
