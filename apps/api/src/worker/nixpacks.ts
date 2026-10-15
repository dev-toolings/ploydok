// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  NIXPACKS_SUPPORTED_PHP_VERSIONS,
  NIXPACKS_SUPPORTED_PHP_VERSIONS_LABEL,
  type NixpacksSupportedPhpVersion,
} from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Ensure the `nixpacks` binary is available.
 *
 * Resolution order:
 *  1. Check if `nixpacks` is already on PATH (typical in prod / CI).
 *  2. Check `~/.ploydok-dev/bin/nixpacks` (already downloaded).
 *  3. Download the latest release binary from GitHub.
 *
 * Returns the absolute path to the binary.
 */
export async function ensureNixpacksInstalled(): Promise<string> {
  // 1. Check PATH
  const which = Bun.spawn(["which", "nixpacks"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await which.exited
  if (which.exitCode === 0) {
    return (await new Response(which.stdout).text()).trim()
  }

  if (
    process.env["NODE_ENV"] === "production" ||
    process.env["NODE_ENV"] === "prod"
  ) {
    throw new Error(
      "nixpacks is missing from the production image; refusing an unpinned runtime download"
    )
  }

  // 2. Check local dev cache
  const binDir = path.join(os.homedir(), ".ploydok-dev", "bin")
  const binPath = path.join(binDir, "nixpacks")
  if (existsSync(binPath)) return binPath

  if (!nixpacksInstallPromise) {
    nixpacksInstallPromise = downloadNixpacks(binDir, binPath).finally(() => {
      nixpacksInstallPromise = null
    })
  }
  return nixpacksInstallPromise
}

let nixpacksInstallPromise: Promise<string> | null = null

async function downloadNixpacks(
  binDir: string,
  binPath: string
): Promise<string> {
  // Download from GitHub releases.
  // Release assets embed the version in the filename
  // (e.g. `nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz`),
  // so `releases/latest/download/...` without the version returns 404.
  // We resolve the current tag via the API first, then build a versioned URL.
  await mkdir(binDir, { recursive: true })

  const arch = process.arch === "x64" ? "x86_64" : "aarch64"

  const metaRes = await fetch(
    "https://api.github.com/repos/railwayapp/nixpacks/releases/latest",
    {
      headers: {
        "User-Agent": "ploydok",
        Accept: "application/vnd.github+json",
      },
    }
  )
  if (!metaRes.ok) {
    throw new Error(`nixpacks release lookup failed (${metaRes.status})`)
  }
  const meta = (await metaRes.json()) as { tag_name?: string }
  const tag = meta.tag_name
  if (!tag) {
    throw new Error("nixpacks release lookup returned no tag_name")
  }

  const tarName = `nixpacks-${tag}-${arch}-unknown-linux-musl.tar.gz`
  const url = `https://github.com/railwayapp/nixpacks/releases/download/${tag}/${tarName}`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`nixpacks download failed (${res.status}): ${url}`)
  }

  // Write/extract in a private temp dir, then atomically publish the binary.
  // This prevents concurrent workers from executing a half-written nixpacks
  // binary on first boot.
  const tmpDir = path.join(
    binDir,
    `.nixpacks-install-${process.pid}-${Date.now()}`
  )
  await mkdir(tmpDir, { recursive: true })
  const tmpTar = path.join(tmpDir, tarName)
  const buf = await res.arrayBuffer()
  await Bun.write(tmpTar, buf)

  // Extract with `tar` — available on any Linux/macOS host.
  const tar = Bun.spawn(["tar", "-xzf", tmpTar, "-C", tmpDir], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const tarCode = await tar.exited
  if (tarCode !== 0) {
    const stderr = await new Response(tar.stderr).text()
    throw new Error(`nixpacks tar extraction failed (${tarCode}): ${stderr}`)
  }

  // The archive contains a single `nixpacks` binary at the root.
  const tmpBin = path.join(tmpDir, "nixpacks")
  await chmod(tmpBin, 0o755)
  await rename(tmpBin, binPath)
  await rm(tmpDir, { recursive: true, force: true })
  await chmod(binPath, 0o755)
  return binPath
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface NixpacksBuildOptions {
  workspacePath: string
  /** Sub-directory within the workspace to build. Default: '.'. */
  rootDir?: string
  /** Docker image tag to produce (e.g. `registry/name:sha`). */
  tag: string
  /**
   * Stable key used for `--cache-key` (typically the app ID).
   * Must not change between builds of the same app — do not use the image SHA.
   */
  cacheKey?: string
  /**
   * Local directory where Nixpacks may store build-layer cache.
   * Created automatically if it doesn't exist.
   */
  cacheDir?: string
  /**
   * Registry image reference used as an incremental cache source **and**
   * destination, e.g. `127.0.0.1:5000/app-xyz:cache`.
   *
   * When provided, the `--incremental-cache-image=<ref>` flag is passed to
   * nixpacks, which pulls this image at build start to seed the layer cache
   * and pushes an updated image at the end.  This is the only BuildKit-level
   * cache exchange that the nixpacks CLI exposes natively.
   */
  dockerCacheRef?: string
  configFile?: string
  nodeVersion?: string
  buildEnv?: Record<string, string>
  runtimeEnv?: Record<string, string>
  installCmd?: string
  buildCmd?: string
  startCmd?: string
  /** Called for every stdout/stderr line emitted by nixpacks. */
  onLog?: (line: string) => void
  signal?: AbortSignal
}

export const DEFAULT_NIXPACKS_NODE_VERSION = "22"

function effectiveNixpacksEnv(
  opts: Pick<NixpacksBuildOptions, "nodeVersion" | "buildEnv">,
  defaults: Record<string, string> = {}
): Record<string, string> {
  return {
    ...defaults,
    NIXPACKS_NODE_VERSION: DEFAULT_NIXPACKS_NODE_VERSION,
    ...(opts.buildEnv ?? {}),
    ...(opts.nodeVersion ? { NIXPACKS_NODE_VERSION: opts.nodeVersion } : {}),
  }
}

function normalizeCommandOverride(
  value: string | null | undefined
): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function resolveNixpacksCommandOverrides(opts: {
  buildEnv?: Record<string, string>
  installCmd?: string
  buildCmd?: string
  startCmd?: string
}): {
  installCmd?: string
  buildCmd?: string
  startCmd?: string
} {
  const installCmd =
    normalizeCommandOverride(opts.installCmd) ??
    normalizeCommandOverride(opts.buildEnv?.["NIXPACKS_INSTALL_CMD"])
  const buildCmd =
    normalizeCommandOverride(opts.buildCmd) ??
    normalizeCommandOverride(opts.buildEnv?.["NIXPACKS_BUILD_CMD"])
  const startCmd =
    normalizeCommandOverride(opts.startCmd) ??
    normalizeCommandOverride(opts.buildEnv?.["NIXPACKS_START_CMD"])

  return {
    ...(installCmd ? { installCmd } : {}),
    ...(buildCmd ? { buildCmd } : {}),
    ...(startCmd ? { startCmd } : {}),
  }
}

/**
 * Run `nixpacks build` for the given workspace.
 * Streams stdout and stderr through `opts.onLog` line by line.
 * Throws if the process exits with a non-zero code.
 */
export interface NixpacksGeneratedContext {
  contextDir: string
  dockerfile: string
}

/**
 * Recursive copy that never follows symlinks, never overwrites an existing
 * destination file, and skips the top-level `.git` plus the output dir itself
 * (fs.cp refuses a destination inside its source).
 */
async function copySources(
  src: string,
  dest: string,
  skip: string,
  top = true
): Promise<void> {
  if (!existsSync(src)) return
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (path.resolve(from) === skip) continue
    if (top && entry.name === ".git") continue
    if (entry.isDirectory()) {
      await copySources(from, to, skip, false)
    } else if (!existsSync(to)) {
      if (entry.isSymbolicLink()) {
        await symlink(await readlink(from), to)
      } else {
        await copyFile(from, to)
      }
    }
  }
}

export async function nixpacksBuild(
  opts: NixpacksBuildOptions
): Promise<NixpacksGeneratedContext> {
  const bin = await ensureNixpacksInstalled()
  const ctx = path.join(opts.workspacePath, opts.rootDir ?? ".")
  const commandOverrides = resolveNixpacksCommandOverrides(opts)

  // npm v7+ defaults to strict peer-dep resolution, which breaks on the very
  // common Next.js / React pre-release mismatches (e.g. next@15.0.3 peer
  // ^18 || 19.0.0-rc-... vs react@19.0.0 stable). Other PaaS (Vercel,
  // Netlify, Railway) relax this by default; we follow suit so auto-detected
  // Node projects build out-of-the-box. User-provided buildEnv can override.
  //
  // Nixpacks still falls back to Node 18 on some PHP+Vite projects. Modern
  // Laravel/Vite dependencies now require Node 20.19+ or 22.12+, so pin a
  // platform default and let per-app nodeVersion/env settings override it.
  //
  // Composer disables plugins automatically when it runs as root unless
  // COMPOSER_ALLOW_SUPERUSER=1 is present. Nixpacks-generated PHP Dockerfiles
  // run composer inside a root build step, so Symfony Flex's `symfony-cmd`
  // helper can disappear before auto-scripts run. Apply the Composer root
  // opt-in for PHP projects even when stack auto-injection did not provide a
  // custom install command.
  const composerBuildDefaults = existsSync(path.join(ctx, "composer.json"))
    ? { COMPOSER_ALLOW_SUPERUSER: "1" }
    : {}
  const effectiveBuildEnv = effectiveNixpacksEnv(opts, {
    NPM_CONFIG_LEGACY_PEER_DEPS: "true",
    ...composerBuildDefaults,
  })

  const phpPlanOverride = await resolvePhpAwareNixpacksPlan({
    bin,
    ctx,
    env: effectiveBuildEnv,
    ...(opts.configFile
      ? { configFile: path.join(opts.workspacePath, opts.configFile) }
      : {}),
    ...(commandOverrides.installCmd
      ? { installCmd: commandOverrides.installCmd }
      : {}),
    ...(commandOverrides.buildCmd
      ? { buildCmd: commandOverrides.buildCmd }
      : {}),
    ...(commandOverrides.startCmd
      ? { startCmd: commandOverrides.startCmd }
      : {}),
    ...(opts.runtimeEnv ? { runtimeEnv: opts.runtimeEnv } : {}),
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
  })

  // Ensure the cache directory exists before spawning.
  if (opts.cacheDir) {
    mkdirSync(opts.cacheDir, { recursive: true })
  }

  // Generated contexts may contain the full application source and therefore
  // must not consume the API container's deliberately small /tmp tmpfs. In
  // production cacheDir lives on the explicit writable build-data mount, so
  // place the disposable context alongside it. Tests and callers without a
  // cache directory retain the normal OS temporary-directory fallback.
  const outputParent = opts.cacheDir ? path.dirname(opts.cacheDir) : os.tmpdir()
  await mkdir(outputParent, { recursive: true })
  const outputDir = await mkdtemp(
    path.join(outputParent, ".ploydok-nixpacks-context-")
  )
  const args = [
    ...(phpPlanOverride ? ["--json-plan", phpPlanOverride] : []),
    "build",
    ctx,
    "--name",
    opts.tag,
    "--out",
    outputDir,
  ]

  // Pass a stable cache key so Nixpacks can reuse layer cache across builds
  // of the same app.  We use `cacheKey` (the app ID) rather than `tag` because
  // the tag embeds the commit SHA and changes every build.
  if (opts.cacheDir && opts.cacheKey) {
    args.push("--cache-key", opts.cacheKey)
  } else if (opts.cacheDir) {
    // cacheDir provided without an explicit cacheKey — derive a stable key
    // from the cache directory name (last path segment = app ID in practice).
    args.push("--cache-key", path.basename(opts.cacheDir))
  }

  // Enable incremental-cache via a registry image (nixpacks native flag).
  // Requires a writable registry ref — we only wire this when both the remote
  // cache ref and a local cacheDir are provided (same gating as before).
  if (opts.dockerCacheRef && opts.cacheDir) {
    args.push(`--incremental-cache-image=${opts.dockerCacheRef}`)
  }

  if (opts.configFile)
    args.push("--config", path.join(opts.workspacePath, opts.configFile))
  if (commandOverrides.installCmd) {
    args.push("--install-cmd", commandOverrides.installCmd)
  }
  if (commandOverrides.buildCmd) {
    args.push("--build-cmd", commandOverrides.buildCmd)
  }
  if (commandOverrides.startCmd) {
    args.push("--start-cmd", commandOverrides.startCmd)
  }

  // Propagate build env into the generated Dockerfile via nixpacks `--env`.
  // Without this flag, variables set on the host process are NOT seen by the
  // RUN steps inside the image build.
  for (const [key, value] of Object.entries(effectiveBuildEnv)) {
    args.push("--env", `${key}=${value}`)
  }

  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...effectiveBuildEnv,
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  async function pipeLogs(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        opts.onLog?.(line)
      }
    }
    // Flush any remaining content without a trailing newline
    if (buf) opts.onLog?.(buf)
  }

  await Promise.all([
    pipeLogs(proc.stdout as ReadableStream<Uint8Array>),
    pipeLogs(proc.stderr as ReadableStream<Uint8Array>),
  ])

  const code = await proc.exited
  if (code !== 0) {
    await rm(outputDir, { recursive: true, force: true })
    throw new Error(`nixpacks build failed (exit ${code}) for tag ${opts.tag}`)
  }

  // `nixpacks build --out` writes only `.nixpacks/`. The generated Dockerfile
  // does `COPY . /app/.` and COPYs `.nixpacks/*` assets, so the context must
  // hold the sources too. Generated files win on clash (an existing destination
  // file is never overwritten); `.git` and the output dir itself (it may live
  // inside the workspace) are skipped. The original workspace is untouched.
  try {
    await copySources(ctx, outputDir, path.resolve(outputDir))
  } catch (err) {
    await rm(outputDir, { recursive: true, force: true })
    throw err
  }
  return {
    contextDir: outputDir,
    dockerfile: path.join(outputDir, ".nixpacks", "Dockerfile"),
  }
}

// ---------------------------------------------------------------------------
// Dynamic PHP version resolution
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>

interface ComposerPhpConstraint {
  source: string
  constraint: string
}

interface PhpResolution {
  version: NixpacksSupportedPhpVersion
  constraints: ComposerPhpConstraint[]
}

interface Interval {
  min: number
  max: number
}

async function resolvePhpAwareNixpacksPlan(opts: {
  bin: string
  ctx: string
  env: Record<string, string>
  configFile?: string
  installCmd?: string
  buildCmd?: string
  startCmd?: string
  runtimeEnv?: Record<string, string>
  onLog?: (line: string) => void
}): Promise<string | null> {
  const resolution = await resolveComposerPhpVersion(opts.ctx)
  const shouldBootstrapSqlite = await shouldBootstrapLaravelSqlite(
    opts.ctx,
    opts.runtimeEnv ?? {}
  )
  const shouldBootstrapSymfonyDoctrine =
    shouldBootstrapSymfonyDoctrineMigrations(opts.ctx)
  const shouldSuppressLaravelPrestartWarnings = existsSync(
    path.join(opts.ctx, "artisan")
  )
  if (
    !resolution &&
    !shouldBootstrapSqlite &&
    !shouldBootstrapSymfonyDoctrine &&
    !shouldSuppressLaravelPrestartWarnings
  ) {
    return null
  }

  const plan = await loadRawNixpacksPlan(opts)
  if (!plan) return null

  let changed = false
  if (resolution) {
    const rewritten = rewriteNixpacksPhpPackages(plan, resolution.version)
    changed = rewritten.changed

    if (rewritten.changed) {
      const reason = strongestPhpConstraint(resolution.constraints)
      opts.onLog?.(
        `[nixpacks] PHP version resolved from Composer constraints: ${resolution.version}` +
          (reason ? ` (${reason.source}: ${reason.constraint})` : "")
      )
    }
  }

  if (shouldBootstrapSqlite && injectLaravelSqliteStartBootstrap(plan)) {
    changed = true
    opts.onLog?.(
      "[nixpacks] Laravel SQLite bootstrap enabled: create database file and run migrations before start; seeders are opt-in"
    )
  }

  if (
    shouldBootstrapSymfonyDoctrine &&
    injectSymfonyDoctrineMigrationsStartBootstrap(plan)
  ) {
    changed = true
    opts.onLog?.(
      "[nixpacks] Symfony Doctrine migrations bootstrap enabled: run migrations before start when DATABASE_URL is present"
    )
  }

  if (
    shouldSuppressLaravelPrestartWarnings &&
    suppressLaravelPrestartEnvWarnings(plan)
  ) {
    changed = true
    opts.onLog?.(
      "[nixpacks] Laravel prestart env reference warnings disabled; Ploydok injects runtime defaults separately"
    )
  }

  return changed ? JSON.stringify(plan) : null
}

async function loadRawNixpacksPlan(opts: {
  bin: string
  ctx: string
  env: Record<string, string>
  configFile?: string
  installCmd?: string
  buildCmd?: string
  startCmd?: string
}): Promise<JsonObject | null> {
  const args = ["plan", opts.ctx, "--format=json"]
  if (opts.configFile) args.push("--config", opts.configFile)
  if (opts.installCmd) args.push("--install-cmd", opts.installCmd)
  if (opts.buildCmd) args.push("--build-cmd", opts.buildCmd)
  if (opts.startCmd) args.push("--start-cmd", opts.startCmd)

  for (const [key, value] of Object.entries(opts.env)) {
    args.push("--env", `${key}=${value}`)
  }

  const proc = Bun.spawn([opts.bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  })
  const code = await proc.exited
  if (code !== 0) return null

  const out = await new Response(proc.stdout).text()
  const start = out.indexOf("{")
  const end = out.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null

  try {
    return JSON.parse(out.slice(start, end + 1)) as JsonObject
  } catch {
    return null
  }
}

function rewriteNixpacksPhpPackages(
  plan: JsonObject,
  version: NixpacksSupportedPhpVersion
): { plan: JsonObject; changed: boolean } {
  const setup = readPlanSetupPhase(plan)
  const nixPkgs = setup?.["nixPkgs"]
  if (!Array.isArray(nixPkgs)) return { plan, changed: false }

  const phpSuffix = version.replace(".", "")
  let sawPhpPackage = false
  let changed = false
  const nextPkgs = nixPkgs.map((pkg) => {
    if (typeof pkg !== "string") return pkg
    const next = pkg
      .replace(/\bphp\d{2}(?=\.withExtensions\b|\b)/g, `php${phpSuffix}`)
      .replace(/\bphp\d{2}Packages\b/g, `php${phpSuffix}Packages`)

    if (next !== pkg) {
      sawPhpPackage = true
      changed = true
    } else if (/\bphp\d{2}(?:Packages|\.withExtensions\b|\b)/.test(pkg)) {
      sawPhpPackage = true
    }
    return next
  })

  if (!sawPhpPackage || !changed) return { plan, changed: false }
  if (!setup) return { plan, changed: false }
  setup["nixPkgs"] = nextPkgs
  return { plan, changed: true }
}

async function shouldBootstrapLaravelSqlite(
  ctx: string,
  runtimeEnv: Record<string, string>
): Promise<boolean> {
  if (!existsSync(path.join(ctx, "artisan"))) return false
  if (!existsSync(path.join(ctx, "database", "migrations"))) return false

  const explicitConnection = normalizeEnvValue(runtimeEnv["DB_CONNECTION"])
  if (explicitConnection && explicitConnection !== "sqlite") return false
  if (normalizeEnvValue(runtimeEnv["DATABASE_URL"])) return false
  if (!explicitConnection && normalizeEnvValue(runtimeEnv["DB_HOST"])) {
    return false
  }

  const exampleConnection = normalizeEnvValue(
    await readEnvFileValue(path.join(ctx, ".env.example"), "DB_CONNECTION")
  )
  if (
    !explicitConnection &&
    exampleConnection &&
    exampleConnection !== "sqlite"
  ) {
    return false
  }

  return explicitConnection === "sqlite" || exampleConnection === "sqlite"
}

function shouldBootstrapSymfonyDoctrineMigrations(ctx: string): boolean {
  if (existsSync(path.join(ctx, "artisan"))) return false
  if (!existsSync(path.join(ctx, "bin", "console"))) return false
  if (!existsSync(path.join(ctx, "migrations"))) return false
  return true
}

function injectLaravelSqliteStartBootstrap(plan: JsonObject): boolean {
  const start = plan["start"]
  if (!isJsonObject(start)) return false
  const cmd = start["cmd"]
  if (typeof cmd !== "string" || cmd.trim().length === 0) return false
  if (cmd.includes("PLOYDOK_LARAVEL_SQLITE_BOOTSTRAP")) return false

  start["cmd"] = `${LARAVEL_SQLITE_BOOTSTRAP_CMD}; ${cmd}`
  return true
}

function injectSymfonyDoctrineMigrationsStartBootstrap(
  plan: JsonObject
): boolean {
  const start = plan["start"]
  if (!isJsonObject(start)) return false
  const cmd = start["cmd"]
  if (typeof cmd !== "string" || cmd.trim().length === 0) return false
  if (cmd.includes("PLOYDOK_SYMFONY_DOCTRINE_BOOTSTRAP")) return false

  start["cmd"] = `${SYMFONY_DOCTRINE_MIGRATIONS_BOOTSTRAP_CMD} && ${cmd}`
  return true
}

function suppressLaravelPrestartEnvWarnings(plan: JsonObject): boolean {
  const start = plan["start"]
  if (!isJsonObject(start)) return false
  const cmd = start["cmd"]
  if (typeof cmd !== "string" || cmd.trim().length === 0) return false
  if (cmd.includes("IS_LARAVEL= node /assets/scripts/prestart.mjs")) {
    return false
  }
  if (!cmd.includes("node /assets/scripts/prestart.mjs")) return false

  start["cmd"] = cmd.replace(
    "node /assets/scripts/prestart.mjs",
    "IS_LARAVEL= node /assets/scripts/prestart.mjs"
  )
  return true
}

const LARAVEL_SQLITE_BOOTSTRAP_CMD =
  `if [ -f artisan ] && [ -z "\${DATABASE_URL:-}" ] && ` +
  `[ "\${DB_CONNECTION:-sqlite}" = "sqlite" ]; then ` +
  `export PLOYDOK_LARAVEL_SQLITE_BOOTSTRAP=1; ` +
  `db="\${DB_DATABASE:-/app/database/database.sqlite}"; ` +
  `case "$db" in /*) ;; *) db="/app/$db";; esac; ` +
  `created=0; if [ ! -f "$db" ]; then created=1; fi; ` +
  `mkdir -p "$(dirname "$db")"; touch "$db"; ` +
  `echo "[ploydok] preparing Laravel SQLite database at $db"; ` +
  `php artisan migrate --force; ` +
  `seed="\${PLOYDOK_LARAVEL_SEED:-\${LARAVEL_SEED:-false}}"; ` +
  `case "$seed" in 1|true|TRUE|yes|YES) ` +
  `if [ "$created" = "1" ]; then ` +
  `echo "[ploydok] seeding fresh Laravel SQLite database"; ` +
  `php artisan db:seed --force; ` +
  `fi ;; ` +
  `*) if [ "$created" = "1" ] && [ -d database/seeders ]; then ` +
  `echo "[ploydok] Laravel seeders detected but not run; set PLOYDOK_LARAVEL_SEED=true to seed a fresh SQLite database"; ` +
  `fi ;; ` +
  `esac; ` +
  `fi`

const SYMFONY_DOCTRINE_MIGRATIONS_BOOTSTRAP_CMD =
  `if [ -f bin/console ] && [ -d migrations ] && ` +
  `[ -n "\${DATABASE_URL:-}" ]; then ` +
  `export PLOYDOK_SYMFONY_DOCTRINE_BOOTSTRAP=1; ` +
  `echo "[ploydok] preparing Symfony Doctrine migrations"; ` +
  `php bin/console doctrine:migrations:migrate --no-interaction ` +
  `--allow-no-migration --env="\${APP_ENV:-prod}"; ` +
  `fi`

async function readEnvFileValue(
  filePath: string,
  key: string
): Promise<string | null> {
  if (!existsSync(filePath)) return null
  try {
    const text = await readFile(filePath, "utf8")
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = text.match(
      new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.*)$`, "m")
    )
    if (!match) return null
    return stripEnvQuotes(match[1] ?? "")
  } catch {
    return null
  }
}

function stripEnvQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function normalizeEnvValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

function readPlanSetupPhase(plan: JsonObject): JsonObject | null {
  const phases = plan["phases"]
  if (!isJsonObject(phases)) return null
  const setup = phases["setup"]
  return isJsonObject(setup) ? setup : null
}

async function resolveComposerPhpVersion(
  ctx: string
): Promise<PhpResolution | null> {
  if (!existsSync(path.join(ctx, "composer.json"))) return null

  const constraints = await readComposerPhpConstraints(ctx)
  if (constraints.length === 0) return null

  const version = NIXPACKS_SUPPORTED_PHP_VERSIONS.find((candidate) =>
    constraints.every(({ constraint }) =>
      composerConstraintAllowsPhpMinor(constraint, candidate)
    )
  )

  if (!version) {
    throw new Error(
      "Nixpacks cannot build this PHP version. " +
        `Supported PHP versions are ${NIXPACKS_SUPPORTED_PHP_VERSIONS_LABEL}. ` +
        "Use a Dockerfile or a custom image for older PHP versions such as 7.4. " +
        `Composer constraints: ${constraints
          .map((c) => `${c.source}=${c.constraint}`)
          .join(", ")}`
    )
  }

  return { version, constraints }
}

async function readComposerPhpConstraints(
  ctx: string
): Promise<ComposerPhpConstraint[]> {
  const constraints: ComposerPhpConstraint[] = []
  const composerJson = await readJsonFile(path.join(ctx, "composer.json"))
  const rootPhp = readRequirePhp(composerJson)
  if (rootPhp) {
    constraints.push({ source: "composer.json", constraint: rootPhp })
  }

  const lock = await readJsonFile(path.join(ctx, "composer.lock"))
  if (!lock) return constraints

  const platform = lock["platform"]
  if (isJsonObject(platform) && typeof platform["php"] === "string") {
    constraints.push({
      source: "composer.lock platform",
      constraint: platform["php"],
    })
  }

  for (const key of ["packages", "packages-dev"] as const) {
    const packages = lock[key]
    if (!Array.isArray(packages)) continue
    for (const pkg of packages) {
      if (!isJsonObject(pkg)) continue
      const php = readRequirePhp(pkg)
      const name = typeof pkg["name"] === "string" ? pkg["name"] : key
      if (php) constraints.push({ source: name, constraint: php })
    }
  }

  return constraints
}

function readRequirePhp(obj: unknown): string | null {
  if (!isJsonObject(obj)) return null
  const require = obj["require"]
  if (!isJsonObject(require)) return null
  return typeof require["php"] === "string" ? require["php"] : null
}

async function readJsonFile(filePath: string): Promise<JsonObject | null> {
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"))
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function strongestPhpConstraint(
  constraints: ComposerPhpConstraint[]
): ComposerPhpConstraint | null {
  let strongest: ComposerPhpConstraint | null = null
  let strongestMin = -1
  for (const constraint of constraints) {
    const min = minAllowedScore(constraint.constraint)
    if (min > strongestMin) {
      strongest = constraint
      strongestMin = min
    }
  }
  return strongest
}

function minAllowedScore(constraint: string): number {
  const intervals = parseComposerConstraint(constraint)
  if (intervals.length === 0) return 0
  return Math.min(...intervals.map((interval) => interval.min))
}

function composerConstraintAllowsPhpMinor(
  constraint: string,
  version: NixpacksSupportedPhpVersion
): boolean {
  const intervals = parseComposerConstraint(constraint)
  if (intervals.length === 0) return true

  const [major, minor] = version.split(".").map(Number) as [number, number]
  const candidate: Interval = {
    min: versionScore(major, minor, 0),
    max: versionScore(major, minor + 1, 0),
  }

  return intervals.some((interval) => intervalsOverlap(interval, candidate))
}

function parseComposerConstraint(constraint: string): Interval[] {
  const alternatives = constraint
    .split(/\s*\|\|?\s*/g)
    .map((part) => part.trim())
    .filter(Boolean)

  const intervals: Interval[] = []
  for (const alternative of alternatives) {
    const parsed = parseConstraintAlternative(alternative)
    if (parsed) intervals.push(parsed)
  }
  return intervals
}

function parseConstraintAlternative(alternative: string): Interval | null {
  const tokens = alternative
    .split(/[\s,]+/g)
    .map((token) => token.trim())
    .filter(Boolean)

  let interval: Interval = { min: 0, max: Number.POSITIVE_INFINITY }
  for (const token of tokens) {
    const next = parseConstraintToken(token)
    if (!next) continue
    interval = intersectIntervals(interval, next)
  }

  return interval.max > interval.min ? interval : null
}

function parseConstraintToken(token: string): Interval | null {
  const clean = token.replace(/@[\w.-]+$/, "")
  if (!clean || clean === "*" || clean.toLowerCase() === "x") return null
  if (clean.startsWith("!=") || clean.startsWith("<>")) return null

  if (clean.startsWith("^")) {
    const version = parseVersion(clean.slice(1))
    if (!version) return null
    return {
      min: versionScore(...version),
      max: versionScore(version[0] + 1, 0, 0),
    }
  }

  if (clean.startsWith("~")) {
    const raw = clean.slice(1)
    const version = parseVersion(raw)
    if (!version) return null
    const parts = raw.split(".").filter(Boolean)
    return {
      min: versionScore(...version),
      max:
        parts.length >= 3
          ? versionScore(version[0], version[1] + 1, 0)
          : versionScore(version[0] + 1, 0, 0),
    }
  }

  const comparator = clean.match(/^(>=|<=|>|<|={1,2})?(.+)$/)
  if (!comparator) return null

  const op = comparator[1] ?? "="
  const rawVersion = comparator[2] ?? ""
  if (/[xX*]/.test(rawVersion)) return wildcardInterval(rawVersion)

  const version = parseVersion(rawVersion)
  if (!version) return null
  const score = versionScore(...version)

  switch (op) {
    case ">=":
      return { min: score, max: Number.POSITIVE_INFINITY }
    case ">":
      return { min: score + 1, max: Number.POSITIVE_INFINITY }
    case "<=":
      return { min: 0, max: score + 1 }
    case "<":
      return { min: 0, max: score }
    case "=":
    case "==": {
      const upper =
        rawVersion.split(".").filter(Boolean).length <= 2
          ? versionScore(version[0], version[1] + 1, 0)
          : score + 1
      return { min: score, max: upper }
    }
    default:
      return null
  }
}

function wildcardInterval(rawVersion: string): Interval | null {
  const parts = rawVersion.split(".")
  const major = numberPart(parts[0])
  if (major === null) return null

  const minor = numberPart(parts[1])
  if (minor === null) {
    return {
      min: versionScore(major, 0, 0),
      max: versionScore(major + 1, 0, 0),
    }
  }

  return {
    min: versionScore(major, minor, 0),
    max: versionScore(major, minor + 1, 0),
  }
}

function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/)
  if (!match) return null
  const major = Number(match[1])
  const minor = numberPart(match[2]) ?? 0
  const patch = numberPart(match[3]) ?? 0
  return [major, minor, patch]
}

function numberPart(value: string | undefined): number | null {
  if (!value || /^(x|\*)$/i.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function versionScore(major: number, minor: number, patch: number): number {
  return major * 1_000_000 + minor * 1_000 + patch
}

function intersectIntervals(a: Interval, b: Interval): Interval {
  return { min: Math.max(a.min, b.min), max: Math.min(a.max, b.max) }
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.min < b.max && b.min < a.max
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Plan (pre-check)
// ---------------------------------------------------------------------------

export interface NixpacksPlan {
  providers?: string[]
  buildImage?: string
  variables?: Record<string, string>
  phases?: Record<string, unknown>
  start?: { cmd?: string }
  raw: unknown
}

/**
 * Run `nixpacks plan --format=json` against a workspace to preview the build
 * without executing it. Used as a cheap pre-flight check before the real
 * build: if Nixpacks matches no provider we can bail out early with a clear
 * message instead of letting a multi-minute build fail on an empty plan.
 *
 * Caveat: nixpacks plan can emit banner lines before the JSON payload
 * (see https://github.com/railwayapp/nixpacks/issues/1241). We parse from
 * the first `{` to the last `}` to tolerate it.
 *
 * Returns `null` when the plan command itself fails (non-zero exit) —
 * callers should treat that as "could not validate, proceed anyway".
 */
export async function nixpacksPlan(opts: {
  workspacePath: string
  rootDir?: string
  configFile?: string
  nodeVersion?: string
  buildEnv?: Record<string, string>
  installCmd?: string
  buildCmd?: string
  startCmd?: string
}): Promise<NixpacksPlan | null> {
  const bin = await ensureNixpacksInstalled()
  const ctx = path.join(opts.workspacePath, opts.rootDir ?? ".")

  const effectiveBuildEnv = effectiveNixpacksEnv(opts)
  const commandOverrides = resolveNixpacksCommandOverrides(opts)
  const args = ["plan", ctx, "--format=json"]
  if (opts.configFile) {
    args.push("--config", path.join(opts.workspacePath, opts.configFile))
  }
  if (commandOverrides.installCmd) {
    args.push("--install-cmd", commandOverrides.installCmd)
  }
  if (commandOverrides.buildCmd) {
    args.push("--build-cmd", commandOverrides.buildCmd)
  }
  if (commandOverrides.startCmd) {
    args.push("--start-cmd", commandOverrides.startCmd)
  }
  for (const [key, value] of Object.entries(effectiveBuildEnv)) {
    args.push("--env", `${key}=${value}`)
  }

  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...effectiveBuildEnv },
  })
  const code = await proc.exited
  if (code !== 0) return null

  const out = await new Response(proc.stdout).text()
  const start = out.indexOf("{")
  const end = out.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(out.slice(start, end + 1)) as {
      providers?: string[]
      buildImage?: string
      variables?: Record<string, string>
      phases?: Record<string, unknown>
      start?: { cmd?: string }
    }
    return {
      ...(parsed.providers !== undefined && { providers: parsed.providers }),
      ...(parsed.buildImage !== undefined && { buildImage: parsed.buildImage }),
      ...(parsed.variables !== undefined && { variables: parsed.variables }),
      ...(parsed.phases !== undefined && { phases: parsed.phases }),
      ...(parsed.start !== undefined && { start: parsed.start }),
      raw: parsed,
    }
  } catch {
    return null
  }
}
