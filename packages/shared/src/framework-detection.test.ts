// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "bun:test"
import {
  FRAMEWORK_PRESETS,
  classifyStack,
  classifyStackWithManifests,
  classificationForPreset,
  listFrameworkPresets,
  type StackClassification,
} from "./index"

function expectExplainable(
  classification: StackClassification,
  expected: {
    stack: StackClassification["stack"]
    framework: string
    presetId: string
    signals: string[]
    confidence?: StackClassification["confidence"]
  }
) {
  expect(classification.stack).toBe(expected.stack)
  expect(classification.framework).toBe(expected.framework)
  expect(classification.presetId).toBe(expected.presetId)
  expect(classification.confidence).toBe(expected.confidence ?? "high")
  expect(classification.signals).toEqual(expected.signals)
  expect(classification.evidence).toEqual(expected.signals)
  expect(classification.preset?.id).toBe(expected.presetId)
}

describe("framework detection fixtures", () => {
  it("explains a Next.js fixture from its config probes", () => {
    const result = classifyStack({
      "package.json": true,
      "next.config.ts": true,
    })

    expectExplainable(result, {
      stack: "next",
      framework: "Next.js",
      presetId: "next",
      signals: ["package.json", "next.config.ts"],
    })
  })

  it("explains a Nuxt fixture from its config probes", () => {
    const result = classifyStack({
      "package.json": true,
      "nuxt.config.ts": true,
    })

    expectExplainable(result, {
      stack: "nuxt",
      framework: "Nuxt",
      presetId: "nuxt",
      signals: ["package.json", "nuxt.config.ts"],
    })
  })

  it("keeps a Nuxt dependency specific when the repository uses Bun", () => {
    const result = classifyStackWithManifests(
      { "package.json": true, "bun.lock": true },
      {
        "package.json": JSON.stringify({
          dependencies: { nuxt: "^3.0.0" },
        }),
      }
    )

    expectExplainable(result, {
      stack: "nuxt",
      framework: "Nuxt",
      presetId: "nuxt",
      signals: ["package.json"],
    })
  })

  it("explains a SvelteKit fixture from its config probes", () => {
    const result = classifyStack({
      "package.json": true,
      "svelte.config.js": true,
    })

    expectExplainable(result, {
      stack: "sveltekit",
      framework: "SvelteKit",
      presetId: "sveltekit",
      signals: ["package.json", "svelte.config.js"],
    })
  })

  it("explains Laravel and Symfony fixtures from Composer manifests", () => {
    const laravel = classifyStackWithManifests(
      { "composer.json": true, artisan: true },
      {
        "composer.json": JSON.stringify({
          require: { "laravel/framework": "^12.0" },
        }),
      }
    )
    expectExplainable(laravel, {
      stack: "laravel",
      framework: "Laravel",
      presetId: "laravel",
      signals: ["composer.json", "artisan"],
    })

    const symfony = classifyStackWithManifests(
      { "composer.json": true },
      {
        "composer.json": JSON.stringify({
          require: { "symfony/framework-bundle": "^7.0" },
        }),
      }
    )
    expectExplainable(symfony, {
      stack: "symfony",
      framework: "Symfony",
      presetId: "symfony",
      signals: ["composer.json"],
    })
  })

  it("explains Django, Rails, and Phoenix fixtures from runtime manifests", () => {
    const django = classifyStack({
      "manage.py": true,
      "requirements.txt": true,
    })
    expectExplainable(django, {
      stack: "django",
      framework: "Django",
      presetId: "django",
      signals: ["manage.py", "requirements.txt"],
    })

    const rails = classifyStackWithManifests(
      { Gemfile: true },
      { Gemfile: "gem 'rails', '~> 8.0'" }
    )
    expectExplainable(rails, {
      stack: "ruby",
      framework: "Rails",
      presetId: "rails",
      signals: ["Gemfile"],
    })

    const phoenix = classifyStackWithManifests(
      { "mix.exs": true },
      { "mix.exs": "{:phoenix, \"~> 1.7\"}" }
    )
    expectExplainable(phoenix, {
      stack: "elixir",
      framework: "Phoenix",
      presetId: "phoenix",
      signals: ["mix.exs"],
    })
  })

  it("explains a generic Dockerfile fixture and preserves its precedence", () => {
    const result = classifyStack({
      Dockerfile: true,
      "package.json": true,
      "next.config.mjs": true,
    })

    expectExplainable(result, {
      stack: "unknown",
      framework: "Dockerfile",
      presetId: "dockerfile",
      signals: ["Dockerfile"],
    })
    expect(result.recommendedBuild).toBe("dockerfile")
  })
})

describe("framework preset registry", () => {
  it("gives every preset the complete build and runtime surface", () => {
    const presets = listFrameworkPresets()
    expect(presets).toHaveLength(Object.keys(FRAMEWORK_PRESETS).length)

    for (const preset of presets) {
      expect(preset.id).toBeTruthy()
      expect(preset.label).toBeTruthy()
      for (const key of [
        "installCommand",
        "buildCommand",
        "startCommand",
        "outputDirectory",
        "port",
        "healthcheck",
        "buildMethod",
      ])
        expect(Object.hasOwn(preset.defaults, key)).toBe(true)
      expect(typeof preset.defaults.buildMethod).toBe("string")
      expect(preset.defaults.healthcheck).toEqual(
        expect.objectContaining({
          path: expect.any(String),
          intervalS: expect.any(Number),
          timeoutS: expect.any(Number),
          retries: expect.any(Number),
          startPeriodS: expect.any(Number),
        })
      )
      for (const key of ["port"])
        expect(Object.hasOwn(preset.defaults.healthcheck, key)).toBe(true)
    }
  })

  it("keeps a saved preset when fresh repository evidence changes", () => {
    const detected = classifyStack({
      "package.json": true,
      "next.config.mjs": true,
    })
    const selected = classificationForPreset("laravel", detected)

    expect(selected.framework).toBe("Laravel")
    expect(selected.stack).toBe("laravel")
    expect(selected.presetId).toBe("laravel")
    expect(selected.recommendedBuild).toBe("nixpacks")
    expect(selected.preset?.id).toBe("laravel")
    expect(selected.evidence).toEqual(["package.json", "next.config.mjs"])
    expect(selected.suggestedEnvVars).toEqual({
      SESSION_DRIVER: "file",
      CACHE_STORE: "file",
    })
  })
})
