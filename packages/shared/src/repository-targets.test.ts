// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  defaultRepositoryTarget,
  discoverRepositoryTargets,
  ManifestTooLargeError,
} from "./repository-targets"

function discover(files: Record<string, string>) {
  return discoverRepositoryTargets(
    Object.keys(files),
    async (path) => files[path]!
  )
}

describe("repository application targets", () => {
  it("finds arbitrary nested services and skips a metadata-only root", async () => {
    const targets = await discover({
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["products/*"],
        devDependencies: { prettier: "3" },
      }),
      "products/store/package.json": JSON.stringify({
        scripts: { build: "vite build" },
        dependencies: { vite: "7" },
      }),
      "products/store/index.html": "<html />",
      "services/orders/composer.json": JSON.stringify({
        require: { "laravel/framework": "12" },
      }),
      "services/orders/artisan": "<?php",
    })
    expect(
      targets.map((target) => [target.rootDir, target.classification.stack])
    ).toEqual([
      ["products/store", "static"],
      ["services/orders", "laravel"],
    ])
    expect(defaultRepositoryTarget(targets)).toBeUndefined()
  })

  it("selects a single nested non-JavaScript application", async () => {
    const targets = await discover({
      "custom/deep/service/go.mod": "module example.com/service",
    })
    expect(defaultRepositoryTarget(targets)?.rootDir).toBe(
      "custom/deep/service"
    )
    expect(targets[0]?.classification.stack).toBe("go")
  })

  it("keeps a deployable repository root and explicit orchestration", async () => {
    const targets = await discover({
      "compose.yaml": "services: {}",
      "backend/Cargo.toml": "[package]",
    })
    expect(defaultRepositoryTarget(targets)?.rootDir).toBe(".")
    expect(
      defaultRepositoryTarget(targets)?.classification.recommendedBuild
    ).toBe("compose")
  })

  it("groups Symfony bin/console with its application and ignores dependencies", async () => {
    const targets = await discover({
      "server/composer.json": "{}",
      "server/bin/console": "<?php",
      "node_modules/dependency/package.json": "{}",
      "vendor/library/composer.json": "{}",
    })
    expect(targets.map((target) => target.rootDir)).toEqual(["server"])
    expect(targets[0]?.classification.stack).toBe("symfony")
  })

  it("never turns failed manifest reads into successful detection", async () => {
    await expect(
      discoverRepositoryTargets(["package.json"], async () => {
        throw new Error("provider unavailable")
      })
    ).rejects.toThrow("provider unavailable")
  })

  it("requires a choice when both the root and a nested service are applications", async () => {
    const targets = await discover({
      "package.json": JSON.stringify({ scripts: { start: "custom-server" } }),
      "services/worker/go.mod": "module worker",
    })
    expect(targets).toHaveLength(2)
    expect(defaultRepositoryTarget(targets)).toBeUndefined()
  })

  it("requires a framework choice for a hybrid Node plus Django root", async () => {
    const targets = await discover({
      "package.json": JSON.stringify({
        scripts: { start: "node server.js" },
      }),
      "manage.py": "#!/usr/bin/env python\n",
      "requirements.txt": "Django==5.2\n",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]?.classification.ambiguous).toBe(true)
    expect(defaultRepositoryTarget(targets)).toBeUndefined()
  })
})

it("skips workspace-only build manifests across ecosystems", async () => {
  for (const root of [
    {
      "package.json": JSON.stringify({
        workspaces: ["modules/*"],
        scripts: { build: "turbo build" },
      }),
    },
    { "Cargo.toml": '[workspace]\nmembers = ["modules/*"]' },
    { "pom.xml": "<project><packaging>pom</packaging><modules /></project>" },
  ]) {
    const targets = await discover({
      ...root,
      "modules/service/go.mod": "module service",
    } as Record<string, string>)
    expect(defaultRepositoryTarget(targets)?.rootDir).toBe("modules/service")
  }
})

it("preserves a root Dockerfile without depending on unrelated manifests", async () => {
  const targets = await discover({
    Dockerfile: "FROM alpine",
    "package.json": "not json",
    "nested/go.mod": "module nested",
  })
  expect(
    defaultRepositoryTarget(targets)?.classification.recommendedBuild
  ).toBe("dockerfile")
  expect(defaultRepositoryTarget(targets)?.rootDir).toBe(".")
})

it("skips an oversized manifest and still classifies the monorepo", async () => {
  const files: Record<string, string> = {
    "apps/web/package.json": JSON.stringify({
      scripts: { build: "vite build" },
      dependencies: { vite: "7" },
    }),
    "apps/web/index.html": "<html />",
    "apps/api/composer.json": JSON.stringify({
      require: { "laravel/framework": "12" },
    }),
    "apps/api/composer.lock": "",
    "apps/api/artisan": "<?php",
  }
  const targets = await discoverRepositoryTargets(
    Object.keys(files),
    async (path) => {
      if (path.endsWith("composer.lock"))
        throw new ManifestTooLargeError("too large")
      return files[path]!
    }
  )
  expect(
    targets.map((target) => [target.rootDir, target.classification.stack])
  ).toEqual([
    ["apps/api", "laravel"],
    ["apps/web", "static"],
  ])
  expect(defaultRepositoryTarget(targets)).toBeUndefined()
  const laravel = targets.find((target) => target.rootDir === "apps/api")
  expect(laravel?.classification.confidence).toBe("high")
  expect(laravel?.classification.presetId).toBe("laravel")
  expect(laravel?.classification.evidence).toEqual([
    "composer.json",
    "artisan",
  ])
})

it("still propagates non-size read errors", async () => {
  await expect(
    discoverRepositoryTargets(["composer.json", "artisan"], async () => {
      throw new Error("401 unauthorized")
    })
  ).rejects.toThrow("401 unauthorized")
})

it("lists versioned SQLite files under their application root", async () => {
  const targets = await discover({
    Dockerfile:
      "ARG NODE_IMAGE=node:22\nFROM ${NODE_IMAGE}\nARG SITE_URL TARGETARCH\n",
    "packages/content/guides.sqlite": "",
    "node_modules/pkg/fixture.sqlite": "",
    "docs/notes.db": "",
  })
  expect(targets).toEqual([
    {
      rootDir: ".",
      classification: expect.anything(),
      sqliteFiles: ["packages/content/guides.sqlite"],
      requiredBuildArgs: ["SITE_URL"],
    },
  ])
})
