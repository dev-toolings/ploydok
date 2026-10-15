// SPDX-License-Identifier: AGPL-3.0-only
import { stat, readFile } from "node:fs/promises"
import path from "node:path"
import {
  ALL_PROBE_KEYS,
  MANIFEST_FILE_PROBE_KEYS,
  classifyStackWithManifests,
} from "@ploydok/shared"
import type { ManifestContents, ProbeResults } from "@ploydok/shared"
import { FatalDeployError } from "./errors"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectedMethod = {
  method: "docker" | "nixpacks" | "static" | "compose"
  dockerfilePath?: string
}

export interface DetectOptions {
  workspacePath: string
  /** Sub-directory within the workspace to look in. Default: '.'. */
  rootDir?: string
  /** Force a build method (skip auto-detection). */
  override?: "docker" | "nixpacks" | "static" | "compose" | "auto"
  /** Dockerfile path relative to rootDir. Default: 'Dockerfile'. */
  dockerfilePath?: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether the project should be built with Docker or Nixpacks.
 *
 * Priority:
 *  1. Explicit `override` (docker | nixpacks | static).
 *  2. Dockerfile present at `<rootDir>/<dockerfilePath>` → docker (most explicit
 *     dev signal: "I took control, build exactly this").
 *  3. Shared framework classification (Compose, static, or Nixpacks).
 *
 * Railpack is deliberately not auto-detected: its current CLI needs a local
 * Docker daemon, which is absent from the production API container.
 */
export async function detectBuildMethod(
  opts: DetectOptions
): Promise<DetectedMethod> {
  const dockerfile = opts.dockerfilePath ?? "Dockerfile"

  if (opts.override === "docker") {
    return { method: "docker", dockerfilePath: dockerfile }
  }
  if (opts.override === "nixpacks") {
    return { method: "nixpacks" }
  }
  if (opts.override === "static") {
    return { method: "static" }
  }
  if (opts.override === "compose") {
    return { method: "compose" }
  }

  const root = path.join(opts.workspacePath, opts.rootDir ?? ".")

  try {
    await stat(path.join(root, dockerfile))
    return { method: "docker", dockerfilePath: dockerfile }
  } catch {
    // not found, continue
  }

  const probes: ProbeResults = {}
  const manifests: ManifestContents = {}
  await Promise.all(
    ALL_PROBE_KEYS.map(async (key) => {
      try {
        probes[key] = (await stat(path.join(root, key))).isFile()
      } catch {
        probes[key] = false
      }
    })
  )
  await Promise.all(
    MANIFEST_FILE_PROBE_KEYS.map(async (key) => {
      try {
        const file = path.join(root, key)
        const info = await stat(file)
        if (info.isFile() && info.size <= 64 * 1024)
          manifests[key] = await readFile(file, "utf8")
      } catch {
        /* Optional manifest enrichment. */
      }
    })
  )
  const classification = classifyStackWithManifests(probes, manifests)
  if (classification.ambiguous) {
    throw new FatalDeployError(
      "Several framework candidates were detected; select a framework preset before deploying"
    )
  }
  const method = classification.recommendedBuild
  return {
    method: method === "static" || method === "compose" ? method : "nixpacks",
  }
}
