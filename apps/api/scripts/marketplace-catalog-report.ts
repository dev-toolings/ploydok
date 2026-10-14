// SPDX-License-Identifier: AGPL-3.0-only
//
// Measures how many marketplace templates pass the install-time validation
// (DSL resolution + runtime selection + compose planning) without touching a
// database or the agent. Downloads are cached so before/after runs compare the
// same catalog snapshot.
//
//   bun run apps/api/scripts/marketplace-catalog-report.ts [--refresh] [--json out.json]

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { prepareTemplateInstall } from "../src/marketplace/template-toml.js"

const BASE_URL = (
  process.env.PLOYDOK_MARKETPLACE_BASE_URL ?? "https://templates.dokploy.com"
).replace(/\/+$/, "")
const CACHE_DIR = path.join(homedir(), ".cache", "ploydok-marketplace")
const CONCURRENCY = 16

const args = process.argv.slice(2)
const refresh = args.includes("--refresh")
const jsonIndex = args.indexOf("--json")
const jsonOut = jsonIndex === -1 ? null : args[jsonIndex + 1]

async function cached(rel: string, url: string): Promise<string | null> {
  const file = path.join(CACHE_DIR, rel)
  if (!refresh) {
    try {
      return await readFile(file, "utf8")
    } catch {
      // not cached yet
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  const text = await res.text()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  return text
}

function validate(id: string, compose: string, templateToml?: string): void {
  prepareTemplateInstall({
    compose,
    ...(templateToml !== undefined ? { templateToml } : {}),
    projectSlug: id,
    serviceId: id,
  })
}

function reasonKey(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\$\{[^}]*\}/g, "${…}")
    .slice(0, 90)
}

const meta = JSON.parse(
  (await cached("meta.json", `${BASE_URL}/meta.json`)) ?? "[]"
) as Array<{ id: string }>

const results: Array<{ id: string; ok: boolean; error?: string }> = []
let cursor = 0
async function worker(): Promise<void> {
  while (cursor < meta.length) {
    const { id } = meta[cursor++]!
    try {
      const compose = await cached(
        `${id}/docker-compose.yml`,
        `${BASE_URL}/blueprints/${id}/docker-compose.yml`
      )
      const templateToml = await cached(
        `${id}/template.toml`,
        `${BASE_URL}/blueprints/${id}/template.toml`
      )
      if (!compose) throw new Error("docker-compose.yml missing upstream")
      validate(id, compose, templateToml ?? undefined)
      results.push({ id, ok: true })
    } catch (err) {
      results.push({ id, ok: false, error: (err as Error).message })
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
results.sort((a, b) => a.id.localeCompare(b.id))

const ok = results.filter((r) => r.ok).length
const reasons = new Map<string, number>()
for (const r of results) {
  if (r.ok) continue
  const key = reasonKey(r.error ?? "")
  reasons.set(key, (reasons.get(key) ?? 0) + 1)
}

console.log(`installable: ${ok}/${results.length}`)
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(4)}  ${reason}`)
}
if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify(results, null, 2))
}
