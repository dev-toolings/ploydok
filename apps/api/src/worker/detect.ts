// SPDX-License-Identifier: AGPL-3.0-only
import { stat } from "node:fs/promises"
import path from "node:path"

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
 *  3. Fallback → nixpacks (universal default, broadest language coverage).
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

  return { method: "nixpacks" }
}
