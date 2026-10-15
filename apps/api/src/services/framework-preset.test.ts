// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "bun:test"
import {
  frameworkPresetCreateFields,
  frameworkPresetPatchFields,
  resolveFrameworkPresetConfig,
} from "./framework-preset"

describe("frameworkPresetCreateFields", () => {
  it("materializes registry defaults for a selected preset", () => {
    expect(
      frameworkPresetCreateFields({ frameworkPreset: "next" })
    ).toEqual({
      framework_preset: "next",
      install_command: null,
      build_command: "./node_modules/.bin/next build",
      start_command: "./node_modules/.bin/next start -H 0.0.0.0 -p $PORT",
      build_method: "nixpacks",
      static_output_dir: ".next",
      runtime_port: 3000,
      healthcheck_path: "/",
      healthcheck_port: 3000,
      healthcheck_interval_s: 5,
      healthcheck_timeout_s: 3,
      healthcheck_retries: 6,
      healthcheck_start_period_s: 30,
    })
  })

  it("preserves explicit commands, normalizes blank commands, and keeps ports and healthcheck values", () => {
    expect(
      frameworkPresetCreateFields({
        frameworkPreset: "next",
        installCommand: "",
        buildCommand: "bun run build",
        startCommand: "./server --port $PORT",
        buildMethod: "nixpacks",
        staticOutputDir: "out",
        runtimePort: 8088,
        healthcheck: {
          path: "/ready",
          port: 9090,
          intervalS: 11,
          timeoutS: 7,
          retries: 2,
          startPeriodS: 45,
        },
      })
    ).toEqual({
      framework_preset: "next",
      install_command: null,
      build_command: "bun run build",
      start_command: "./server --port $PORT",
      build_method: "nixpacks",
      static_output_dir: "out",
      runtime_port: 8088,
      healthcheck_path: "/ready",
      healthcheck_port: 9090,
      healthcheck_interval_s: 11,
      healthcheck_timeout_s: 7,
      healthcheck_retries: 2,
      healthcheck_start_period_s: 45,
    })

    expect(
      frameworkPresetCreateFields({
        frameworkPreset: "next",
        runtimePort: 8088,
      })
    ).toMatchObject({
      runtime_port: 8088,
      healthcheck_port: 8088,
    })
  })

  it("keeps an unselected preset free to use ordinary app defaults", () => {
    expect(
      frameworkPresetCreateFields({
        buildMethod: "static",
        runtimePort: 8080,
        healthcheck: { path: "/health" },
      })
    ).toMatchObject({
      framework_preset: null,
      build_method: "static",
      static_output_dir: "dist",
      runtime_port: 8080,
      healthcheck_path: "/health",
      healthcheck_port: 8080,
    })
  })

  it("switches presets by resnapshotting inherited fields while preserving custom values", () => {
    const current = frameworkPresetCreateFields({ frameworkPreset: "next" })
    const patch = frameworkPresetPatchFields(
      {
        ...current,
        build_command: "custom build",
        runtime_port: 8088,
      },
      {
        frameworkPreset: "rails",
        // A blank command is persisted as null. Runtime resolution handles
        // inheritance from the selected preset later.
        startCommand: "",
        healthcheck: { port: null },
      }
    )

    expect(patch).toMatchObject({
      framework_preset: "rails",
      build_command: "custom build",
      runtime_port: 8088,
      start_command: null,
      healthcheck_port: null,
      static_output_dir: "public",
      build_method: "nixpacks",
    })
  })

  it("resolves blank and null legacy values from the selected preset", () => {
    expect(
      resolveFrameworkPresetConfig({
        framework_preset: "next",
        install_command: "",
        build_command: null,
        start_command: " ",
        build_method: null,
        static_output_dir: null,
        runtime_port: null,
        healthcheck_path: null,
        healthcheck_port: null,
        healthcheck_interval_s: null,
        healthcheck_timeout_s: null,
        healthcheck_retries: null,
        healthcheck_start_period_s: null,
      })
    ).toMatchObject({
      install_command: null,
      build_command: "./node_modules/.bin/next build",
      start_command: "./node_modules/.bin/next start -H 0.0.0.0 -p $PORT",
      build_method: "nixpacks",
      static_output_dir: ".next",
      runtime_port: 3000,
      healthcheck_port: 3000,
      healthcheck_start_period_s: 30,
    })
  })

  it("persists an explicit preset clear and null command clears", () => {
    const current = frameworkPresetCreateFields({ frameworkPreset: "next" })
    expect(
      frameworkPresetPatchFields(current, {
        frameworkPreset: null,
        installCommand: null,
        buildCommand: null,
        startCommand: null,
      })
    ).toMatchObject({
      framework_preset: null,
      install_command: null,
      build_command: null,
      start_command: null,
      build_method: "auto",
      static_output_dir: "dist",
      runtime_port: null,
    })
  })

  it("resolves an auto build method from the selected preset", () => {
    const current = frameworkPresetCreateFields({ frameworkPreset: "next" })
    expect(
      resolveFrameworkPresetConfig({ ...current, build_method: "auto" })
        .build_method
    ).toBe("nixpacks")
    expect(
      resolveFrameworkPresetConfig({
        ...current,
        runtime_port: 8088,
        healthcheck_port: null,
      }).healthcheck_port
    ).toBe(8088)
  })
})
