#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sprint 3 DoD orchestrator.
 *
 * Runs the 11 Playwright specs sequentially, collects results, writes
 * .ai/reports/sprint-3-DoD.md.
 *
 * Usage:
 *   bun scripts/run-dod.ts [options]
 *
 * Options:
 *   --only=<N,N,...>    run only those DoD item numbers
 *   --skip=<N,N,...>    skip those DoD item numbers
 *   --dry-run           print the spec list and exit 0
 *   --no-prereq-check   bypass infra pre-requisite checks
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import os from "node:os"

// ---------------------------------------------------------------------------
// Spec list
// ---------------------------------------------------------------------------

interface SpecDef {
  file: string
  dod: string
  label: string
}

const SPECS: SpecDef[] = [
  {
    file: "01-nextjs-docker.spec.ts",
    dod: "#1",
    label: "deploy Next.js via Dockerfile",
  },
  {
    file: "02-nextjs-nixpacks.spec.ts",
    dod: "#1b",
    label: "deploy Next.js via Nixpacks",
  },
  {
    file: "03-fastapi-nixpacks.spec.ts",
    dod: "#2",
    label: "deploy FastAPI via Nixpacks",
  },
  {
    file: "04-monorepo.spec.ts",
    dod: "#3",
    label: "deploy monorepo (root_dir)",
  },
  {
    file: "05-build-cache.spec.ts",
    dod: "#4",
    label: "build cache — t2/t1 < 0.40",
  },
  {
    file: "06-zero-downtime.spec.ts",
    dod: "#5",
    label: "zero-downtime — 0× 5xx during redeploy",
  },
  {
    file: "07-healthcheck-custom.spec.ts",
    dod: "#6",
    label: "healthcheck custom",
  },
  {
    file: "08-logs-latency.spec.ts",
    dod: "#7",
    label: "logs latency p95 < 500ms",
  },
  { file: "09-rollback.spec.ts", dod: "#8", label: "rollback < 10s" },
  {
    file: "10-rootless-audit.spec.ts",
    dod: "#9",
    label: "builds rootless",
  },
  {
    file: "11-cleanup.spec.ts",
    dod: "#10",
    label: "cleanup workspace + registry GC",
  },
]

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

interface SpecResult {
  spec: SpecDef
  passed: boolean
  skipped: boolean
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number
  measurements: string
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): {
  onlyNums: Set<string> | null
  skipNums: Set<string>
  dryRun: boolean
  noPrereqCheck: boolean
} {
  const args = process.argv.slice(2)
  let onlyNums: Set<string> | null = null
  const skipNums = new Set<string>()
  let dryRun = false
  let noPrereqCheck = false

  for (const arg of args) {
    if (arg.startsWith("--only=")) {
      onlyNums = new Set(
        arg
          .slice("--only=".length)
          .split(",")
          .map((s) => s.trim()),
      )
    } else if (arg.startsWith("--skip=")) {
      for (const n of arg
        .slice("--skip=".length)
        .split(",")
        .map((s) => s.trim())) {
        skipNums.add(n)
      }
    } else if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--no-prereq-check") {
      noPrereqCheck = true
    } else {
      console.error(`Unknown option: ${arg}`)
      process.exit(1)
    }
  }

  return { onlyNums, skipNums, dryRun, noPrereqCheck }
}

// ---------------------------------------------------------------------------
// Pre-requisite checks
// ---------------------------------------------------------------------------

function checkPrereqs(): void {
  const failures: string[] = []

  // PLOYDOK_E2E_REAL must be set
  if (!process.env["PLOYDOK_E2E_REAL"]) {
    failures.push(
      "PLOYDOK_E2E_REAL is not set.\n  Fix: export PLOYDOK_E2E_REAL=1",
    )
  }

  // Auth creds required by specs via loginViaApi. Defaults hit the dev seed
  // (`bun --cwd packages/db run seed`) so `make dod` works without exports.
  // Override with env vars when targeting a non-seed account.
  process.env["E2E_TEST_EMAIL"] ??= "dev@ploydok.local"
  process.env["E2E_TEST_BACKUP_CODE"] ??= "DEVD-EVDE-VDEV"

  // API health
  const apiCheck = spawnSync(
    "curl",
    ["-sf", "http://localhost:3335/health"],
    { encoding: "utf8" },
  )
  if (apiCheck.status !== 0) {
    failures.push(
      "API not running — did you `make dev`?\n  Fix: make dev (in another shell)",
    )
  }

  // Caddy
  const caddyCheck = spawnSync(
    "curl",
    ["-sf", "--max-time", "3", "http://localhost:8181/"],
    { encoding: "utf8" },
  )
  // Caddy may return non-2xx but we only care about connection, so check
  // for non-CURL-error (exit codes 6, 7, 28 = network errors)
  const caddyConnFailed = [6, 7, 28].includes(caddyCheck.status ?? -1)
  if (caddyConnFailed) {
    failures.push(
      "Caddy not running — did you `make infra-up`?\n  Fix: make infra-up",
    )
  }

  // Agent socket
  if (!existsSync("/tmp/ploydok/agent.sock")) {
    failures.push(
      "Agent not running — did you `make dev-agent`?\n  Fix: make dev-agent (in another shell)",
    )
  }

  if (failures.length > 0) {
    console.error("\nPre-requisite checks failed:\n")
    for (const f of failures) {
      console.error(`  ✗ ${f}\n`)
    }
    process.exit(1)
  }

  console.log("Pre-requisite checks passed.\n")
}

// ---------------------------------------------------------------------------
// Measurement extraction
// Lines emitted by specs: DoD #N key=value key=value ...
// e.g. "DoD #4 cache — t1=120.3s t2=44.1s ratio=0.37"
// ---------------------------------------------------------------------------

function extractMeasurements(stdout: string, dod: string): string {
  const needle = `DoD ${dod}`
  const lines = stdout.split("\n")
  const matching = lines.filter((l) => l.includes(needle))
  if (matching.length === 0) return "—"
  // Return the last matching line, trimmed
  return matching[matching.length - 1]!.trim()
}

// ---------------------------------------------------------------------------
// Run a single spec
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..")
const WEB_DIR = join(REPO_ROOT, "apps/web")
const E2E_DIR = join(WEB_DIR, "e2e/dod")

async function runSpec(spec: SpecDef): Promise<SpecResult> {
  const specPath = join(E2E_DIR, spec.file)

  // If the spec file doesn't exist yet, mark as skipped
  if (!existsSync(specPath)) {
    return {
      spec,
      passed: false,
      skipped: true,
      durationMs: 0,
      stdout: "(spec file not found)",
      stderr: "",
      exitCode: -1,
      measurements: "—",
    }
  }

  const start = performance.now()

  const proc = Bun.spawn(
    [
      "bunx",
      "playwright",
      "test",
      `e2e/dod/${spec.file}`,
      "--reporter=list",
    ],
    {
      cwd: WEB_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    },
  )

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  const exitCode = await proc.exited
  const durationMs = performance.now() - start

  const passed = exitCode === 0
  const measurements = extractMeasurements(stdoutBuf, spec.dod)

  return {
    spec,
    passed,
    skipped: false,
    durationMs,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
    measurements,
  }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  if (ms === 0) return "—"
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const m = Math.floor(totalSec / 60)
  const s = (totalSec % 60).toFixed(0).padStart(2, "0")
  return `${m}m ${s}s`
}

function statusIcon(r: SpecResult): string {
  if (r.skipped) return "⊘"
  return r.passed ? "✓" : "✗"
}

function stdoutTail(stdout: string, lines = 20): string {
  const all = stdout.split("\n")
  return all.slice(-lines).join("\n")
}

// ---------------------------------------------------------------------------
// Collect environment info
// ---------------------------------------------------------------------------

function collectEnv(): Record<string, string> {
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" })
    return (r.stdout ?? "").trim()
  }

  return {
    date: new Date().toISOString(),
    host: `${os.hostname()} (${os.platform()} ${os.release()})`,
    bun: run("bun", ["--version"]),
    playwright: run("bunx", ["playwright", "--version"]),
    docker: run("docker", ["--version"]),
    gitSha: run("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]),
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildReport(results: SpecResult[], env: Record<string, string>): string {
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.skipped && !r.passed).length
  const skipped = results.filter((r) => r.skipped).length
  const totalMs = results.reduce((acc, r) => acc + r.durationMs, 0)

  const lines: string[] = []

  lines.push("# Sprint 3 — Definition of Done")
  lines.push("")
  lines.push(
    `> Auto-générée par \`bun scripts/run-dod.ts\`. Dernière mise à jour : ${env["date"]}.`,
  )
  lines.push("")

  // Summary table
  lines.push("## Résumé")
  lines.push("")
  lines.push("| Statut | Compte |")
  lines.push("|---|---|")
  lines.push(`| ✓ Passé | ${passed} / 11 |`)
  lines.push(`| ✗ Échoué | ${failed} / 11 |`)
  lines.push(`| ⊘ Skippé | ${skipped} / 11 |`)
  lines.push(`| Durée totale | ${fmtDuration(totalMs)} |`)
  lines.push("")

  // Items table
  lines.push("## Items DoD")
  lines.push("")
  lines.push("| # | DoD | Spec | Durée | Statut | Mesure |")
  lines.push("|---|---|---|---|---|---|")

  for (const r of results) {
    const dur = fmtDuration(r.durationMs)
    const icon = statusIcon(r)
    const meas = r.measurements || "—"
    lines.push(
      `| ${r.spec.dod} | ${r.spec.label} | ${r.spec.file} | ${dur} | ${icon} | ${meas} |`,
    )
  }

  lines.push("")

  // Detail per item
  lines.push("## Détails par item")
  lines.push("")

  for (const r of results) {
    lines.push(`### DoD ${r.spec.dod} — ${r.spec.label}`)
    lines.push("")
    lines.push(`- Spec : \`apps/web/e2e/dod/${r.spec.file}\``)
    lines.push(`- Statut : ${statusIcon(r)}`)
    lines.push(`- Durée : ${fmtDuration(r.durationMs)}`)
    if (r.measurements !== "—") {
      lines.push(`- Mesure : ${r.measurements}`)
    }
    if (!r.skipped) {
      lines.push("- Stdout (tail) :")
      lines.push("  ```")
      const tail = stdoutTail(r.stdout + (r.stderr ? "\n--- stderr ---\n" + r.stderr : ""))
      for (const l of tail.split("\n")) {
        lines.push(`  ${l}`)
      }
      lines.push("  ```")
    }
    lines.push("")
  }

  // Environment
  lines.push("## Environnement du run")
  lines.push("")
  lines.push(`- Date : ${env["date"]}`)
  lines.push(`- Host : ${env["host"]}`)
  lines.push(`- Bun : ${env["bun"]}`)
  lines.push(`- Playwright : ${env["playwright"]}`)
  lines.push(`- Docker : ${env["docker"]}`)
  lines.push(`- Git SHA : ${env["gitSha"]}`)
  lines.push("")

  // Reproduce
  lines.push("## Commandes pour reproduire")
  lines.push("")
  lines.push("```bash")
  lines.push("make infra-up")
  lines.push("make dev-agent")
  lines.push("make dev")
  lines.push("bun scripts/seed-github-token.ts <userId> <PAT>")
  lines.push("PLOYDOK_E2E_REAL=1 bun scripts/run-dod.ts")
  lines.push("```")

  return lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Initial (placeholder) report — written before any run
// ---------------------------------------------------------------------------

function buildInitialReport(): string {
  const lines: string[] = []

  lines.push("# Sprint 3 — Definition of Done")
  lines.push("")
  lines.push(
    "> Auto-générée par `bun scripts/run-dod.ts`. En attente du premier run.",
  )
  lines.push("")
  lines.push("## Résumé")
  lines.push("")
  lines.push("En attente du premier run. Lance `bun scripts/run-dod.ts`.")
  lines.push("")
  lines.push("## Items DoD")
  lines.push("")
  lines.push("| # | DoD | Spec | Durée | Statut | Mesure |")
  lines.push("|---|---|---|---|---|---|")

  for (const spec of SPECS) {
    lines.push(
      `| ${spec.dod} | ${spec.label} | ${spec.file} | — | ⊘ non exécuté | — |`,
    )
  }

  lines.push("")
  lines.push("## Commandes pour reproduire")
  lines.push("")
  lines.push("```bash")
  lines.push("make infra-up")
  lines.push("make dev-agent")
  lines.push("make dev")
  lines.push("bun scripts/seed-github-token.ts <userId> <PAT>")
  lines.push("PLOYDOK_E2E_REAL=1 bun scripts/run-dod.ts")
  lines.push("```")

  return lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { onlyNums, skipNums, dryRun, noPrereqCheck } = parseArgs()

  // Filter specs
  const activeSpecs = SPECS.filter((s) => {
    const num = s.dod.replace("#", "")
    if (onlyNums !== null && !onlyNums.has(num)) return false
    if (skipNums.has(num)) return false
    return true
  })

  if (dryRun) {
    console.log("Sprint 3 DoD — dry run\n")
    console.log(`${"#".padEnd(4)} ${"DoD".padEnd(6)} ${"Spec".padEnd(36)} Label`)
    console.log("-".repeat(80))
    for (const [i, s] of activeSpecs.entries()) {
      console.log(
        `${String(i + 1).padEnd(4)} ${s.dod.padEnd(6)} ${s.file.padEnd(36)} ${s.label}`,
      )
    }
    console.log(`\n${activeSpecs.length} spec(s) would run.`)
    process.exit(0)
  }

  if (!noPrereqCheck) {
    checkPrereqs()
  }

  const results: SpecResult[] = []
  const total = activeSpecs.length

  console.log(`Sprint 3 DoD — running ${total} spec(s)\n`)

  for (const [i, spec] of activeSpecs.entries()) {
    process.stdout.write(
      `[${i + 1}/${total}] ${spec.dod} ${spec.label} ... `,
    )

    const result = await runSpec(spec)
    results.push(result)

    const icon = statusIcon(result)
    const dur = fmtDuration(result.durationMs)
    console.log(`${icon} (${dur})`)

    if (!result.passed && !result.skipped) {
      // Print tail on failure so CI sees it immediately
      const tail = stdoutTail(result.stdout, 10)
      if (tail.trim()) {
        console.log(tail)
      }
      if (result.stderr.trim()) {
        console.log(result.stderr.slice(-800))
      }
    }
  }

  // Specs that were filtered out become skipped entries in the report
  const skippedSpecs = SPECS.filter(
    (s) => !activeSpecs.some((a) => a.file === s.file),
  )
  const skippedResults: SpecResult[] = skippedSpecs.map((spec) => ({
    spec,
    passed: false,
    skipped: true,
    durationMs: 0,
    stdout: "",
    stderr: "",
    exitCode: -1,
    measurements: "—",
  }))

  // Merge: preserve SPECS order
  const allResults: SpecResult[] = SPECS.map((s) => {
    return (
      results.find((r) => r.spec.file === s.file) ??
      skippedResults.find((r) => r.spec.file === s.file)!
    )
  })

  const env = collectEnv()
  const report = buildReport(allResults, env)

  const reportDir = join(REPO_ROOT, ".ai/reports")
  mkdirSync(reportDir, { recursive: true })
  const reportPath = join(reportDir, "sprint-3-DoD.md")
  await Bun.write(reportPath, report)

  const passedCount = allResults.filter((r) => r.passed).length
  const totalMs = allResults.reduce((acc, r) => acc + r.durationMs, 0)
  const allPassed = allResults.every((r) => r.passed || r.skipped)

  console.log(
    `\nSprint 3 DoD — ${passedCount}/${total} passed ${passedCount === total ? "✓" : "✗"}`,
  )
  console.log(`total: ${fmtDuration(totalMs)}`)
  console.log(`report: ${reportPath}`)

  process.exit(allPassed ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error("Fatal:", err)
  process.exit(1)
})
