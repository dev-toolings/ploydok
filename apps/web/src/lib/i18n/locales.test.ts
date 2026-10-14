// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "bun:test"
import { loadLocaleModules } from "./load-resources"

function keyPaths(obj: unknown, prefix = ""): Array<string> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return Object.entries(obj as Record<string, unknown>)
      .flatMap(([key, value]) =>
        keyPaths(value, prefix ? `${prefix}.${key}` : key)
      )
      .sort()
  }
  return [prefix]
}

function interpolationTokens(value: string): Array<string> {
  return [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
    .map((match) => match[1].trim())
    .sort()
}

function interpolationMap(
  obj: unknown,
  prefix = ""
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>()
  if (typeof obj === "string") {
    out.set(prefix, interpolationTokens(obj))
    return out
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(
      obj as Record<string, unknown>
    )) {
      for (const [path, tokens] of interpolationMap(
        value,
        prefix ? `${prefix}.${key}` : key
      )) {
        out.set(path, tokens)
      }
    }
  }
  return out
}

function emptyLeaves(obj: unknown, prefix = ""): Array<string> {
  if (typeof obj === "string") {
    return obj.trim() === "" ? [prefix] : []
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return Object.entries(obj as Record<string, unknown>).flatMap(
      ([key, value]) => emptyLeaves(value, prefix ? `${prefix}.${key}` : key)
    )
  }
  return [`${prefix} (non-string leaf)`]
}

describe("locale parity", () => {
  const en = loadLocaleModules("en")
  const fr = loadLocaleModules("fr")

  test("both locales ship the same namespaces", () => {
    expect([...en.keys()].sort()).toEqual([...fr.keys()].sort())
  })

  test.each([...en.keys()].sort())(
    "%s has identical fr/en key sets",
    (file) => {
      expect(keyPaths(en.get(file))).toEqual(keyPaths(fr.get(file)))
    }
  )

  test.each([...en.keys()].sort())(
    "%s interpolations match between locales",
    (file) => {
      const enMap = interpolationMap(en.get(file))
      const frMap = interpolationMap(fr.get(file))
      expect([...enMap.keys()].sort()).toEqual([...frMap.keys()].sort())
      for (const key of enMap.keys()) {
        expect(frMap.get(key)).toEqual(enMap.get(key))
      }
    }
  )

  test.each([...en.keys()].sort())("%s has no empty string values", (file) => {
    expect(emptyLeaves(en.get(file))).toEqual([])
    expect(emptyLeaves(fr.get(file))).toEqual([])
  })
})
