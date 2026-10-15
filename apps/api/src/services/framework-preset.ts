// SPDX-License-Identifier: AGPL-3.0-only
import { getFrameworkPreset } from "@ploydok/shared"
import type { BuildMethod, HealthcheckConfig } from "@ploydok/shared"
import type { apps } from "@ploydok/db"

interface PresetCreationInput {
  frameworkPreset?: string | null | undefined
  installCommand?: string | undefined
  buildCommand?: string | undefined
  startCommand?: string | undefined
  buildMethod?: BuildMethod | undefined
  staticOutputDir?: string | undefined
  runtimePort?: number | undefined
  healthcheck?: { [K in keyof HealthcheckConfig]?: HealthcheckConfig[K] | undefined } | undefined
}

type PresetCreationFields = Pick<typeof apps.$inferInsert,
  | "framework_preset" | "install_command" | "build_command" | "start_command"
  | "build_method" | "static_output_dir" | "runtime_port"
  | "healthcheck_path" | "healthcheck_port" | "healthcheck_interval_s"
  | "healthcheck_timeout_s" | "healthcheck_retries" | "healthcheck_start_period_s"
>

/** Snapshot defaults at creation so later detection never rewrites a user choice. */
export function frameworkPresetCreateFields(input: PresetCreationInput): PresetCreationFields {
  const defaults = getFrameworkPreset(input.frameworkPreset)?.defaults
  const port = input.runtimePort ?? defaults?.port ?? null
  const hc = input.healthcheck ?? {}
  return {
    framework_preset: input.frameworkPreset ?? null,
    install_command: input.installCommand ?? defaults?.installCommand ?? null,
    build_command: input.buildCommand ?? defaults?.buildCommand ?? null,
    start_command: input.startCommand ?? defaults?.startCommand ?? null,
    build_method: input.buildMethod === "docker"
      ? "dockerfile"
      : input.buildMethod ?? defaults?.buildMethod ?? "auto",
    static_output_dir: input.staticOutputDir ?? defaults?.outputDirectory ?? "dist",
    runtime_port: port,
    healthcheck_path: hc.path ?? defaults?.healthcheck.path ?? "/",
    healthcheck_port: hc.port ?? input.runtimePort ?? defaults?.healthcheck.port ?? port,
    healthcheck_interval_s: hc.intervalS ?? defaults?.healthcheck.intervalS ?? 5,
    healthcheck_timeout_s: hc.timeoutS ?? defaults?.healthcheck.timeoutS ?? 3,
    healthcheck_retries: hc.retries ?? defaults?.healthcheck.retries ?? 6,
    healthcheck_start_period_s: hc.startPeriodS ?? defaults?.healthcheck.startPeriodS ?? 0,
  }
}
