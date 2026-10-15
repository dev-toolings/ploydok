// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"

import {
  AppConfigSchema,
  AppVolumeMountPathSchema,
  AppVolumeNameSchema,
  AppVolumeSchema,
  AppStatusSchema,
  BuildMethodSchema,
  BuildSchema,
  BuildStatusSchema,
  HealthcheckConfigSchema,
  JobSchema,
  JobStatusSchema,
  JobTypeSchema,
  RestartPolicySchema,
} from "./apps"

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

describe("AppStatusSchema", () => {
  it("accepts all valid values", () => {
    for (const v of [
      "created",
      "pending",
      "building",
      "running",
      "serving",
      "restarting",
      "failed",
      "stopped",
      "deleting",
    ] as const) {
      expect(AppStatusSchema.parse(v)).toBe(v)
    }
  })

  it("rejects an unknown value", () => {
    expect(() => AppStatusSchema.parse("unknown")).toThrow()
  })
})

describe("BuildStatusSchema", () => {
  it("accepts all valid values", () => {
    for (const v of [
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const) {
      expect(BuildStatusSchema.parse(v)).toBe(v)
    }
  })
})

describe("BuildMethodSchema", () => {
  it("accepts all valid values", () => {
    for (const v of ["docker", "nixpacks", "auto", "static"] as const) {
      expect(BuildMethodSchema.parse(v)).toBe(v)
    }
  })
})

describe("RestartPolicySchema", () => {
  it("accepts all valid values", () => {
    for (const v of ["no", "always", "unless-stopped", "on-failure"] as const) {
      expect(RestartPolicySchema.parse(v)).toBe(v)
    }
  })
})

describe("JobStatusSchema", () => {
  it("accepts all valid values", () => {
    for (const v of ["pending", "running", "done", "failed"] as const) {
      expect(JobStatusSchema.parse(v)).toBe(v)
    }
  })
})

describe("JobTypeSchema", () => {
  it("accepts all valid values", () => {
    for (const v of [
      "deploy.requested",
      "gc.registry",
      "cleanup.build",
    ] as const) {
      expect(JobTypeSchema.parse(v)).toBe(v)
    }
  })
})

// ---------------------------------------------------------------------------
// HealthcheckConfig defaults
// ---------------------------------------------------------------------------

describe("HealthcheckConfigSchema", () => {
  it("applies defaults when no fields provided", () => {
    const result = HealthcheckConfigSchema.parse({})
    expect(result.path).toBe("/")
    expect(result.intervalS).toBe(5)
    expect(result.timeoutS).toBe(3)
    expect(result.retries).toBe(6)
    expect(result.startPeriodS).toBe(0)
    expect(result.port).toBeUndefined()
  })

  it("round-trips a full config", () => {
    const input = {
      path: "/health",
      port: 8080,
      intervalS: 10,
      timeoutS: 5,
      retries: 3,
      startPeriodS: 30,
    }
    const result = HealthcheckConfigSchema.parse(input)
    expect(result).toEqual(input)
  })

  it("accepts the complete TCP port range and rejects values outside it", () => {
    for (const port of [1, 65_535]) {
      expect(HealthcheckConfigSchema.parse({ port }).port).toBe(port)
    }
    for (const port of [0, 65_536, 8080.5]) {
      expect(() => HealthcheckConfigSchema.parse({ port })).toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

describe("AppConfigSchema", () => {
  const base = {
    name: "my-app",
    slug: "my-app",
    projectId: "proj-abc",
    gitProvider: "github" as const,
    repoFullName: "owner/my-app",
    branch: "main",
  }

  it("parses a minimal valid config", () => {
    const result = AppConfigSchema.parse(base)
    expect(result.name).toBe("my-app")
    expect(result.gitProvider).toBe("github")
    expect(result.rootDir).toBeUndefined()
  })

  it("parses a GitLab config with a nested namespace", () => {
    const result = AppConfigSchema.parse({
      ...base,
      gitProvider: "gitlab",
      repoFullName: "platform/services/my-app",
    })
    expect(result.gitProvider).toBe("gitlab")
    expect(result.repoFullName).toBe("platform/services/my-app")
  })

  it("parses a full config with all optional fields", () => {
    const full = {
      ...base,
      installationId: "42",
      rootDir: "./backend",
      dockerfilePath: "Dockerfile.prod",
      installCommand: "bun install",
      buildCommand: "bun run build",
      startCommand: "bun start",
      watchPaths: ["src/**", "package.json"],
      buildMethod: "docker" as const,
      restartPolicy: "on-failure" as const,
      healthcheck: {
        path: "/healthz",
        intervalS: 10,
        timeoutS: 5,
        retries: 3,
        startPeriodS: 5,
      },
      domain: "my-app.example.com",
    }
    const result = AppConfigSchema.parse(full)
    expect(result.buildMethod).toBe("docker")
    expect(result.installationId).toBe("42")
    expect(result.restartPolicy).toBe("on-failure")
    expect(result.watchPaths).toEqual(["src/**", "package.json"])
    expect(result.healthcheck?.path).toBe("/healthz")
    expect(result.domain).toBe("my-app.example.com")
  })

  it("rejects missing required fields", () => {
    expect(() => AppConfigSchema.parse({ name: "x" })).toThrow()
  })

  it("normalizes blank commands to inherit and rejects unsafe or oversized commands", () => {
    const blank = AppConfigSchema.parse({ ...base, installCommand: "" })
    expect(blank.installCommand).toBeNull()

    for (const value of ["bun\r\nrun build", "bun\u0000run build"]) {
      expect(() => AppConfigSchema.parse({ ...base, buildCommand: value })).toThrow()
    }
    expect(() =>
      AppConfigSchema.parse({ ...base, startCommand: "x".repeat(2_001) })
    ).toThrow()
  })

  it("uses the same bounds for the app runtime port", () => {
    expect(AppConfigSchema.parse({ ...base, runtimePort: 65_535 }).runtimePort).toBe(
      65_535
    )
    for (const runtimePort of [0, 65_536, 3000.5]) {
      expect(() => AppConfigSchema.parse({ ...base, runtimePort })).toThrow()
    }
  })
})

describe("AppVolumeNameSchema", () => {
  it("accepts a valid app volume name", () => {
    expect(AppVolumeNameSchema.parse("data-cache")).toBe("data-cache")
  })

  it("rejects uppercase characters", () => {
    expect(() => AppVolumeNameSchema.parse("Data")).toThrow()
  })
})

describe("AppVolumeMountPathSchema", () => {
  it("accepts an absolute mount path", () => {
    expect(AppVolumeMountPathSchema.parse("/var/lib/data")).toBe(
      "/var/lib/data"
    )
  })

  it("rejects path traversal segments", () => {
    expect(() => AppVolumeMountPathSchema.parse("/var/../data")).toThrow()
  })
})

describe("AppVolumeSchema", () => {
  it("applies null default for sizeLimitBytes", () => {
    const result = AppVolumeSchema.parse({
      id: "vol-1",
      name: "data",
      mountPath: "/data",
      hostPath: "/var/lib/ploydok/app-volumes/app-1/vol-1",
      createdAt: new Date().toISOString(),
    })

    expect(result.sizeLimitBytes).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

describe("BuildSchema", () => {
  it("parses a minimal build", () => {
    const now = Date.now()
    const raw = {
      id: "build-001",
      appId: "app-001",
      status: "pending",
      buildMethod: "auto",
      createdAt: now,
    }
    const result = BuildSchema.parse(raw)
    expect(result.id).toBe("build-001")
    expect(result.imageTag).toBeUndefined()
    expect(result.startedAt).toBeUndefined()
  })

  it("parses a full build", () => {
    const now = Date.now()
    const raw = {
      id: "build-002",
      appId: "app-001",
      status: "succeeded",
      buildMethod: "docker",
      imageTag: "127.0.0.1:5000/my-app:abc123",
      containerId: "ctr-xyz",
      commitSha: "abc123def456",
      requestedByUserId: "user-1",
      source: "webhook:github",
      startedAt: now - 60_000,
      finishedAt: now,
      createdAt: now - 60_000,
    }
    const result = BuildSchema.parse(raw)
    expect(result.status).toBe("succeeded")
    expect(result.imageTag).toBe("127.0.0.1:5000/my-app:abc123")
    expect(result.requestedByUserId).toBe("user-1")
    expect(result.source).toBe("webhook:github")
  })
})

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

describe("JobSchema", () => {
  it("parses a valid job", () => {
    const now = Date.now()
    const raw = {
      id: "job-001",
      type: "deploy.requested",
      payload: { appId: "app-001", commitSha: "abc123" },
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }
    const result = JobSchema.parse(raw)
    expect(result.type).toBe("deploy.requested")
    expect(result.runAt).toBeUndefined()
  })

  it("parses a job with runAt", () => {
    const now = Date.now()
    const raw = {
      id: "job-002",
      type: "gc.registry",
      payload: {},
      status: "pending",
      runAt: now + 3600_000,
      createdAt: now,
      updatedAt: now,
    }
    const result = JobSchema.parse(raw)
    expect(result.runAt).toBe(now + 3600_000)
  })
})
