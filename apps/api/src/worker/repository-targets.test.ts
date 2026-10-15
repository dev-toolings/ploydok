// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveRepositoryRoot } from "./repository-targets"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
})
async function repository(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ploydok-targets-"))
  directories.push(dir)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), content)
  }
  for (const command of [
    ["git", "init", "-q", dir],
    ["git", "-C", dir, "add", "."],
  ]) {
    if (
      (await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
        .exited) !== 0
    )
      throw new Error("Fixture Git setup failed")
  }
  return dir
}

it("resolves the single application from the real cloned Git index", async () => {
  const workspacePath = await repository({
    "package.json": '{"private":true}',
    "custom/python/requirements.txt": "fastapi",
    "custom/python/main.py": "",
  })
  expect(
    await resolveRepositoryRoot({
      workspacePath,
      rootDir: null,
      hasExplicitConfig: false,
    })
  ).toBe("custom/python")
})

it("stops before building when several applications require a choice", async () => {
  const workspacePath = await repository({
    "services/a/go.mod": "module a",
    "services/b/Cargo.toml": "[package]",
  })
  await expect(
    resolveRepositoryRoot({
      workspacePath,
      rootDir: null,
      hasExplicitConfig: false,
    })
  ).rejects.toThrow("services/a, services/b")
})

it("continues legacy root selection with a warning for a previously successful app", async () => {
  const workspacePath = await repository({
    "services/a/go.mod": "module a",
    "services/b/Cargo.toml": "[package]",
  })
  const warnings: string[] = []

  await expect(
    resolveRepositoryRoot({
      workspacePath,
      rootDir: null,
      hasExplicitConfig: false,
      allowLegacyAmbiguous: true,
      onWarning: (warning) => warnings.push(warning),
    })
  ).resolves.toBeNull()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("previous successful build")
})

it("preserves explicit roots and commands without guessing", async () => {
  expect(
    await resolveRepositoryRoot({
      workspacePath: "/not-a-repository",
      rootDir: ".",
      hasExplicitConfig: false,
    })
  ).toBe(".")
  expect(
    await resolveRepositoryRoot({
      workspacePath: "/not-a-repository",
      rootDir: null,
      hasExplicitConfig: true,
    })
  ).toBeNull()
})
