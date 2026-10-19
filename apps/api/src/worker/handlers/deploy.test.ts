// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for handleDeploy.
 *
 * All external calls (DB, git, detect, nixpacks) are mocked.
 * We verify orchestration logic, build status transitions, and error paths.
 * Log archiving tests use a real tmpdir to assert file creation + content.
 */
import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  spyOn,
  afterAll,
} from "bun:test"
import fs from "node:fs"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { nanoid } from "nanoid"

// ---------------------------------------------------------------------------
// Module-level mocks — must be set up before dynamic imports
// ---------------------------------------------------------------------------

import * as dbQueries from "@ploydok/db/queries"
import * as gitMod from "../git"
import * as detectMod from "../detect"
import * as repositoryTargetsMod from "../repository-targets"
import * as nixpacksMod from "../nixpacks"
import * as runnerMod from "../runner"
import * as eventBusMod from "../event-bus"
import * as queueClaimMod from "../queue-claim"
import * as queueAuditMod from "../queue-audit"
import { withAppDeployLease } from "../app-deploy-lock"
import { imageRepoForApp } from "../../services/runtime-containers"
import * as gitlabConnectionMod from "../../gitlab/connection"
import { FatalDeployError } from "../errors"

describe("immutable image-update build metadata", () => {
  it("preserves serving as the exact pre-deploy state", async () => {
    const { imageUpdateForBuild } = await import("./deploy")
    expect(
      imageUpdateForBuild({
        id: "watch-build",
        image_update_from_digest: "sha256:old",
        image_update_to_digest: "sha256:new",
        image_update_previous_status: "serving",
      })
    ).toEqual({
      fromDigest: "sha256:old",
      toDigest: "sha256:new",
      previousStatus: "serving",
    })
  })

  it("does not attach an app reservation to a competing build", async () => {
    const { imageUpdateForBuild } = await import("./deploy")
    expect(
      imageUpdateForBuild({
        id: "manual-build",
        image_update_from_digest: null,
        image_update_to_digest: null,
        image_update_previous_status: null,
      })
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake job object matching the shape expected by handleDeploy. */
function makeJob(
  payload: object,
  overrides: Partial<{ attempts: number; max_attempts: number }> = {}
) {
  return {
    id: "job-test-1",
    payload: JSON.stringify(payload),
    attempts: overrides.attempts ?? 1,
    max_attempts: overrides.max_attempts ?? 3,
  }
}

/** Minimal app row as returned by getAppForDeploy (internal to deploy.ts). */
const MOCK_APP = {
  id: "app-1",
  project_id: "proj-1",
  name: "test-app",
  slug: "test-app",
  status: "created",
  git_provider: "github",
  repo_full_name: "owner/repo",
  branch: "main",
  github_installation_id: null,
  root_dir: null,
  dockerfile_path: null,
  install_command: null,
  build_command: null,
  start_command: null,
  build_method: "auto",
  owner_id: "user-1",
}

/** Fake build row returned by insertBuild / updateBuildStatus. */
function fakeBuild(id: string, status: string) {
  return {
    id,
    app_id: MOCK_APP.id,
    status,
    build_method: null,
    image_tag: null,
    container_id: null,
    commit_sha: null,
    log_path: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    created_at: new Date(),
  }
}

/** A fake Db object — only the shape matters; all queries are mocked. */
const fakeDb = {} as import("@ploydok/db").Db

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pinImageReference", () => {
  it("replaces tags without mistaking a registry port for a tag", async () => {
    const { pinImageReference } = await import("./deploy")
    expect(
      pinImageReference(
        "registry.example.com:5000/org/app:latest",
        "sha256:abc"
      )
    ).toBe("registry.example.com:5000/org/app@sha256:abc")
    expect(pinImageReference("nginx", "sha256:def")).toBe("nginx@sha256:def")
  })
})

describe("deploymentOutcomeForError", () => {
  it("separates permanent application input failures from platform failures", async () => {
    const { deploymentOutcomeForError } = await import("./deploy")
    expect(
      deploymentOutcomeForError(new FatalDeployError("invalid Dockerfile"))
    ).toBe("application_failed")
    expect(deploymentOutcomeForError(new Error("agent unavailable"))).toBe(
      "platform_failed"
    )
  })
})

describe("interrupted deployment app reconciliation", () => {
  it("restores the exact pre-deploy runtime state", async () => {
    let restored: Record<string, unknown> | undefined
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          restored = values
          return { where: async () => [] }
        },
      }),
    }
    const { restoreInterruptedAppState } = await import("./deploy")
    await restoreInterruptedAppState(
      db as never,
      {
        ...MOCK_APP,
        status: "running",
        container_id: "ploydok-app-test-blue",
        runtime_mode: "docker",
        swarm_service_name: null,
      } as never
    )

    expect(restored).toMatchObject({
      status: "running",
      container_id: "ploydok-app-test-blue",
      runtime_mode: "docker",
      swarm_service_name: null,
    })
  })
})

describe("resolveCloneSourceForApp", () => {
  it("uses the exact GitLab credential and project bound to the app", async () => {
    const selectionSpy = spyOn(
      gitlabConnectionMod,
      "assertGitLabProjectSelection"
    ).mockResolvedValue({
      installationId: "gitlab:user:user-42",
      credentialUserId: "user-42",
      instanceUrl: "https://gitlab.example.com",
      accessToken: "gitlab-token",
      provider: {
        cloneUrlWithToken: (
          _fullName: string,
          token: string,
          canonicalCloneUrl?: string
        ) => canonicalCloneUrl!.replace("https://", `https://oauth2:${token}@`),
      },
      project: {
        cloneUrl: "https://gitlab.example.com/group/subgroup/project.git",
      },
    } as never)
    const { resolveCloneSourceForApp } = await import("./deploy")

    const source = await resolveCloneSourceForApp(fakeDb, {
      ...MOCK_APP,
      git_provider: "gitlab",
      repo_full_name: "group/subgroup/project",
      branch: "release",
      github_installation_id: null,
      gitlab_project_id: 4242,
      git_provider_installation_id: "gitlab:user:user-42",
      gitlab_credential_user_id: "user-42",
    } as never)

    expect(selectionSpy).toHaveBeenCalledWith(fakeDb, {
      credentialUserId: "user-42",
      projectId: 4242,
      fullName: "group/subgroup/project",
      branch: "release",
    })
    expect(source).toEqual({
      installationId: "gitlab:user:user-42",
      cloneUrl:
        "https://oauth2:gitlab-token@gitlab.example.com/group/subgroup/project.git",
    })
  })

  it("refuses GitLab legacy rows instead of falling back to GitHub", async () => {
    const { resolveCloneSourceForApp } = await import("./deploy")
    await expect(
      resolveCloneSourceForApp(fakeDb, {
        ...MOCK_APP,
        git_provider: "gitlab",
        github_installation_id: "same-name-github-installation",
        gitlab_project_id: 4242,
        git_provider_installation_id: null,
        gitlab_credential_user_id: null,
      } as never)
    ).rejects.toThrow(/no exact GitLab credential\/project binding/i)
  })
})

describe("handleDeploy", () => {
  beforeEach(() => {
    // Reset all spies before each test.
    mock.restore()
  })

  it("validates payload schema — throws on invalid JSON", async () => {
    const { handleDeploy } = await import("./deploy")
    const job = {
      id: "job-invalid",
      payload: "{invalid json}",
      attempts: 1,
      max_attempts: 3,
    }

    await expect(handleDeploy(fakeDb, job)).rejects.toThrow()
  })

  it("drops legacy payload containing only appId, with unauthorized audit", async () => {
    const { handleDeploy } = await import("./deploy")

    const claimSpy = spyOn(queueClaimMod, "claimQueuedRow")
    const auditSpy = spyOn(queueAuditMod, "auditUnauthorized")

    await handleDeploy(fakeDb, makeJob({ appId: "legacy-app" }))

    expect(claimSpy).not.toHaveBeenCalled()
    expect(auditSpy).toHaveBeenCalledTimes(1)
    expect(auditSpy.mock.calls[0]?.[0]).toMatchObject({
      reason: "legacy payload format — drop after queue drain",
    })
  })

  it("claims by buildId when provided (legacy appId is ignored)", async () => {
    const { handleDeploy } = await import("./deploy")

    const claimSpy = spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(
      null
    )
    const auditSpy = spyOn(queueAuditMod, "auditUnauthorized")

    await handleDeploy(
      fakeDb,
      makeJob({ buildId: "build-123", appId: "legacy-app" })
    )

    expect(claimSpy).toHaveBeenCalledTimes(1)
    expect(claimSpy.mock.calls[0]?.[0]).toMatchObject({ id: "build-123" })
    expect(auditSpy).toHaveBeenCalledTimes(1)
    expect(auditSpy.mock.calls[0]?.[0]).toMatchObject({
      reason: "build row not found or not pending",
    })
  })
})

describe("isSymfonyFlexWorkspace", () => {
  it("detects Symfony Flex via composer auto-scripts", async () => {
    const { isSymfonyFlexWorkspace } = await import("./symfony-detect")
    const dir = await mkdtemp(path.join(os.tmpdir(), "ploydok-symfony-flex-"))
    try {
      await writeFile(
        path.join(dir, "composer.json"),
        JSON.stringify({
          scripts: {
            "auto-scripts": {
              "cache:clear": "symfony-cmd",
            },
          },
        })
      )
      await expect(isSymfonyFlexWorkspace(dir)).resolves.toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("does not mark generic PHP repos as Symfony", async () => {
    const { isSymfonyFlexWorkspace } = await import("./symfony-detect")
    const dir = await mkdtemp(path.join(os.tmpdir(), "ploydok-generic-php-"))
    try {
      await writeFile(
        path.join(dir, "composer.json"),
        JSON.stringify({
          require: {
            php: "^8.3",
          },
        })
      )
      await expect(isSymfonyFlexWorkspace(dir)).resolves.toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Integration-style tests with a real Postgres DB (via makeTestDb)
// ---------------------------------------------------------------------------

import { apps, builds, projects, users } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { eq } from "drizzle-orm"
import { makeTestDb, TEST_PG_URL } from "../../test/db-helpers"

const NOW = new Date()

function uniqueTestId(prefix: string): string {
  return `${prefix}-${nanoid(8).toLowerCase()}`
}

const skipIntegration = !TEST_PG_URL
if (skipIntegration)
  console.log(
    "[deploy.test] PLOYDOK_TEST_PG_URL not set — skipping DB integration tests"
  )

describe.skipIf(skipIntegration)(
  "handleDeploy — integration stubs (real Postgres DB)",
  () => {
    it("drops a raw buildId without a queued build row", async () => {
      const { db } = await makeTestDb()

      const { handleDeploy } = await import("./deploy")
      const job = makeJob({ buildId: uniqueTestId("missing-build") })

      await expect(handleDeploy(db, job)).resolves.toBeUndefined()
    })
  }
)

// ---------------------------------------------------------------------------
// Log archiving tests — assert createWriteStream + write behaviour
// ---------------------------------------------------------------------------

import * as registryMod from "../registry"
import * as installTokensMod from "../../github/installation-tokens"
import { env } from "../../env"
import { listBuildsByApp } from "@ploydok/db/queries"

// App IDs used in log archiving tests — cleaned up after all tests.
const LOG_TEST_APP_IDS: string[] = []

afterAll(() => {
  for (const appId of LOG_TEST_APP_IDS) {
    const dir = path.join(env.PLOYDOK_BUILD_DIR, appId)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(skipIntegration)("handleDeploy — log archiving", () => {
  beforeEach(() => {
    mock.restore()
    // Clean up any log files from previous runs of these test app IDs.
    for (const appId of LOG_TEST_APP_IDS) {
      const dir = path.join(env.PLOYDOK_BUILD_DIR, appId)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("creates a log file at the expected path and writes log lines to it", async () => {
    // Set up a real Postgres DB with fixtures.
    const { db } = await makeTestDb()
    const userId = uniqueTestId("user-log")
    const projectId = uniqueTestId("proj-log")
    const appId = uniqueTestId("app-log")
    const buildId = uniqueTestId("build-log")
    LOG_TEST_APP_IDS.push(appId)

    // Insert fixtures: user → project → app
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.com`,
      display_name: "Log Tester",
      created_at: NOW,
      updated_at: NOW,
    })
    await db.insert(projects).values({
      id: projectId,
      owner_id: userId,
      name: projectId,
      slug: projectId,
      created_at: NOW,
    })
    await db.insert(apps).values({
      id: appId,
      project_id: projectId,
      name: "log-app",
      slug: appId,
      git_provider: "github",
      github_installation_id: "42",
      repo_full_name: "owner/repo",
      branch: "main",
      runtime_mode: "docker",
    })
    await db.insert(builds).values({
      id: buildId,
      app_id: appId,
      requested_by_user_id: null,
      source: "api",
    })

    // Mock external dependencies so the build runs to completion.
    spyOn(installTokensMod, "listAppInstallations").mockResolvedValue([
      { id: 42, accountLogin: "owner" },
    ] as any)
    spyOn(installTokensMod, "getInstallationToken").mockResolvedValue(
      "fake-token"
    )
    spyOn(repositoryTargetsMod, "resolveRepositoryRoot").mockResolvedValue(null)
    spyOn(gitMod, "cloneRepo").mockResolvedValue({
      workspacePath: path.join(env.PLOYDOK_BUILD_DIR, "ws-test"),
      headSha: null,
    })
    spyOn(detectMod, "detectBuildMethod").mockResolvedValue({
      method: "nixpacks",
    })
    spyOn(registryMod, "diskGuard").mockResolvedValue(undefined)
    spyOn(nixpacksMod, "nixpacksBuild").mockImplementation(
      async ({ onLog }) => {
        onLog?.("Step 1/3 : FROM node:22")
        onLog?.("Step 2/3 : COPY . .")
        onLog?.("Step 3/3 : RUN bun install")
        return {
          contextDir: path.join(env.PLOYDOK_BUILD_DIR, "generated-nixpacks"),
          dockerfile: path.join(
            env.PLOYDOK_BUILD_DIR,
            "generated-nixpacks/.nixpacks/Dockerfile"
          ),
        }
      }
    )
    spyOn(registryMod, "gcKeepLast").mockResolvedValue([])
    spyOn(Bun, "spawn").mockImplementation(
      () =>
        ({
          stdout: new Response("").body,
          stderr: new Response("").body,
          exited: Promise.resolve(0),
        }) as unknown as ReturnType<typeof Bun.spawn>
    )
    // Mock runBlueGreen so the log archiving test doesn't need a running agent.
    spyOn(runnerMod, "runBlueGreen").mockResolvedValue({
      containerId: "cont-log-1",
      color: "blue",
    })

    const { handleDeploy } = await import("./deploy")
    const job = makeJob({
      buildId,
      commitMessage: "chore: log archiving test",
    })

    await withAppDeployLease(db, appId, buildId, () => handleDeploy(db, job), { purpose: "deploy" })

    // Assert the log file was created at the expected path.
    const expectedLogDir = path.join(env.PLOYDOK_BUILD_DIR, appId)
    const logFiles = (fs.readdirSync(expectedLogDir) as string[]).filter((f) =>
      f.endsWith(".log")
    )
    expect(logFiles.length).toBe(1)

    const logFilePath = path.join(expectedLogDir, logFiles[0] as string)

    // Assert log lines were written to the file.
    const content = fs.readFileSync(logFilePath, "utf-8")
    expect(content).toContain("Step 1/3 : FROM node:22\n")
    expect(content).toContain("Step 2/3 : COPY . .\n")
    expect(content).toContain("Step 3/3 : RUN bun install\n")

    // Assert the build DB record has log_path set to the log file path.
    const buildRows = await listBuildsByApp(db, appId)
    const build = buildRows.find((row) => row.id === buildId)
    expect(build?.log_path).toBe(logFilePath)
    expect(build?.status).toBe("succeeded")
    // build_method must be non-null (fix for build_method null bug).
    expect(build?.build_method).not.toBeNull()
    // commitMessage must be persisted from job payload.
    expect(build?.commit_message).toBe("chore: log archiving test")
  })

  it("still creates the log file even when the build fails", async () => {
    const { db } = await makeTestDb()
    const userId = uniqueTestId("user-log-fail")
    const projectId = uniqueTestId("proj-log-fail")
    const appId = uniqueTestId("app-log-fail")
    const buildId = uniqueTestId("build-log-fail")
    LOG_TEST_APP_IDS.push(appId)

    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.com`,
      display_name: "Fail Tester",
      created_at: NOW,
      updated_at: NOW,
    })
    await db.insert(projects).values({
      id: projectId,
      owner_id: userId,
      name: projectId,
      slug: projectId,
      created_at: NOW,
    })
    await db.insert(apps).values({
      id: appId,
      project_id: projectId,
      name: "fail-app",
      slug: appId,
      git_provider: "github",
      github_installation_id: "42",
      repo_full_name: "owner/repo",
      branch: "main",
      runtime_mode: "docker",
    })
    await db.insert(builds).values({
      id: buildId,
      app_id: appId,
      requested_by_user_id: null,
      source: "api",
    })

    spyOn(installTokensMod, "listAppInstallations").mockResolvedValue([
      { id: 42, accountLogin: "owner" },
    ] as any)
    spyOn(installTokensMod, "getInstallationToken").mockResolvedValue(
      "fake-token"
    )
    spyOn(gitMod, "cloneRepo").mockRejectedValue(
      new Error("git clone failed: timeout")
    )

    const { handleDeploy } = await import("./deploy")
    const job = makeJob({ buildId })

    await expect(
      withAppDeployLease(db, appId, buildId, () => handleDeploy(db, job), { purpose: "deploy" })
    ).rejects.toThrow("git clone failed: timeout")

    // Log file must have been created (even on failure).
    const expectedLogDir = path.join(env.PLOYDOK_BUILD_DIR, appId)
    const logFiles = (fs.readdirSync(expectedLogDir) as string[]).filter((f) =>
      f.endsWith(".log")
    )
    expect(logFiles.length).toBe(1)

    // Build record must have log_path + failed status.
    const buildRows = await listBuildsByApp(db, appId)
    const build = buildRows.find((row) => row.id === buildId)
    expect(build?.status).toBe("failed")

    const logFilePath = path.join(expectedLogDir, logFiles[0] as string)
    expect(build?.log_path).toBe(logFilePath)
  })
})

// ---------------------------------------------------------------------------
// Blue-green integration tests — assert step 4 orchestration
// ---------------------------------------------------------------------------

const LOG_TEST_APP_IDS_BG: string[] = []

afterAll(() => {
  for (const appId of LOG_TEST_APP_IDS_BG) {
    const dir = path.join(env.PLOYDOK_BUILD_DIR, appId)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(skipIntegration)("handleDeploy — blue-green", () => {
  let db: Db
  let bgAppId: string
  let bgBuildId: string

  beforeEach(async () => {
    mock.restore()

    // Fresh Postgres DB for each test.
    const result = await makeTestDb()
    db = result.db
    const userId = uniqueTestId("user-bg")
    const projectId = uniqueTestId("proj-bg")
    bgAppId = uniqueTestId("app-bg")
    bgBuildId = uniqueTestId("build-bg")
    LOG_TEST_APP_IDS_BG.push(bgAppId)

    // Seed: user → project → app
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.com`,
      display_name: "BG Tester",
      created_at: NOW,
      updated_at: NOW,
    })
    await db.insert(projects).values({
      id: projectId,
      owner_id: userId,
      name: projectId,
      slug: projectId,
      created_at: NOW,
    })
    await db.insert(apps).values({
      id: bgAppId,
      project_id: projectId,
      name: "bg-app",
      slug: bgAppId,
      git_provider: "github",
      github_installation_id: "42",
      repo_full_name: "owner/repo",
      branch: "main",
      runtime_mode: "docker",
    })
    await db.insert(builds).values({
      id: bgBuildId,
      app_id: bgAppId,
      requested_by_user_id: null,
      source: "api",
    })

    // Stub common dependencies for a full successful build up to push.
    spyOn(installTokensMod, "listAppInstallations").mockResolvedValue([
      { id: 42, accountLogin: "owner" },
    ] as any)
    spyOn(installTokensMod, "getInstallationToken").mockResolvedValue(
      "fake-token"
    )
    spyOn(repositoryTargetsMod, "resolveRepositoryRoot").mockResolvedValue(null)
    spyOn(gitMod, "cloneRepo").mockResolvedValue({
      workspacePath: path.join(env.PLOYDOK_BUILD_DIR, "ws-bg"),
      headSha: null,
    })
    spyOn(detectMod, "detectBuildMethod").mockResolvedValue({
      method: "nixpacks",
    })
    spyOn(registryMod, "diskGuard").mockResolvedValue(undefined)
    spyOn(nixpacksMod, "nixpacksBuild").mockResolvedValue({
      contextDir: path.join(env.PLOYDOK_BUILD_DIR, "generated-nixpacks-bg"),
      dockerfile: path.join(
        env.PLOYDOK_BUILD_DIR,
        "generated-nixpacks-bg/.nixpacks/Dockerfile"
      ),
    })
    spyOn(registryMod, "gcKeepLast").mockResolvedValue([])
    spyOn(Bun, "spawn").mockImplementation(
      () =>
        ({
          stdout: new Response("").body,
          stderr: new Response("").body,
          exited: Promise.resolve(0),
        }) as unknown as ReturnType<typeof Bun.spawn>
    )
  })

  it("calls runBlueGreen after push, updates build containerId, publishes Runtime live event", async () => {
    // Mock runBlueGreen to return a fake container.
    const runBlueGreenSpy = spyOn(runnerMod, "runBlueGreen").mockResolvedValue({
      containerId: "cont-123",
      color: "blue",
    })

    // Capture eventBus.publish calls.
    const publishedEvents: Array<{ channel: string; event: object }> = []
    spyOn(eventBusMod.eventBus, "publish").mockImplementation(
      (channel: string, event: object) => {
        publishedEvents.push({ channel, event })
      }
    )

    const { handleDeploy } = await import("./deploy")
    const job = makeJob({
      buildId: bgBuildId,
      commitMessage: "feat: test deploy",
    })

    await withAppDeployLease(db, bgAppId, bgBuildId, () =>
      handleDeploy(db, job), { purpose: "deploy" }
    )

    // runBlueGreen must have been called.
    expect(runBlueGreenSpy).toHaveBeenCalledTimes(1)
    const bgOpts = runBlueGreenSpy.mock
      .calls[0]![0] as import("../runner").RunBlueGreenOptions
    expect(bgOpts.appId).toBe(bgAppId)
    expect(bgOpts.imageRef).toContain(imageRepoForApp(bgAppId))

    // Build record must have containerId and status succeeded.
    const buildRows = await listBuildsByApp(db, bgAppId)
    const build = buildRows.find((row) => row.id === bgBuildId)
    expect(build?.status).toBe("succeeded")
    expect(build?.container_id).toBe("cont-123")

    // Build record must have a non-null build_method (fix for build_method null bug).
    expect(build?.build_method).not.toBeNull()

    // commitMessage must be persisted from the job payload.
    expect(build?.commit_message).toBe("feat: test deploy")

    // event deploy.status_change with "Runtime live" must have been published.
    const liveEvent = publishedEvents.find(
      (e) =>
        (e.event as { type?: string; message?: string }).type ===
          "deploy.status_change" &&
        (e.event as { message?: string }).message === "Runtime live"
    )
    expect(liveEvent).toBeDefined()
    expect(
      (liveEvent!.event as { data?: { containerId?: string } }).data
        ?.containerId
    ).toBe("cont-123")
  })

  it("marks build failed and does NOT set app status to running when runBlueGreen throws", async () => {
    // Mock runBlueGreen to throw.
    spyOn(runnerMod, "runBlueGreen").mockRejectedValue(
      new Error("healthcheck failed after 6 retries")
    )

    // Capture eventBus.publish calls.
    const publishedEvents: Array<{ channel: string; event: object }> = []
    spyOn(eventBusMod.eventBus, "publish").mockImplementation(
      (channel: string, event: object) => {
        publishedEvents.push({ channel, event })
      }
    )

    const { handleDeploy } = await import("./deploy")
    const job = makeJob({ buildId: bgBuildId })

    await expect(
      withAppDeployLease(db, bgAppId, bgBuildId, () => handleDeploy(db, job), { purpose: "deploy" })
    ).rejects.toThrow("healthcheck failed after 6 retries")

    // Build record must have status failed.
    const buildRows = await listBuildsByApp(db, bgAppId)
    const build = buildRows.find((row) => row.id === bgBuildId)
    expect(build?.status).toBe("failed")
    expect(build?.container_id).toBeNull()

    // App row must NOT have status running (runBlueGreen threw before updating it).
    const appRows = await db
      .select()
      .from(apps)
      .where(eq(apps.id, bgAppId))
      .limit(1)
    const appRow = appRows[0]
    expect(appRow?.status).not.toBe("running")

    // build.failed event must have been published.
    const failedEvent = publishedEvents.find(
      (e) => (e.event as { type?: string }).type === "build.failed"
    )
    expect(failedEvent).toBeDefined()

    // deploy.status_change "Runtime live" must NOT have been published.
    const liveEvent = publishedEvents.find(
      (e) =>
        (e.event as { type?: string; message?: string }).type ===
          "deploy.status_change" &&
        (e.event as { message?: string }).message === "Runtime live"
    )
    expect(liveEvent).toBeUndefined()
  })
})
