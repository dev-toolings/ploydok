// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { FatalDeployError } from "../errors"

const queryMocks = {
  getPreviewDeployment: mock(async () => ({
    id: "app-1:pr-42",
    app_id: "app-1",
    pr_number: 42,
    head_sha: "oldsha000000000000000000000000000000000000",
    domain: "pr-42.preview.example.com",
    container_id: "old-preview-container",
    status: "running",
  })),
  getLastSucceededBuild: mock(async () => null),
  getGitHubAppConfig: mock(async () => null),
  updatePreviewDeployment: mock(async () => {}),
  updatePreviewDeploymentStatus: mock(async () => {}),
}

const gitMocks = {
  cloneRepo: mock(async () => ({
    workspacePath: "/tmp/preview-workspace",
    headSha: "oldsha000000000000000000000000000000000000",
  })),
  cleanupWorkspace: mock(async () => {}),
}

const detectMocks = {
  detectBuildMethod: mock(async () => ({
    method: "docker",
    dockerfilePath: "Dockerfile",
  })),
}

const repositoryTargetMocks = {
  resolveRepositoryRoot: mock(async () => null),
}

const buildkitMocks = {
  buildImage: mock(async () => ({
    imageDigest: "sha256:test",
    durationMs: 1200,
  })),
}

const agentInstance = {
  imagePull: async function* () {
    yield { status: "Pulled" }
  },
  containerCreate: mock(async () => ({ containerId: "ctr-new" })),
  containerStart: mock(async () => ({})),
  inspectContainerHealth: mock(async () => ({
    status: 3,
    containerMissing: false,
    failingStreak: 0,
    lastProbeOutput: "",
  })),
  containerStop: mock(async () => ({})),
  containerRemove: mock(async () => ({})),
}

const caddyInstance = {
  upsertRoute: mock(async () => {}),
  upsertStaticRoute: mock(async () => {}),
  removeRoute: mock(async () => {}),
}

const singletonMocks = {
  getSharedAgent: mock(() => agentInstance),
  getSharedCaddy: mock(() => caddyInstance),
}

const secretsMocks = {
  buildEnvPairForDeploy: mock(async () => ({
    build: { BUILD_SECRET: "1" },
    runtime: { RUNTIME_SECRET: "1" },
  })),
}

mock.module("@ploydok/db/queries", () => queryMocks)
mock.module("../git", () => gitMocks)
mock.module("../detect", () => detectMocks)
mock.module("../repository-targets", () => repositoryTargetMocks)
mock.module("../buildkit", () => buildkitMocks)
mock.module("../../debug/singletons", () => singletonMocks)
mock.module("../../secrets/resolver", () => secretsMocks)
mock.module("../../services/framework-env", () => ({
  assertDeployableFrameworkEnv: mock(() => {}),
  ensureFrameworkEnvVars: mock(async () => ({
    injected: [],
    skipped: [],
    repaired: [],
  })),
}))
mock.module("../../github/installation-tokens", () => ({
  getInstallationToken: mock(async () => "ghs_preview"),
  listAppInstallations: mock(async () => []),
}))
mock.module("../../github/installation-tokens.ts", () => ({
  getInstallationToken: mock(async () => "ghs_preview"),
  listAppInstallations: mock(async () => []),
}))
mock.module("../../services/projects", () => ({
  ensureProjectNetwork: mock(async () => "ploydok-proj-proj-1"),
  networksForApp: mock(() => ["ploydok-proj-proj-1"]),
}))
mock.module("../../caddy/attachment", () => ({
  ensureCaddyOnProjectNetwork: mock(async () => {}),
}))
mock.module("../detect-port", () => ({
  detectDockerfilePort: mock(async () => 8080),
}))
mock.module("../nixpacks", () => ({
  nixpacksBuild: mock(async () => {}),
}))
mock.module("../../env", () => ({
  defaultStateDir: (name: string) => `/tmp/ploydok-test/${name}`,
  env: {
    PLOYDOK_BUILD_DIR: "/tmp/ploydok-builds",
    PLOYDOK_REGISTRY_URL: "http://127.0.0.1:5000",
    PLOYDOK_REGISTRY_PUSH_URL: "http://registry:5000",
  },
}))

function makeDb(appOverrides: Record<string, unknown> = {}) {
  const appRow = {
    id: "app-1",
    project_id: "proj-1",
    slug: "preview-app",
    git_provider: "github",
    repo_full_name: "acme/repo",
    branch: "main",
    github_installation_id: "inst-1",
    root_dir: null,
    dockerfile_path: null,
    nixpacks_config_path: null,
    node_version: null,
    install_command: null,
    build_command: null,
    start_command: null,
    build_method: "docker",
    static_output_dir: "dist",
    static_spa_fallback: true,
    runtime_port: 8080,
    restart_policy: "unless-stopped",
    preview_enabled: true,
    healthcheck_path: "/health",
    healthcheck_port: 8080,
    healthcheck_interval_s: 0,
    healthcheck_timeout_s: 1,
    healthcheck_retries: 1,
    healthcheck_start_period_s: 0,
    plan: "custom",
    cpu_limit: null,
    mem_limit_bytes: null,
    pids_limit: null,
    owner_id: "user-1",
    ...appOverrides,
  }

  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [appRow],
          }),
        }),
      }),
    }),
  } as unknown
}

describe("handlePreviewDeploy", () => {
  it("surfaces the impossible healthcheck cause and keeps the previous preview route", async () => {
    const cause = "healthcheck impossible: /bin/sh exists but no supported HTTP client is installed"
    agentInstance.inspectContainerHealth.mockImplementationOnce(async () => ({
      status: 2, containerMissing: false, failingStreak: 0, lastProbeOutput: cause,
    }))
    const originalSpawn = Bun.spawn
    Bun.spawn = ((args: string[]) => ({
      stdout: args.includes("rev-parse")
        ? new Blob(["abcdef1234567890abcdef1234567890abcdef12"]).stream()
        : new ReadableStream(),
      stderr: new ReadableStream(), exited: Promise.resolve(0),
    })) as typeof Bun.spawn
    try {
      const { handlePreviewDeploy } = await import("./preview-deploy")
      await expect(handlePreviewDeploy(makeDb() as never, {
        appId: "app-1", prNumber: 42,
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
      })).rejects.toThrow(cause)
      expect(caddyInstance.upsertRoute).not.toHaveBeenCalled()
      expect(agentInstance.containerRemove).toHaveBeenCalled()
    } finally {
      Bun.spawn = originalSpawn
    }
  })
  beforeEach(() => {
    queryMocks.getPreviewDeployment.mockClear()
    queryMocks.getLastSucceededBuild.mockClear()
    queryMocks.updatePreviewDeployment.mockClear()
    queryMocks.updatePreviewDeployment.mockImplementation(async () => {})
    queryMocks.updatePreviewDeploymentStatus.mockClear()
    queryMocks.updatePreviewDeploymentStatus.mockImplementation(async () => {})
    gitMocks.cloneRepo.mockClear()
    gitMocks.cleanupWorkspace.mockClear()
    detectMocks.detectBuildMethod.mockClear()
    detectMocks.detectBuildMethod.mockImplementation(async () => ({
      method: "docker",
      dockerfilePath: "Dockerfile",
    }))
    buildkitMocks.buildImage.mockClear()
    agentInstance.containerCreate.mockClear()
    agentInstance.containerStart.mockClear()
    agentInstance.inspectContainerHealth.mockClear()
    agentInstance.inspectContainerHealth.mockImplementation(async () => ({
      status: 3,
      containerMissing: false,
      failingStreak: 0,
      lastProbeOutput: "",
    }))
    agentInstance.containerStop.mockClear()
    agentInstance.containerRemove.mockClear()
    caddyInstance.upsertRoute.mockClear()
    caddyInstance.upsertStaticRoute.mockClear()
    caddyInstance.removeRoute.mockClear()
  })

  it("provisions a runtime preview and swaps the old container after success", async () => {
    const checkoutSpawn = mock(() => ({
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
    }))
    const revParseSpawn = mock(() => ({
      stdout: new Blob(["abcdef1234567890abcdef1234567890abcdef12"]).stream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
    }))
    const originalSpawn = Bun.spawn
    Bun.spawn = ((args: string[]) => {
      if (args.includes("rev-parse")) return revParseSpawn()
      return checkoutSpawn()
    }) as typeof Bun.spawn

    try {
      const { handlePreviewDeploy } = await import("./preview-deploy")
      await handlePreviewDeploy(makeDb() as never, {
        appId: "app-1",
        prNumber: 42,
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
      })

      expect(queryMocks.updatePreviewDeployment).toHaveBeenCalledWith(
        expect.anything(),
        "app-1:pr-42",
        expect.objectContaining({ status: "building" })
      )
      expect(buildkitMocks.buildImage).toHaveBeenCalledTimes(1)
      expect(caddyInstance.upsertRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "preview-app-1-app-1-pr-42",
          host: "pr-42.preview.example.com",
          upstream: expect.stringContaining(":8080"),
        })
      )
      expect(agentInstance.containerCreate).toHaveBeenCalledTimes(1)
      expect(agentInstance.containerStop).toHaveBeenCalledWith(
        expect.objectContaining({ containerId: "old-preview-container" })
      )
      expect(queryMocks.updatePreviewDeploymentStatus).not.toHaveBeenCalled()
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  it("passes the previous successful build history into legacy ambiguous detection", async () => {
    queryMocks.getLastSucceededBuild.mockImplementationOnce(async () => ({
      id: "previous-build",
    }) as never)

    const checkoutSpawn = mock(() => ({
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
    }))
    const revParseSpawn = mock(() => ({
      stdout: new Blob(["abcdef1234567890abcdef1234567890abcdef12"]).stream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
    }))
    const originalSpawn = Bun.spawn
    Bun.spawn = ((args: string[]) => {
      if (args.includes("rev-parse")) return revParseSpawn()
      return checkoutSpawn()
    }) as typeof Bun.spawn

    try {
      const { handlePreviewDeploy } = await import("./preview-deploy")
      await handlePreviewDeploy(
        makeDb({ build_method: "auto", framework_preset: null }) as never,
        {
          appId: "app-1",
          prNumber: 42,
          headSha: "abcdef1234567890abcdef1234567890abcdef12",
        }
      )

      expect(queryMocks.getLastSucceededBuild).toHaveBeenCalledWith(
        expect.anything(),
        "app-1"
      )
      expect(detectMocks.detectBuildMethod).toHaveBeenCalledWith(
        expect.objectContaining({
          frameworkPreset: null,
          allowLegacyAmbiguous: true,
        })
      )
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  it("rolls back the caddy route and removes the new container if DB persistence fails after switch", async () => {
    queryMocks.updatePreviewDeployment.mockImplementationOnce(async () => {})
    queryMocks.updatePreviewDeployment.mockImplementationOnce(async () => {
      throw new Error("db write failed")
    })

    const originalSpawn = Bun.spawn
    Bun.spawn = ((args: string[]) => ({
      stdout: args.includes("rev-parse")
        ? new Blob(["abcdef1234567890abcdef1234567890abcdef12"]).stream()
        : new ReadableStream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
    })) as typeof Bun.spawn

    try {
      const { handlePreviewDeploy } = await import("./preview-deploy")
      await expect(
        handlePreviewDeploy(makeDb() as never, {
          appId: "app-1",
          prNumber: 42,
          headSha: "abcdef1234567890abcdef1234567890abcdef12",
        })
      ).rejects.toThrow("db write failed")

      expect(caddyInstance.upsertRoute).toHaveBeenCalledTimes(2)
      const routeCalls = caddyInstance.upsertRoute.mock
        .calls as unknown as Array<[Record<string, unknown>]>
      expect(routeCalls[1]?.[0]).toMatchObject({
        upstream: "old-preview-container:8080",
      })
      expect(agentInstance.containerRemove).toHaveBeenCalledWith(
        expect.objectContaining({
          containerId: expect.stringContaining("abcdef123456"),
          force: true,
        })
      )
      expect(queryMocks.updatePreviewDeploymentStatus).toHaveBeenCalledWith(
        expect.anything(),
        "app-1:pr-42",
        "failed"
      )
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  it("rejects an invalid stored framework preset as fatal before building", async () => {
    const originalSpawn = Bun.spawn
    Bun.spawn = ((args: string[]) => ({
      stdout: args.includes("rev-parse")
        ? new Blob(["abcdef1234567890abcdef1234567890abcdef12"]).stream()
        : new ReadableStream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
    })) as typeof Bun.spawn

    try {
      const { handlePreviewDeploy } = await import("./preview-deploy")
      await expect(
        handlePreviewDeploy(
          makeDb({ framework_preset: "not-a-preset" }) as never,
          {
            appId: "app-1",
            prNumber: 42,
            headSha: "abcdef1234567890abcdef1234567890abcdef12",
          }
        )
      ).rejects.toBeInstanceOf(FatalDeployError)
      expect(buildkitMocks.buildImage).not.toHaveBeenCalled()
      expect(agentInstance.containerCreate).not.toHaveBeenCalled()
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  it("rejects ambiguous framework evidence as fatal before a preview build", async () => {
    const workspacePath = "/tmp/ploydok-preview-ambiguous"
    await rm(workspacePath, { recursive: true, force: true })
    await mkdir(workspacePath, { recursive: true })
    await writeFile(workspacePath + "/package.json", '{"scripts":{"start":"node server.js"}}')
    await writeFile(workspacePath + "/next.config.mjs", "export default {}\n")
    await writeFile(workspacePath + "/nuxt.config.ts", "export default {}\n")
    gitMocks.cloneRepo.mockImplementationOnce(async () => ({
      workspacePath,
      headSha: "oldsha000000000000000000000000000000000000",
    }))
    detectMocks.detectBuildMethod.mockImplementationOnce(async () => {
      throw new FatalDeployError(
        "Several framework candidates were detected; select a framework preset before deploying"
      )
    })
    const originalSpawn = Bun.spawn
    Bun.spawn = ((args: string[]) => ({
      stdout: args.includes("rev-parse")
        ? new Blob(["abcdef1234567890abcdef1234567890abcdef12"]).stream()
        : new ReadableStream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
    })) as typeof Bun.spawn

    try {
      const { handlePreviewDeploy } = await import("./preview-deploy")
      await expect(
        handlePreviewDeploy(
          makeDb({ build_method: "nixpacks", framework_preset: null }) as never,
          {
            appId: "app-1",
            prNumber: 42,
            headSha: "abcdef1234567890abcdef1234567890abcdef12",
          }
        )
      ).rejects.toBeInstanceOf(FatalDeployError)
      expect(buildkitMocks.buildImage).not.toHaveBeenCalled()
      expect(agentInstance.containerCreate).not.toHaveBeenCalled()
    } finally {
      Bun.spawn = originalSpawn
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})
