// SPDX-License-Identifier: AGPL-3.0-only
import {
  CommandSchema,
  FrameworkPresetIdSchema,
  getFrameworkPreset,
  normalizeBuildMethod,
} from "@ploydok/shared"
import type {
  BuildMethod,
  FrameworkPresetId,
} from "@ploydok/shared"
import type { apps } from "@ploydok/db"

type HealthcheckInput = {
  path?: string | null | undefined
  port?: number | null | undefined
  intervalS?: number | null | undefined
  timeoutS?: number | null | undefined
  retries?: number | null | undefined
  startPeriodS?: number | null | undefined
}
export interface PresetInput {
  frameworkPreset?: FrameworkPresetId | string | null | undefined
  installCommand?: string | null | undefined
  buildCommand?: string | null | undefined
  startCommand?: string | null | undefined
  buildMethod?: BuildMethod | undefined
  staticOutputDir?: string | undefined
  runtimePort?: number | null | undefined
  healthcheck?: HealthcheckInput | undefined
}

export type PresetCreationFields = Pick<
  typeof apps.$inferInsert,
  | "framework_preset"
  | "install_command"
  | "build_command"
  | "start_command"
  | "build_method"
  | "static_output_dir"
  | "runtime_port"
  | "healthcheck_path"
  | "healthcheck_port"
  | "healthcheck_interval_s"
  | "healthcheck_timeout_s"
  | "healthcheck_retries"
  | "healthcheck_start_period_s"
>

export interface PresetStoredFields {
  framework_preset?: string | null | undefined
  install_command?: string | null | undefined
  build_command?: string | null | undefined
  start_command?: string | null | undefined
  build_method?: string | null | undefined
  static_output_dir?: string | null | undefined
  runtime_port?: number | null | undefined
  healthcheck_path?: string | null | undefined
  healthcheck_port?: number | null | undefined
  healthcheck_interval_s?: number | null | undefined
  healthcheck_timeout_s?: number | null | undefined
  healthcheck_retries?: number | null | undefined
  healthcheck_start_period_s?: number | null | undefined
}

function presetIdOrThrow(
  value: string | FrameworkPresetId | null | undefined
): FrameworkPresetId | null {
  if (value === null || value === undefined) return null
  const parsed = FrameworkPresetIdSchema.safeParse(value)
  if (!parsed.success) throw new Error("Invalid framework preset")
  return parsed.data
}

function normalizeCommand(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null
  const parsed = CommandSchema.parse(value)
  return parsed === null || parsed.trim().length === 0 ? null : parsed
}

function valueOrDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

/**
 * Materialize the values written for a new app. Undefined means that the
 * caller did not provide a value and should inherit the selected preset.
 * Null is deliberate and means inherit at runtime, which lets an explicit
 * blank command remain distinguishable from a registry default.
 */
export function frameworkPresetCreateFields(
  input: PresetInput
): PresetCreationFields {
  const frameworkPreset = presetIdOrThrow(input.frameworkPreset)
  const defaults = getFrameworkPreset(frameworkPreset)?.defaults
  const defaultPort = defaults?.port ?? null
  const runtimePort = valueOrDefault(input.runtimePort, defaultPort)
  const healthcheck = input.healthcheck ?? {}
  const healthcheckDefaults = defaults?.healthcheck
  const healthcheckPortFallback =
    input.runtimePort !== undefined
      ? input.runtimePort
      : healthcheckDefaults?.port ?? runtimePort ?? null

  return {
    framework_preset: frameworkPreset,
    install_command:
      input.installCommand === undefined
        ? defaults?.installCommand ?? null
        : normalizeCommand(input.installCommand),
    build_command:
      input.buildCommand === undefined
        ? defaults?.buildCommand ?? null
        : normalizeCommand(input.buildCommand),
    start_command:
      input.startCommand === undefined
        ? defaults?.startCommand ?? null
        : normalizeCommand(input.startCommand),
    build_method:
      input.buildMethod === undefined
        ? defaults?.buildMethod ?? "auto"
        : normalizeBuildMethod(input.buildMethod),
    static_output_dir:
      input.staticOutputDir === undefined
        ? defaults?.outputDirectory ?? "dist"
        : input.staticOutputDir,
    runtime_port: runtimePort,
    healthcheck_path: valueOrDefault(
      healthcheck.path,
      healthcheckDefaults?.path ?? "/"
    ),
    healthcheck_port: valueOrDefault(
      healthcheck.port,
      healthcheckPortFallback
    ),
    healthcheck_interval_s: valueOrDefault(
      healthcheck.intervalS,
      healthcheckDefaults?.intervalS ?? 5
    ),
    healthcheck_timeout_s: valueOrDefault(
      healthcheck.timeoutS,
      healthcheckDefaults?.timeoutS ?? 3
    ),
    healthcheck_retries: valueOrDefault(
      healthcheck.retries,
      healthcheckDefaults?.retries ?? 6
    ),
    healthcheck_start_period_s: valueOrDefault(
      healthcheck.startPeriodS,
      healthcheckDefaults?.startPeriodS ?? 0
    ),
  }
}

const OVERRIDE_FIELDS = [
  "install_command",
  "build_command",
  "start_command",
  "build_method",
  "static_output_dir",
  "runtime_port",
  "healthcheck_path",
  "healthcheck_port",
  "healthcheck_interval_s",
  "healthcheck_timeout_s",
  "healthcheck_retries",
  "healthcheck_start_period_s",
] as const

type OverrideField = (typeof OVERRIDE_FIELDS)[number]

function storedDefaultFields(
  frameworkPreset: string | null | undefined
): PresetCreationFields | undefined {
  const parsed = FrameworkPresetIdSchema.safeParse(frameworkPreset)
  if (!parsed.success) return undefined
  return frameworkPresetCreateFields({ frameworkPreset: parsed.data })
}

function isInheritedValue(
  field: OverrideField,
  value: unknown,
  oldDefault: unknown
): boolean {
  if (value === null || value === undefined) return true
  if (
    (field === "install_command" ||
      field === "build_command" ||
      field === "start_command") &&
    typeof value === "string" &&
    value.trim().length === 0
  ) {
    return true
  }
  if (field === "build_method" && typeof value === "string") {
    return normalizeBuildMethod(value as BuildMethod) === oldDefault
  }
  return Object.is(value, oldDefault)
}

/**
 * Build a PATCH update for preset and build/runtime fields. When a preset is
 * changed, a saved value is replaced only if it still equals the old preset's
 * snapshot. Values that differ remain explicit user overrides.
 */
export function frameworkPresetPatchFields(
  current: PresetStoredFields,
  input: PresetInput
): Partial<PresetCreationFields> {
  const patch: Partial<PresetCreationFields> = {}
  const explicit = new Set<OverrideField>()

  if (input.installCommand !== undefined) {
    explicit.add("install_command")
    patch.install_command = normalizeCommand(input.installCommand)
  }
  if (input.buildCommand !== undefined) {
    explicit.add("build_command")
    patch.build_command = normalizeCommand(input.buildCommand)
  }
  if (input.startCommand !== undefined) {
    explicit.add("start_command")
    patch.start_command = normalizeCommand(input.startCommand)
  }
  if (input.buildMethod !== undefined) {
    explicit.add("build_method")
    patch.build_method = normalizeBuildMethod(input.buildMethod)
  }
  if (input.staticOutputDir !== undefined) {
    explicit.add("static_output_dir")
    patch.static_output_dir = input.staticOutputDir
  }
  if (input.runtimePort !== undefined) {
    explicit.add("runtime_port")
    patch.runtime_port = input.runtimePort

    // A healthcheck that followed the old runtime port should continue to
    // follow it when the port is edited without an explicit health port.
    if (
      input.frameworkPreset === undefined &&
      input.healthcheck?.port === undefined &&
      current.healthcheck_port !== undefined &&
      current.healthcheck_port === current.runtime_port
    ) {
      patch.healthcheck_port = input.runtimePort
    }
  }

  if (input.healthcheck !== undefined) {
    const healthcheck = input.healthcheck
    if (healthcheck.path !== undefined) {
      explicit.add("healthcheck_path")
      patch.healthcheck_path = healthcheck.path
    }
    if (healthcheck.port !== undefined) {
      explicit.add("healthcheck_port")
      patch.healthcheck_port = healthcheck.port
    }
    if (healthcheck.intervalS !== undefined) {
      explicit.add("healthcheck_interval_s")
      patch.healthcheck_interval_s = healthcheck.intervalS
    }
    if (healthcheck.timeoutS !== undefined) {
      explicit.add("healthcheck_timeout_s")
      patch.healthcheck_timeout_s = healthcheck.timeoutS
    }
    if (healthcheck.retries !== undefined) {
      explicit.add("healthcheck_retries")
      patch.healthcheck_retries = healthcheck.retries
    }
    if (healthcheck.startPeriodS !== undefined) {
      explicit.add("healthcheck_start_period_s")
      patch.healthcheck_start_period_s = healthcheck.startPeriodS
    }
  }

  if (input.frameworkPreset === undefined) return patch

  const nextPreset = presetIdOrThrow(input.frameworkPreset)
  patch.framework_preset = nextPreset

  const oldDefaults = storedDefaultFields(current.framework_preset)
  const presetHealthcheck = input.healthcheck
    ? {
        ...(input.healthcheck.path != null
          ? { path: input.healthcheck.path }
          : {}),
        ...(input.healthcheck.port != null
          ? { port: input.healthcheck.port }
          : {}),
        ...(input.healthcheck.intervalS != null
          ? { intervalS: input.healthcheck.intervalS }
          : {}),
        ...(input.healthcheck.timeoutS != null
          ? { timeoutS: input.healthcheck.timeoutS }
          : {}),
        ...(input.healthcheck.retries != null
          ? { retries: input.healthcheck.retries }
          : {}),
        ...(input.healthcheck.startPeriodS != null
          ? { startPeriodS: input.healthcheck.startPeriodS }
          : {}),
      }
    : undefined
  const nextDefaults = frameworkPresetCreateFields({
    frameworkPreset: nextPreset,
    ...(input.runtimePort !== undefined && input.runtimePort !== null
      ? { runtimePort: input.runtimePort }
      : {}),
    ...(presetHealthcheck !== undefined
      ? { healthcheck: presetHealthcheck }
      : {}),
  })

  for (const field of OVERRIDE_FIELDS) {
    if (explicit.has(field)) continue
    const oldDefault = oldDefaults?.[field]
    if (isInheritedValue(field, current[field], oldDefault)) {
      Object.assign(patch, { [field]: nextDefaults[field] })
    } else if (current[field] !== undefined) {
      // Keep an explicit value visible in the update contract. This makes the
      // preservation decision durable even when callers build a fresh row.
      Object.assign(patch, { [field]: current[field] })
    }
  }

  return patch
}

export interface ResolvedFrameworkPresetConfig {
  framework_preset: FrameworkPresetId | null
  install_command: string | null
  build_command: string | null
  start_command: string | null
  build_method: string
  static_output_dir: string
  runtime_port: number | null
  healthcheck_path: string
  healthcheck_port: number | null
  healthcheck_interval_s: number
  healthcheck_timeout_s: number
  healthcheck_retries: number
  healthcheck_start_period_s: number
}

/**
 * Resolve the effective app settings for workers. Null and blank commands are
 * inherited from the selected preset; explicit non-empty values win. This
 * keeps normal and preview workers on one contract, including legacy rows
 * written before preset defaults were snapshotted.
 */
export function resolveFrameworkPresetConfig(
  current: PresetStoredFields
): ResolvedFrameworkPresetConfig {
  const frameworkPreset = presetIdOrThrow(current.framework_preset)
  const defaults = getFrameworkPreset(frameworkPreset)?.defaults
  const runtimePort = current.runtime_port ?? defaults?.port ?? null
  const healthcheckPort =
    current.healthcheck_port ??
    (current.runtime_port !== null && current.runtime_port !== undefined
      ? current.runtime_port
      : defaults?.healthcheck.port ?? runtimePort ?? null)

  return {
    framework_preset: frameworkPreset,
    install_command:
      normalizeCommand(current.install_command) ??
      (defaults?.installCommand ?? null),
    build_command:
      normalizeCommand(current.build_command) ??
      (defaults?.buildCommand ?? null),
    start_command:
      normalizeCommand(current.start_command) ??
      (defaults?.startCommand ?? null),
    build_method:
      current.build_method === null ||
      current.build_method === undefined ||
      current.build_method === "auto"
        ? defaults?.buildMethod ?? "auto"
        : normalizeBuildMethod(current.build_method as BuildMethod),
    static_output_dir:
      current.static_output_dir ?? defaults?.outputDirectory ?? "dist",
    runtime_port: runtimePort,
    healthcheck_path:
      current.healthcheck_path ?? defaults?.healthcheck.path ?? "/",
    healthcheck_port: healthcheckPort,
    healthcheck_interval_s:
      current.healthcheck_interval_s ?? defaults?.healthcheck.intervalS ?? 5,
    healthcheck_timeout_s:
      current.healthcheck_timeout_s ?? defaults?.healthcheck.timeoutS ?? 3,
    healthcheck_retries:
      current.healthcheck_retries ?? defaults?.healthcheck.retries ?? 6,
    healthcheck_start_period_s:
      current.healthcheck_start_period_s ??
      defaults?.healthcheck.startPeriodS ??
      0,
  }
}
