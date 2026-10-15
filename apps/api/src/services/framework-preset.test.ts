// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "bun:test"
import { frameworkPresetCreateFields } from "./framework-preset"

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

  it("preserves explicit commands, empty strings, ports, and healthcheck values", () => {
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
      install_command: "",
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
})
