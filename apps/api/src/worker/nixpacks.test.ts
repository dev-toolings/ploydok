// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for nixpacksBuild().
 *
 * The `nixpacks` binary is not available in the test environment.
 * We mock `ensureNixpacksInstalled` to return a fake path and spy on
 * `Bun.spawn` to verify command construction, log streaming, cache flag
 * injection, and error handling without running an actual build.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import * as nixpacksMod from "./nixpacks"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Bun.spawn process that yields the given lines and exits. */
function fakeBunProcess(opts: {
  stdoutLines?: string[]
  stderrLines?: string[]
  exitCode?: number
}) {
  const stdoutText =
    (opts.stdoutLines ?? []).join("\n") + (opts.stdoutLines?.length ? "\n" : "")
  const stderrText =
    (opts.stderrLines ?? []).join("\n") + (opts.stderrLines?.length ? "\n" : "")
  const enc = new TextEncoder()

  function makeStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        if (text) controller.enqueue(enc.encode(text))
        controller.close()
      },
    })
  }

  return {
    stdout: makeStream(stdoutText),
    stderr: makeStream(stderrText),
    exited: Promise.resolve(opts.exitCode ?? 0),
    exitCode: opts.exitCode ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nixpacksBuild", () => {
  let tmpDir: string
  let spawnSpy: ReturnType<typeof spyOn>
  let ensureSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ploydok-nixpacks-test-"))
    // Stub binary resolution so tests don't hit the network or filesystem.
    ensureSpy = spyOn(nixpacksMod, "ensureNixpacksInstalled").mockResolvedValue(
      "/usr/local/bin/nixpacks"
    )
  })

  afterEach(async () => {
    spawnSpy?.mockRestore?.()
    ensureSpy?.mockRestore?.()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("calls nixpacks with --cache-key when cacheKey is provided", async () => {
    const controller = new AbortController()
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stdoutLines: ["[nixpacks] Building..."],
      }) as ReturnType<typeof Bun.spawn>
    )

    const generated = await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      cacheKey: "app-abc",
      cacheDir: path.join(tmpDir, ".nixpacks-cache"),
      signal: controller.signal,
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(
      spawnMock.mock.calls.some(
        (call) =>
          (call[1] as { signal?: AbortSignal } | undefined)?.signal ===
          controller.signal
      )
    ).toBe(true)
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd).toContain("build")
    expect(cmd).toContain("--out")
    expect(generated.dockerfile).toBe(
      path.join(generated.contextDir, ".nixpacks", "Dockerfile")
    )
    expect(cmd).toContain("--cache-key")
    const cacheKeyIdx = cmd.indexOf("--cache-key")
    expect(cmd[cacheKeyIdx + 1]).toBe("app-abc")
  })

  it("creates cacheDir before spawning", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    const cacheDir = path.join(tmpDir, "nested", ".nixpacks-cache")

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      cacheKey: "app-abc",
      cacheDir,
    })

    expect(existsSync(cacheDir)).toBe(true)
  })

  it("creates the generated context on the writable build mount", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    const appBuildDir = path.join(tmpDir, "builds", "app-123")
    const cacheDir = path.join(appBuildDir, ".nixpacks-cache")
    const generated = await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-123:sha123",
      cacheDir,
    })

    expect(path.dirname(generated.contextDir)).toBe(appBuildDir)
    expect(path.basename(generated.contextDir)).toStartWith(
      ".ploydok-nixpacks-context-"
    )
  })

  it("copies the sources of ctx into the generated context", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
      const out = cmd[cmd.indexOf("--out") + 1]!
      mkdirSync(path.join(out, ".nixpacks"), { recursive: true })
      writeFileSync(path.join(out, ".nixpacks", "Dockerfile"), "FROM scratch")
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    await mkdir(path.join(tmpDir, "apps", "web"), { recursive: true })
    await mkdir(path.join(tmpDir, ".git"), { recursive: true })
    await writeFile(path.join(tmpDir, "apps", "web", "package.json"), "{}")
    await writeFile(path.join(tmpDir, ".git", "HEAD"), "x")
    const generated = await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      rootDir: "apps/web",
      tag: "127.0.0.1:5000/app-123:sha123",
      cacheDir: path.join(tmpDir, "builds", "app-123", ".nixpacks-cache"),
    })

    expect(existsSync(path.join(generated.contextDir, "package.json"))).toBe(
      true
    )
    expect(existsSync(generated.dockerfile)).toBe(true)
    expect(existsSync(path.join(tmpDir, ".nixpacks"))).toBe(false)
  })

  it("falls back to basename of cacheDir as cache key when cacheKey is omitted", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    const cacheDir = path.join(tmpDir, "my-app-id")

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      cacheDir,
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    const cacheKeyIdx = cmd.indexOf("--cache-key")
    // Fallback: use path.basename(cacheDir) as the stable key.
    expect(cmd[cacheKeyIdx + 1]).toBe("my-app-id")
  })

  it("does NOT pass --cache-key when neither cacheDir nor cacheKey is given", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd).not.toContain("--cache-key")
  })

  it("streams stdout and stderr via onLog", async () => {
    const lines = ["Step 1: install", "Step 2: build", "Step 3: done"]
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({ stdoutLines: lines }) as ReturnType<typeof Bun.spawn>
    )

    const captured: string[] = []

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      onLog: (line) => captured.push(line),
    })

    for (const line of lines) {
      expect(captured).toContain(line)
    }
  })

  it("throws when nixpacks exits with non-zero code", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stderrLines: ["Error: failed to build — unknown plan"],
        exitCode: 1,
      }) as ReturnType<typeof Bun.spawn>
    )

    await expect(
      nixpacksMod.nixpacksBuild({
        workspacePath: tmpDir,
        tag: "127.0.0.1:5000/app-fail:sha",
        cacheKey: "app-fail",
        cacheDir: path.join(tmpDir, ".nixpacks-cache"),
      })
    ).rejects.toThrow(/nixpacks build failed \(exit 1\)/)
  })

  it("injects --incremental-cache-image when dockerCacheRef + cacheDir are provided", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    const cacheDir = path.join(tmpDir, ".nixpacks-cache")
    const dockerCacheRef = "127.0.0.1:5000/app-abc:cache"

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      cacheKey: "app-abc",
      cacheDir,
      dockerCacheRef,
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]

    const flag = cmd.find((a) => a.startsWith("--incremental-cache-image="))
    expect(flag).toBe(`--incremental-cache-image=${dockerCacheRef}`)
  })

  it("does NOT inject --incremental-cache-image when dockerCacheRef is absent", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      cacheKey: "app-abc",
      cacheDir: path.join(tmpDir, ".nixpacks-cache"),
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd.some((a) => a.startsWith("--incremental-cache-image="))).toBe(
      false
    )
  })

  it("does NOT inject --incremental-cache-image when cacheDir is absent", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      cacheKey: "app-abc",
      dockerCacheRef: "127.0.0.1:5000/app-abc:cache",
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd.some((a) => a.startsWith("--incremental-cache-image="))).toBe(
      false
    )
  })

  it("passes optional installCmd, buildCmd, startCmd flags", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      installCmd: "bun install",
      buildCmd: "bun run build",
      startCmd: "bun run start",
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd).toContain("--install-cmd")
    expect(cmd).toContain("bun install")
    expect(cmd).toContain("--build-cmd")
    expect(cmd).toContain("bun run build")
    expect(cmd).toContain("--start-cmd")
    expect(cmd).toContain("bun run start")
  })

  it("maps NIXPACKS_*_CMD build env values to explicit command flags", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      buildEnv: {
        NIXPACKS_INSTALL_CMD:
          "COMPOSER_ALLOW_SUPERUSER=1 composer install --ignore-platform-reqs",
        NIXPACKS_BUILD_CMD: "php bin/console cache:warmup",
        NIXPACKS_START_CMD: "php-fpm",
      },
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd).toContain("--install-cmd")
    expect(cmd).toContain(
      "COMPOSER_ALLOW_SUPERUSER=1 composer install --ignore-platform-reqs"
    )
    expect(cmd).toContain("--build-cmd")
    expect(cmd).toContain("php bin/console cache:warmup")
    expect(cmd).toContain("--start-cmd")
    expect(cmd).toContain("php-fpm")
  })

  it("passes config path, node version env, and build env", async () => {
    let spawnEnv: Record<string, string> | undefined
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      const opts = (args.length === 1 ? args[0] : args[1]) as
        | { env?: Record<string, string> }
        | undefined
      spawnEnv = opts?.env
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      configFile: "nixpacks.toml",
      nodeVersion: "22",
      buildEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd).toContain("--config")
    expect(cmd).toContain(path.join(tmpDir, "nixpacks.toml"))
    expect(spawnEnv?.["NIXPACKS_NODE_VERSION"]).toBe("22")
    expect(spawnEnv?.["NEXT_PUBLIC_API_URL"]).toBe("https://api.example.com")
    // buildEnv values must also reach the Dockerfile via `--env K=V`.
    expect(cmd).toContain("NEXT_PUBLIC_API_URL=https://api.example.com")
  })

  it("uses Node 22 as the default Nixpacks Node version", async () => {
    let spawnEnv: Record<string, string> | undefined
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      const opts = (args.length === 1 ? args[0] : args[1]) as
        | { env?: Record<string, string> }
        | undefined
      spawnEnv = opts?.env
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(spawnEnv?.["NIXPACKS_NODE_VERSION"]).toBe("22")
    expect(cmd).toContain("NIXPACKS_NODE_VERSION=22")
  })

  it("lets app nodeVersion override buildEnv NIXPACKS_NODE_VERSION", async () => {
    let spawnEnv: Record<string, string> | undefined
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      const opts = (args.length === 1 ? args[0] : args[1]) as
        | { env?: Record<string, string> }
        | undefined
      spawnEnv = opts?.env
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      nodeVersion: "22",
      buildEnv: { NIXPACKS_NODE_VERSION: "20" },
    })

    expect(spawnEnv?.["NIXPACKS_NODE_VERSION"]).toBe("22")
  })

  it("injects NPM_CONFIG_LEGACY_PEER_DEPS=true into build env by default", async () => {
    let spawnEnv: Record<string, string> | undefined
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      const opts = (args.length === 1 ? args[0] : args[1]) as
        | { env?: Record<string, string> }
        | undefined
      spawnEnv = opts?.env
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(spawnEnv?.["NPM_CONFIG_LEGACY_PEER_DEPS"]).toBe("true")
    expect(cmd).toContain("--env")
    expect(cmd).toContain("NPM_CONFIG_LEGACY_PEER_DEPS=true")
  })

  it("injects COMPOSER_ALLOW_SUPERUSER=1 for Composer projects", async () => {
    await writeFile(
      path.join(tmpDir, "composer.json"),
      JSON.stringify({ require: { "symfony/flex": "^2" } })
    )

    let spawnEnv: Record<string, string> | undefined
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      const opts = (args.length === 1 ? args[0] : args[1]) as
        | { env?: Record<string, string> }
        | undefined
      spawnEnv = opts?.env
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-symfony:sha123",
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(spawnEnv?.["COMPOSER_ALLOW_SUPERUSER"]).toBe("1")
    expect(cmd).toContain("--env")
    expect(cmd).toContain("COMPOSER_ALLOW_SUPERUSER=1")
  })

  it("rewrites the Nixpacks PHP packages from composer.lock constraints", async () => {
    await writeFile(
      path.join(tmpDir, "composer.json"),
      JSON.stringify({ require: { php: "^8.3" } })
    )
    await writeFile(
      path.join(tmpDir, "composer.lock"),
      JSON.stringify({
        packages: [
          {
            name: "symfony/var-dumper",
            require: { php: ">=8.4" },
          },
        ],
      })
    )

    const rawPlan = {
      providers: [],
      phases: {
        setup: {
          nixPkgs: [
            "(php83.withExtensions (pe: pe.enabled ++ []))",
            "php83Packages.composer",
            "nginx",
          ],
        },
        install: { cmds: ["composer install --ignore-platform-reqs"] },
      },
    }

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
      if (cmd.includes("plan")) {
        return fakeBunProcess({
          stdoutLines: [JSON.stringify(rawPlan)],
        }) as ReturnType<typeof Bun.spawn>
      }
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    const logs: string[] = []
    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      onLog: (line) => logs.push(line),
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls.find((call) =>
      (call[0] as string[]).includes("build")
    )
    const cmd = buildCall![0] as string[]
    const jsonPlanIdx = cmd.indexOf("--json-plan")
    expect(jsonPlanIdx).toBeGreaterThan(-1)

    const plan = JSON.parse(cmd[jsonPlanIdx + 1]!) as {
      phases: { setup: { nixPkgs: string[] } }
    }
    expect(plan.phases.setup.nixPkgs).toContain(
      "(php84.withExtensions (pe: pe.enabled ++ []))"
    )
    expect(plan.phases.setup.nixPkgs).toContain("php84Packages.composer")
    expect(logs.join("\n")).toContain(
      "PHP version resolved from Composer constraints: 8.4"
    )
  })

  it("wraps Laravel SQLite start commands to create the database and migrate", async () => {
    await writeFile(
      path.join(tmpDir, "composer.json"),
      JSON.stringify({ require: { php: "^8.4" } })
    )
    await writeFile(path.join(tmpDir, "artisan"), "")
    await mkdir(path.join(tmpDir, "database", "migrations"), {
      recursive: true,
    })
    await writeFile(path.join(tmpDir, ".env.example"), "DB_CONNECTION=sqlite\n")

    const rawPlan = {
      providers: [],
      phases: {
        setup: {
          nixPkgs: ["php84Packages.composer"],
        },
        install: { cmds: ["composer install --ignore-platform-reqs"] },
      },
      start: { cmd: "php artisan serve --host=0.0.0.0 --port=$PORT" },
    }

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
      if (cmd.includes("plan")) {
        return fakeBunProcess({
          stdoutLines: [JSON.stringify(rawPlan)],
        }) as ReturnType<typeof Bun.spawn>
      }
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    const logs: string[] = []
    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-laravel:sha123",
      runtimeEnv: { DB_CONNECTION: "sqlite" },
      onLog: (line) => logs.push(line),
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls.find((call) =>
      (call[0] as string[]).includes("build")
    )
    const cmd = buildCall![0] as string[]
    const jsonPlanIdx = cmd.indexOf("--json-plan")
    expect(jsonPlanIdx).toBeGreaterThan(-1)

    const plan = JSON.parse(cmd[jsonPlanIdx + 1]!) as {
      start: { cmd: string }
    }
    expect(plan.start.cmd).toContain("PLOYDOK_LARAVEL_SQLITE_BOOTSTRAP")
    expect(plan.start.cmd).toContain("php artisan migrate --force")
    expect(plan.start.cmd).toContain("PLOYDOK_LARAVEL_SEED")
    expect(plan.start.cmd).toContain("php artisan db:seed --force")
    expect(plan.start.cmd).toContain(
      "php artisan serve --host=0.0.0.0 --port=$PORT"
    )
    expect(logs.join("\n")).toContain("Laravel SQLite bootstrap enabled")
  })

  it("disables Nixpacks Laravel optional env warnings while keeping prestart", async () => {
    await writeFile(path.join(tmpDir, "composer.json"), JSON.stringify({}))
    await writeFile(path.join(tmpDir, "artisan"), "")

    const rawPlan = {
      providers: [],
      phases: {
        setup: {
          nixPkgs: ["php84Packages.composer"],
        },
        install: { cmds: ["composer install --ignore-platform-reqs"] },
      },
      start: {
        cmd: "node /assets/scripts/prestart.mjs /assets/nginx.template.conf /nginx.conf && (php-fpm -y /assets/php-fpm.conf & nginx -c /nginx.conf)",
      },
    }

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
      if (cmd.includes("plan")) {
        return fakeBunProcess({
          stdoutLines: [JSON.stringify(rawPlan)],
        }) as ReturnType<typeof Bun.spawn>
      }
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    const logs: string[] = []
    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-laravel:sha123",
      onLog: (line) => logs.push(line),
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls.find((call) =>
      (call[0] as string[]).includes("build")
    )
    const cmd = buildCall![0] as string[]
    const jsonPlanIdx = cmd.indexOf("--json-plan")
    expect(jsonPlanIdx).toBeGreaterThan(-1)

    const plan = JSON.parse(cmd[jsonPlanIdx + 1]!) as {
      start: { cmd: string }
    }
    expect(plan.start.cmd).toContain(
      "IS_LARAVEL= node /assets/scripts/prestart.mjs"
    )
    expect(plan.start.cmd).toContain("php-fpm")
    expect(logs.join("\n")).toContain("Laravel prestart env reference warnings")
  })

  it("wraps Symfony Doctrine projects to migrate before start when DATABASE_URL is present", async () => {
    await writeFile(path.join(tmpDir, "composer.json"), JSON.stringify({}))
    await mkdir(path.join(tmpDir, "bin"), { recursive: true })
    await writeFile(path.join(tmpDir, "bin", "console"), "")
    await mkdir(path.join(tmpDir, "migrations"), { recursive: true })

    const rawPlan = {
      providers: [],
      phases: {
        setup: {
          nixPkgs: ["php84Packages.composer"],
        },
        install: { cmds: ["composer install --ignore-platform-reqs"] },
      },
      start: {
        cmd: "node /assets/scripts/prestart.mjs /assets/nginx.template.conf /nginx.conf && (php-fpm -y /assets/php-fpm.conf & nginx -c /nginx.conf)",
      },
    }

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
      if (cmd.includes("plan")) {
        return fakeBunProcess({
          stdoutLines: [JSON.stringify(rawPlan)],
        }) as ReturnType<typeof Bun.spawn>
      }
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    const logs: string[] = []
    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-symfony:sha123",
      onLog: (line) => logs.push(line),
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls.find((call) =>
      (call[0] as string[]).includes("build")
    )
    const cmd = buildCall![0] as string[]
    const jsonPlanIdx = cmd.indexOf("--json-plan")
    expect(jsonPlanIdx).toBeGreaterThan(-1)

    const plan = JSON.parse(cmd[jsonPlanIdx + 1]!) as {
      start: { cmd: string }
    }
    expect(plan.start.cmd).toContain("PLOYDOK_SYMFONY_DOCTRINE_BOOTSTRAP")
    expect(plan.start.cmd).toContain(
      "php bin/console doctrine:migrations:migrate --no-interaction"
    )
    expect(plan.start.cmd).toContain('[ -n "${DATABASE_URL:-}" ]')
    expect(plan.start.cmd).toContain("node /assets/scripts/prestart.mjs")
    expect(logs.join("\n")).toContain(
      "Symfony Doctrine migrations bootstrap enabled"
    )
  })

  it("fails fast with a Dockerfile/custom image hint for unsupported PHP constraints", async () => {
    await writeFile(
      path.join(tmpDir, "composer.json"),
      JSON.stringify({ require: { php: "^7.4" } })
    )

    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    )

    await expect(
      nixpacksMod.nixpacksBuild({
        workspacePath: tmpDir,
        tag: "127.0.0.1:5000/app-legacy:sha123",
      })
    ).rejects.toThrow(
      /Supported PHP versions are 8\.1, 8\.2, 8\.3, 8\.4.*Dockerfile or a custom image.*7\.4/
    )

    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it("allows buildEnv to override NPM_CONFIG_LEGACY_PEER_DEPS", async () => {
    let spawnEnv: Record<string, string> | undefined
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      const opts = (args.length === 1 ? args[0] : args[1]) as
        | { env?: Record<string, string> }
        | undefined
      spawnEnv = opts?.env
      return fakeBunProcess({}) as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn)

    await nixpacksMod.nixpacksBuild({
      workspacePath: tmpDir,
      tag: "127.0.0.1:5000/app-abc:sha123",
      buildEnv: { NPM_CONFIG_LEGACY_PEER_DEPS: "false" },
    })

    expect(spawnEnv?.["NPM_CONFIG_LEGACY_PEER_DEPS"]).toBe("false")
  })

  it("passes the default Node version to nixpacks plan", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stdoutLines: ['{"providers":["node"],"phases":{"build":{}}}'],
      }) as ReturnType<typeof Bun.spawn>
    )

    await nixpacksMod.nixpacksPlan({
      workspacePath: tmpDir,
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const buildCall = spawnMock.mock.calls[0]
    const cmd = buildCall![0] as string[]
    expect(cmd).toContain("NIXPACKS_NODE_VERSION=22")
  })

  it("maps NIXPACKS_INSTALL_CMD build env values to nixpacks plan flags", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stdoutLines: ['{"providers":["php"],"phases":{"install":{}}}'],
      }) as ReturnType<typeof Bun.spawn>
    )

    await nixpacksMod.nixpacksPlan({
      workspacePath: tmpDir,
      buildEnv: {
        NIXPACKS_INSTALL_CMD:
          "COMPOSER_ALLOW_SUPERUSER=1 composer install --ignore-platform-reqs",
      },
    })

    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const planCall = spawnMock.mock.calls[0]
    const cmd = planCall![0] as string[]
    expect(cmd).toContain("--install-cmd")
    expect(cmd).toContain(
      "COMPOSER_ALLOW_SUPERUSER=1 composer install --ignore-platform-reqs"
    )
  })

  it("returns the planned start command and applies config/command overrides", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stdoutLines: [
          '{"providers":["python"],"phases":{"install":{}},"start":{"cmd":"gunicorn app:app"}}',
        ],
      }) as ReturnType<typeof Bun.spawn>
    )

    const plan = await nixpacksMod.nixpacksPlan({
      workspacePath: tmpDir,
      configFile: "nixpacks.toml",
      startCmd: "gunicorn --bind 0.0.0.0:$PORT app:app",
    })

    expect(plan?.start?.cmd).toBe("gunicorn app:app")
    const spawnMock = spawnSpy as unknown as {
      mock: { calls: Array<[unknown[], unknown]> }
    }
    const cmd = spawnMock.mock.calls[0]![0] as string[]
    expect(cmd).toContain("--config")
    expect(cmd).toContain(path.join(tmpDir, "nixpacks.toml"))
    expect(cmd).toContain("--start-cmd")
    expect(cmd).toContain("gunicorn --bind 0.0.0.0:$PORT app:app")
  })
})
