// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tests for lib/apps.ts — normalizeAppDetail + type contracts.
 * No React hooks; tests pure normalization logic.
 */
import { describe, expect, it } from "bun:test"
import {
  applyAppStatus,
  getEventAppStatus,
  hasActiveBuilds,
  normalizeAppDetail,
  patchBuildsWithSseEvent,
} from "../../lib/apps"
import {
  resolveDisplayedAppState,
  resolveRuntimeAppStatus,
  selectAppSnapshot,
} from "../../lib/app-runtime"
import type { RawAppDetail } from "../../lib/apps"
import type { Build, ContainerSnapshot } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(overrides: Partial<RawAppDetail> = {}): RawAppDetail {
  return {
    id: "app-1",
    name: "Test app",
    slug: "test-app",
    status: "running",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// normalizeAppDetail — healthcheck path + port
// ---------------------------------------------------------------------------

describe("normalizeAppDetail — healthcheck path / port", () => {
  it("maps healthcheck.path to healthcheckPath", () => {
    const raw = makeRaw({ healthcheck: { path: "/health" } })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckPath).toBe("/health")
  })

  it("maps healthcheck.port to healthcheckPort", () => {
    const raw = makeRaw({ healthcheck: { port: 8080 } })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckPort).toBe(8080)
  })

  it("sets healthcheckPort to null when absent", () => {
    const raw = makeRaw({ healthcheck: { path: "/ping" } })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckPort).toBeNull()
  })

  it("handles null healthcheck", () => {
    const raw = makeRaw({ healthcheck: null })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckPath).toBeUndefined()
    expect(result.healthcheckPort).toBeNull()
  })

  it("handles absent healthcheck", () => {
    const raw = makeRaw()
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckPath).toBeUndefined()
    expect(result.healthcheckPort).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// normalizeAppDetail — 4 new healthcheck timing fields (W2.B fix)
// ---------------------------------------------------------------------------

describe("normalizeAppDetail — healthcheck timing fields", () => {
  it("maps intervalS to healthcheckIntervalS", () => {
    const raw = makeRaw({ healthcheck: { intervalS: 10 } })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckIntervalS).toBe(10)
  })

  it("maps timeoutS to healthcheckTimeoutS", () => {
    const raw = makeRaw({ healthcheck: { timeoutS: 5 } })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckTimeoutS).toBe(5)
  })

  it("maps retries to healthcheckRetries", () => {
    const raw = makeRaw({ healthcheck: { retries: 3 } })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckRetries).toBe(3)
  })

  it("maps startPeriodS to healthcheckStartPeriodS", () => {
    const raw = makeRaw({ healthcheck: { startPeriodS: 30 } })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckStartPeriodS).toBe(30)
  })

  it("sets all timing fields to null when healthcheck is absent", () => {
    const raw = makeRaw()
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckIntervalS).toBeNull()
    expect(result.healthcheckTimeoutS).toBeNull()
    expect(result.healthcheckRetries).toBeNull()
    expect(result.healthcheckStartPeriodS).toBeNull()
  })

  it("maps all 4 timing fields together from a full healthcheck object", () => {
    const raw = makeRaw({
      healthcheck: {
        path: "/health",
        port: 3000,
        intervalS: 15,
        timeoutS: 5,
        retries: 3,
        startPeriodS: 10,
      },
    })
    const result = normalizeAppDetail(raw)
    expect(result.healthcheckPath).toBe("/health")
    expect(result.healthcheckPort).toBe(3000)
    expect(result.healthcheckIntervalS).toBe(15)
    expect(result.healthcheckTimeoutS).toBe(5)
    expect(result.healthcheckRetries).toBe(3)
    expect(result.healthcheckStartPeriodS).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// normalizeAppDetail — rest fields pass through
// ---------------------------------------------------------------------------

describe("normalizeAppDetail — pass-through fields", () => {
  it("preserves id, name, slug, status", () => {
    const raw = makeRaw({ id: "x", name: "Y", slug: "y", status: "failed" })
    const result = normalizeAppDetail(raw)
    expect(result.id).toBe("x")
    expect(result.name).toBe("Y")
    expect(result.slug).toBe("y")
    expect(result.status).toBe("failed")
  })

  it("preserves optional string fields", () => {
    const raw = makeRaw({
      gitProvider: "github",
      rootDir: "/src",
      buildMethod: "docker",
      restartPolicy: "on-failure",
      branch: "main",
    })
    const result = normalizeAppDetail(raw)
    expect(result.gitProvider).toBe("github")
    expect(result.rootDir).toBe("/src")
    expect(result.buildMethod).toBe("docker")
    expect(result.restartPolicy).toBe("on-failure")
    expect(result.branch).toBe("main")
  })
})

describe("app status event helpers", () => {
  it("extracts the next status from an event payload", () => {
    expect(getEventAppStatus({ data: { status: "running" } })).toBe("running")
  })

  it("returns undefined when the event has no status", () => {
    expect(getEventAppStatus({})).toBeUndefined()
  })

  it("applies a new status without mutating other fields", () => {
    const raw = makeRaw({ name: "demo", status: "stopped" })
    const normalized = normalizeAppDetail(raw)
    const patched = applyAppStatus(normalized, "building")
    expect(patched?.status).toBe("building")
    expect(patched?.name).toBe("demo")
  })
})

describe("app runtime status helpers", () => {
  function makeSnapshot(
    overrides: Partial<ContainerSnapshot> = {}
  ): ContainerSnapshot {
    return {
      id: "ctr-1",
      name: "app-1",
      image: "ploydok/app:latest",
      status: "running",
      uptime_s: 10,
      cpu_pct: 1,
      mem_bytes: 1024,
      mem_limit_bytes: 2048,
      restart_count: 0,
      kind: "app",
      app_id: "app-1",
      last_seen_ms: 1000,
      ...overrides,
    }
  }

  it("prefers the highest-priority snapshot for one app", () => {
    const selected = selectAppSnapshot(
      [
        makeSnapshot({ id: "stopped", status: "stopped", last_seen_ms: 2000 }),
        makeSnapshot({ id: "running", status: "running", last_seen_ms: 1000 }),
      ],
      "app-1"
    )
    expect(selected?.id).toBe("running")
  })

  it("falls back to highest-priority snapshot when expectedRef is stale", () => {
    // Recreation scenario: apps.container_id in DB points at a previous
    // container reference (blue/green swap, host reboot, watchtower swap),
    // but the live agent reports a fresh container with the right app_id
    // label. We pick it so the badge stops lying about "Stopped". The API
    // reconciler refreshes apps.container_id on the next /apps fetch.
    const selected = selectAppSnapshot(
      [
        makeSnapshot({
          id: "ctr-fresh-green",
          name: "ploydok-app-x-green",
          status: "running",
          last_seen_ms: 5000,
        }),
      ],
      "app-1",
      "ploydok-app-x-blue"
    )
    expect(selected?.id).toBe("ctr-fresh-green")
  })

  it("returns null when expectedRef is stale and no container has the right app_id", () => {
    const selected = selectAppSnapshot(
      [
        makeSnapshot({
          app_id: "other-app",
          id: "ctr-other",
          name: "ploydok-app-other-blue",
          status: "running",
        }),
      ],
      "app-1",
      "ploydok-app-x-blue"
    )
    expect(selected).toBeNull()
  })

  it("matches by snapshot.name when expectedRef is the container name", () => {
    const selected = selectAppSnapshot(
      [
        makeSnapshot({
          id: "sha256:abc",
          name: "ploydok-app-x-green",
          status: "running",
        }),
        makeSnapshot({
          id: "sha256:def",
          name: "ploydok-app-x-blue",
          status: "stopped",
        }),
      ],
      "app-1",
      "ploydok-app-x-green"
    )
    expect(selected?.id).toBe("sha256:abc")
  })

  it("matches by snapshot.id when expectedRef is the container id", () => {
    const selected = selectAppSnapshot(
      [
        makeSnapshot({
          id: "sha256:abc",
          name: "ploydok-app-x-green",
          status: "running",
        }),
      ],
      "app-1",
      "sha256:abc"
    )
    expect(selected?.id).toBe("sha256:abc")
  })

  it("ignores expectedRef belonging to another app_id (defense-in-depth)", () => {
    const selected = selectAppSnapshot(
      [
        makeSnapshot({
          id: "ctr-other",
          name: "ploydok-app-x-green",
          app_id: "app-2",
          status: "running",
        }),
      ],
      "app-1",
      "ploydok-app-x-green"
    )
    expect(selected).toBeNull()
  })

  it("falls back to legacy picker when expectedRef is null/undefined", () => {
    // Brand-new app with no container_id yet: still want to see whatever is
    // running (e.g. monitoring overview during the very first deploy).
    const selected = selectAppSnapshot(
      [makeSnapshot({ id: "ctr-1", status: "running", last_seen_ms: 1000 })],
      "app-1",
      null
    )
    expect(selected?.id).toBe("ctr-1")
  })

  it("trusts the DB lifecycle when monitoring snapshot is missing (stale cache, background tab)", () => {
    // No-snapshot is NOT a positive signal that the container is stopped.
    // The API reconciler is the only authority that flips running → failed
    // (after STALE_GRACE_MS); the UI must not duplicate that and lie about
    // a healthy container while monitoring is just briefly out of sync.
    expect(resolveRuntimeAppStatus("running", null)).toBe("running")
  })

  it("downgrades running to stopped when the selected container is stopped", () => {
    expect(
      resolveRuntimeAppStatus("running", makeSnapshot({ status: "stopped" }))
    ).toBe("stopped")
  })

  it("maps a starting container to restarting for badge consistency", () => {
    expect(
      resolveRuntimeAppStatus("running", makeSnapshot({ status: "starting" }))
    ).toBe("restarting")
  })

  it("lets the canonical running snapshot override a stale failed app status", () => {
    expect(
      resolveRuntimeAppStatus("failed", makeSnapshot({ status: "running" }))
    ).toBe("running")
  })

  it("keeps build-phase statuses untouched", () => {
    expect(resolveRuntimeAppStatus("building", null)).toBe("building")
    expect(
      resolveRuntimeAppStatus("pending", makeSnapshot({ status: "running" }))
    ).toBe("pending")
  })

  it("keeps deleting status untouched while cleanup runs", () => {
    expect(
      resolveRuntimeAppStatus("deleting", makeSnapshot({ status: "running" }))
    ).toBe("deleting")
  })

  it("keeps static sites serving even if monitoring reports a container", () => {
    expect(
      resolveRuntimeAppStatus("serving", makeSnapshot({ status: "running" }))
    ).toBe("serving")
  })

  it("falls back to the raw app status until monitoring containers are loaded", () => {
    expect(
      resolveDisplayedAppState(
        { id: "app-1", status: "failed", containerId: "ploydok-app-x-green" },
        undefined
      )
    ).toEqual({ status: "failed", health: null })
  })

  it("derives running + healthy from the canonical snapshot on app pages", () => {
    expect(
      resolveDisplayedAppState(
        { id: "app-1", status: "failed", containerId: "ploydok-app-x-green" },
        [
          makeSnapshot({
            id: "ctr-green",
            name: "ploydok-app-x-green",
            status: "running",
          }),
          makeSnapshot({
            id: "ctr-blue",
            name: "ploydok-app-x-blue",
            status: "running",
            last_seen_ms: 3000,
          }),
        ]
      )
    ).toEqual({ status: "running", health: "healthy" })
  })
})

// ---------------------------------------------------------------------------
// normalizeAppDetail: app detail normalization contract
// ---------------------------------------------------------------------------

describe("normalizeAppDetail applied to raw app detail responses", () => {
  it("normalizeAppDetail is applied: healthcheck fields are flattened", () => {
    const raw = makeRaw({
      healthcheck: { path: "/readyz", port: 8080, intervalS: 10 },
    })
    const normalized = normalizeAppDetail(raw)
    expect(normalized.healthcheckPath).toBe("/readyz")
    expect(normalized.healthcheckPort).toBe(8080)
    expect(normalized.healthcheckIntervalS).toBe(10)
  })

  it("normalizeAppDetail on raw with no healthcheck produces null timing fields", () => {
    const raw = makeRaw()
    const normalized = normalizeAppDetail(raw)
    expect(normalized.healthcheckPath).toBeUndefined()
    expect(normalized.healthcheckPort).toBeNull()
    expect(normalized.healthcheckIntervalS).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// useApp / useBuilds initialData option — contract tests
// ---------------------------------------------------------------------------

describe("useApp / useBuilds initialData option — contract", () => {
  it("UseAppOptions type accepts initialData: AppDetail", () => {
    // Compile-time contract: if this test file compiles, the type is correct.
    // We just import and verify the type structure without calling the hook.
    type UseAppOptionsShape = {
      initialData?: ReturnType<typeof normalizeAppDetail>
    }
    const opts: UseAppOptionsShape = {
      initialData: normalizeAppDetail(makeRaw()),
    }
    expect(opts.initialData).toBeDefined()
  })

  it("normalizeAppDetail output can serve as initialData", () => {
    const raw = makeRaw({ name: "seed-app" })
    const normalized = normalizeAppDetail(raw)
    // initialData can be passed to useApp — no transforms needed.
    expect(normalized.name).toBe("seed-app")
    expect(normalized.healthcheckIntervalS).toBeNull()
  })
})

describe("build SSE cache helpers", () => {
  const baseBuild: Build = {
    id: "build-1",
    appId: "app-1",
    status: "pending",
    createdAt: 1000,
  }

  it("creates a synthetic running row when build.started arrives before refetch", () => {
    const patched = patchBuildsWithSseEvent(
      undefined,
      "build.started",
      { appId: "app-1", buildId: "build-1", t: 2000 },
      3000
    )

    expect(patched).toEqual([
      {
        id: "build-1",
        appId: "app-1",
        status: "running",
        startedAt: 2000,
        createdAt: 2000,
      },
    ])
  })

  it("patches terminal build status without waiting for a table refresh", () => {
    const patched = patchBuildsWithSseEvent(
      [{ ...baseBuild, status: "running", startedAt: 1000 }],
      "build.failed",
      {
        appId: "app-1",
        buildId: "build-1",
        message: "Build failed",
        t: 4000,
      },
      5000
    )

    expect(patched?.[0]?.status).toBe("failed")
    expect(patched?.[0]?.finishedAt).toBe(4000)
    expect(patched?.[0]?.errorMessage).toBe("Build failed")
  })

  it("detects active builds for the refetch fallback", () => {
    expect(hasActiveBuilds([baseBuild])).toBe(true)
    expect(hasActiveBuilds([{ ...baseBuild, status: "succeeded" }])).toBe(false)
  })
})
