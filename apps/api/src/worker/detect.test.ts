// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { detectBuildMethod } from "./detect"

describe("detectBuildMethod", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ploydok-detect-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // Override mode
  // ---------------------------------------------------------------------------

  it("override=docker → returns docker without inspecting filesystem", async () => {
    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      override: "docker",
    })
    expect(result.method).toBe("docker")
    expect(result.dockerfilePath).toBe("Dockerfile")
  })

  it("override=docker with custom dockerfilePath → returns that path", async () => {
    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      override: "docker",
      dockerfilePath: "docker/Dockerfile.prod",
    })
    expect(result.method).toBe("docker")
    expect(result.dockerfilePath).toBe("docker/Dockerfile.prod")
  })

  it("override=nixpacks → returns nixpacks without inspecting filesystem", async () => {
    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      override: "nixpacks",
    })
    expect(result.method).toBe("nixpacks")
    expect(result.dockerfilePath).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // Auto-detection with Dockerfile present
  // ---------------------------------------------------------------------------

  it("auto-detect: Dockerfile at root → returns docker", async () => {
    await writeFile(path.join(tmpDir, "Dockerfile"), "FROM alpine\n")

    const result = await detectBuildMethod({ workspacePath: tmpDir })
    expect(result.method).toBe("docker")
    expect(result.dockerfilePath).toBe("Dockerfile")
  })

  it("auto-detect: Dockerfile in rootDir sub-path → returns docker", async () => {
    const subDir = path.join(tmpDir, "apps", "web")
    await mkdir(subDir, { recursive: true })
    await writeFile(path.join(subDir, "Dockerfile"), "FROM node:20\n")

    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      rootDir: "apps/web",
    })
    expect(result.method).toBe("docker")
    expect(result.dockerfilePath).toBe("Dockerfile")
  })

  it("auto-detect: custom dockerfilePath → uses that name", async () => {
    await writeFile(path.join(tmpDir, "Dockerfile.prod"), "FROM alpine\n")

    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      dockerfilePath: "Dockerfile.prod",
    })
    expect(result.method).toBe("docker")
    expect(result.dockerfilePath).toBe("Dockerfile.prod")
  })

  // ---------------------------------------------------------------------------
  // Auto-detection without Dockerfile
  // ---------------------------------------------------------------------------

  it("auto-detect: no Dockerfile → returns nixpacks", async () => {
    // tmpDir is empty — no Dockerfile
    const result = await detectBuildMethod({ workspacePath: tmpDir })
    expect(result.method).toBe("nixpacks")
    expect(result.dockerfilePath).toBeUndefined()
  })

  it("auto-detect: Dockerfile in wrong dir → returns nixpacks", async () => {
    // Dockerfile is at root but rootDir points to sub-dir without one
    await writeFile(path.join(tmpDir, "Dockerfile"), "FROM alpine\n")
    await mkdir(path.join(tmpDir, "api"), { recursive: true })

    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      rootDir: "api",
    })
    expect(result.method).toBe("nixpacks")
  })

  // ---------------------------------------------------------------------------
  // override=auto falls through to auto-detect
  // ---------------------------------------------------------------------------

  it("override=auto behaves like no override (detects Dockerfile)", async () => {
    await writeFile(path.join(tmpDir, "Dockerfile"), "FROM alpine\n")

    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      override: "auto",
    })
    expect(result.method).toBe("docker")
  })

  it("override=auto behaves like no override (falls back to nixpacks)", async () => {
    const result = await detectBuildMethod({
      workspacePath: tmpDir,
      override: "auto",
    })
    expect(result.method).toBe("nixpacks")
  })

  it("auto-detection refuses an ambiguous Node plus Django repository", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } })
    )
    await writeFile(path.join(tmpDir, "manage.py"), "#!/usr/bin/env python\n")
    await writeFile(path.join(tmpDir, "requirements.txt"), "Django==5.2\n")

    await expect(detectBuildMethod({ workspacePath: tmpDir })).rejects.toThrow(
      "Several framework candidates were detected"
    )
  })

  it("an explicit build override remains usable for an ambiguous repository", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } })
    )
    await writeFile(path.join(tmpDir, "manage.py"), "#!/usr/bin/env python\n")
    await writeFile(path.join(tmpDir, "requirements.txt"), "Django==5.2\n")

    await expect(
      detectBuildMethod({ workspacePath: tmpDir, override: "nixpacks" })
    ).resolves.toEqual({ method: "nixpacks" })
  })

  // ---------------------------------------------------------------------------
  // Railpack is planned but unavailable without a local Docker daemon
  // ---------------------------------------------------------------------------

  it("does not auto-detect Railpack from railpack.json", async () => {
    await writeFile(path.join(tmpDir, "railpack.json"), "{}\n")

    const result = await detectBuildMethod({ workspacePath: tmpDir })
    expect(result.method).toBe("nixpacks")
    expect(result.dockerfilePath).toBeUndefined()
  })

  it("auto-detect: Dockerfile + railpack.json → Dockerfile wins", async () => {
    await writeFile(path.join(tmpDir, "Dockerfile"), "FROM alpine\n")
    await writeFile(path.join(tmpDir, "railpack.json"), "{}\n")

    const result = await detectBuildMethod({ workspacePath: tmpDir })
    expect(result.method).toBe("docker")
    expect(result.dockerfilePath).toBe("Dockerfile")
  })
})

it("auto detection agrees with the wizard for Compose and static applications", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ploydok-methods-"))
  try {
    await writeFile(path.join(dir, "index.html"), "<html />")
    expect((await detectBuildMethod({ workspacePath: dir })).method).toBe(
      "static"
    )
    await writeFile(path.join(dir, "compose.yaml"), "services: {}")
    expect((await detectBuildMethod({ workspacePath: dir })).method).toBe(
      "compose"
    )
    expect(
      (await detectBuildMethod({ workspacePath: dir, override: "nixpacks" }))
        .method
    ).toBe("nixpacks")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
