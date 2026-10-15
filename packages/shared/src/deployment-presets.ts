// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod"
import type {
  BuildMethodRecommendation,
  Stack,
  StackClassification,
} from "./stack-classifier"

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

/**
 * Commands are eventually passed to a shell in a build workspace. Newlines
 * and NUL bytes cannot be represented safely in that contract. Empty input is
 * the explicit "inherit the preset" value and is persisted as null.
 */
export const CommandSchema = z.preprocess(
  (value) => (typeof value === "string" && value.length === 0 ? null : value),
  z
    .string()
    .max(2000)
    .refine((value) => !/[\u0000\r\n]/.test(value), {
      message: "must not contain NUL, carriage return, or newline characters",
    })
    .nullable()
)

export const PortSchema = z.number().int().min(1).max(65_535)
export const RuntimePortSchema = PortSchema
export const HealthcheckPortSchema = PortSchema

export const HealthcheckPathSchema = z
  .string()
  .min(1)
  .max(512)
  .startsWith("/")
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: "must not contain control characters",
  })

export const HealthcheckIntervalSchema = z.number().int().min(1).max(86_400)
export const HealthcheckTimeoutSchema = z.number().int().min(1).max(86_400)
export const HealthcheckRetriesSchema = z.number().int().min(1).max(100)
export const HealthcheckStartPeriodSchema = z
  .number()
  .int()
  .min(0)
  .max(86_400)

export const FRAMEWORK_PRESET_IDS = [
  "dockerfile",
  "compose",
  "next",
  "nuxt",
  "sveltekit",
  "remix",
  "astro",
  "tanstack-start",
  "hono",
  "node",
  "bun",
  "deno",
  "laravel",
  "symfony",
  "php",
  "django",
  "flask",
  "fastapi",
  "python",
  "go",
  "rust",
  "rails",
  "ruby",
  "phoenix",
  "elixir",
  "spring-boot",
  "java",
  "vite",
  "static",
  "unknown",
] as const

export const FrameworkPresetIdSchema = z.enum(FRAMEWORK_PRESET_IDS)
export type FrameworkPresetId = z.infer<typeof FrameworkPresetIdSchema>

export const FrameworkDetectionSchema = z.object({
  stack: z.string(),
  framework: z.string().optional(),
  presetId: FrameworkPresetIdSchema,
  confidence: z.enum(["high", "medium", "low"]),
  signals: z.array(z.string()),
  evidence: z.array(z.string()),
  ambiguous: z.boolean().optional(),
  candidates: z
    .array(
      z.object({
        stack: z.string(),
        framework: z.string().optional(),
        presetId: z.string(),
      })
    )
    .optional(),
  rootDir: z.string().optional(),
})
export type FrameworkDetection = z.infer<typeof FrameworkDetectionSchema>

export interface PresetHealthcheckDefaults {
  path: string
  port: number | null
  intervalS: number
  timeoutS: number
  retries: number
  startPeriodS: number
}

export interface FrameworkPresetDefaults {
  installCommand: string | null
  buildCommand: string | null
  startCommand: string | null
  outputDirectory: string | null
  port: number | null
  healthcheck: PresetHealthcheckDefaults
  buildMethod: BuildMethodRecommendation
  suggestedEnvVars?: Readonly<Record<string, string>>
}

export interface FrameworkPreset {
  id: string
  label: string
  stack: Stack
  defaults: FrameworkPresetDefaults
}

const healthcheck = (port: number | null): PresetHealthcheckDefaults => ({
  path: "/",
  port,
  intervalS: 5,
  timeoutS: 3,
  retries: 6,
  startPeriodS: port === null ? 0 : 30,
})

// Keep this registry data-only. It is imported by the API, dashboard and
// workers so a preset cannot silently drift between deployment surfaces.
export const FRAMEWORK_PRESETS: Readonly<
  Record<FrameworkPresetId, FrameworkPreset>
> = {
  dockerfile: {
    id: "dockerfile",
    label: "Dockerfile",
    stack: "unknown",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: null,
      healthcheck: healthcheck(null),
      buildMethod: "dockerfile",
    },
  },
  compose: {
    id: "compose",
    label: "Docker Compose",
    stack: "compose",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: null,
      healthcheck: healthcheck(null),
      buildMethod: "compose",
    },
  },
  next: {
    id: "next",
    label: "Next.js",
    stack: "next",
    defaults: {
      installCommand: null,
      buildCommand: "./node_modules/.bin/next build",
      startCommand: "./node_modules/.bin/next start -H 0.0.0.0 -p $PORT",
      outputDirectory: ".next",
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  nuxt: {
    id: "nuxt",
    label: "Nuxt",
    stack: "nuxt",
    defaults: {
      installCommand: null,
      buildCommand: "./node_modules/.bin/nuxt build",
      startCommand: "node .output/server/index.mjs",
      outputDirectory: ".output",
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  sveltekit: {
    id: "sveltekit",
    label: "SvelteKit",
    stack: "sveltekit",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  remix: {
    id: "remix",
    label: "Remix",
    stack: "remix",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "build",
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  astro: {
    id: "astro",
    label: "Astro",
    stack: "astro",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "dist",
      port: 4321,
      healthcheck: healthcheck(4321),
      buildMethod: "nixpacks",
    },
  },
  "tanstack-start": {
    id: "tanstack-start",
    label: "TanStack Start",
    stack: "node",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: ".output",
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  hono: {
    id: "hono",
    label: "Hono",
    stack: "hono",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  node: {
    id: "node",
    label: "Node.js",
    stack: "node",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  bun: {
    id: "bun",
    label: "Bun",
    stack: "bun",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  deno: {
    id: "deno",
    label: "Deno",
    stack: "deno",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  laravel: {
    id: "laravel",
    label: "Laravel",
    stack: "laravel",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "public",
      port: 80,
      healthcheck: healthcheck(80),
      buildMethod: "nixpacks",
      suggestedEnvVars: {
        SESSION_DRIVER: "file",
        CACHE_STORE: "file",
      },
    },
  },
  symfony: {
    id: "symfony",
    label: "Symfony",
    stack: "symfony",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "public",
      port: 80,
      healthcheck: healthcheck(80),
      buildMethod: "nixpacks",
      suggestedEnvVars: {
        APP_ENV: "prod",
        APP_DEBUG: "0",
        NIXPACKS_PHP_ROOT_DIR: "/app/public",
        NIXPACKS_PHP_FALLBACK_PATH: "/index.php",
      },
    },
  },
  php: {
    id: "php",
    label: "PHP",
    stack: "php",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "public",
      port: 80,
      healthcheck: healthcheck(80),
      buildMethod: "nixpacks",
    },
  },
  django: {
    id: "django",
    label: "Django",
    stack: "django",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 8000,
      healthcheck: healthcheck(8000),
      buildMethod: "nixpacks",
    },
  },
  flask: {
    id: "flask",
    label: "Flask",
    stack: "flask",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 8000,
      healthcheck: healthcheck(8000),
      buildMethod: "nixpacks",
    },
  },
  fastapi: {
    id: "fastapi",
    label: "FastAPI",
    stack: "fastapi",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 8000,
      healthcheck: healthcheck(8000),
      buildMethod: "nixpacks",
    },
  },
  python: {
    id: "python",
    label: "Python",
    stack: "python",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 8000,
      healthcheck: healthcheck(8000),
      buildMethod: "nixpacks",
    },
  },
  go: {
    id: "go",
    label: "Go",
    stack: "go",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 8080,
      healthcheck: healthcheck(8080),
      buildMethod: "nixpacks",
    },
  },
  rust: {
    id: "rust",
    label: "Rust",
    stack: "rust",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 8080,
      healthcheck: healthcheck(8080),
      buildMethod: "nixpacks",
    },
  },
  rails: {
    id: "rails",
    label: "Rails",
    stack: "ruby",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: "bundle exec rails server -b 0.0.0.0 -p $PORT",
      outputDirectory: "public",
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  ruby: {
    id: "ruby",
    label: "Ruby",
    stack: "ruby",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "public",
      port: 3000,
      healthcheck: healthcheck(3000),
      buildMethod: "nixpacks",
    },
  },
  phoenix: {
    id: "phoenix",
    label: "Phoenix",
    stack: "elixir",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: "mix phx.server",
      outputDirectory: null,
      port: 4000,
      healthcheck: healthcheck(4000),
      buildMethod: "nixpacks",
    },
  },
  elixir: {
    id: "elixir",
    label: "Elixir",
    stack: "elixir",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 4000,
      healthcheck: healthcheck(4000),
      buildMethod: "nixpacks",
    },
  },
  "spring-boot": {
    id: "spring-boot",
    label: "Spring Boot",
    stack: "java",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "target",
      port: 8080,
      healthcheck: healthcheck(8080),
      buildMethod: "nixpacks",
    },
  },
  java: {
    id: "java",
    label: "Java/JVM",
    stack: "java",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: 8080,
      healthcheck: healthcheck(8080),
      buildMethod: "nixpacks",
    },
  },
  vite: {
    id: "vite",
    label: "Vite",
    stack: "static",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "dist",
      port: null,
      healthcheck: healthcheck(null),
      buildMethod: "static",
    },
  },
  static: {
    id: "static",
    label: "Static HTML",
    stack: "static",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: "dist",
      port: null,
      healthcheck: healthcheck(null),
      buildMethod: "static",
    },
  },
  unknown: {
    id: "unknown",
    label: "Custom",
    stack: "unknown",
    defaults: {
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      port: null,
      healthcheck: healthcheck(null),
      buildMethod: "nixpacks",
    },
  },
} as const

export function getFrameworkPreset(
  id: FrameworkPresetId | string | null | undefined
): FrameworkPreset | undefined {
  if (!id) return undefined
  if (!Object.hasOwn(FRAMEWORK_PRESETS, id)) return undefined
  return FRAMEWORK_PRESETS[id as FrameworkPresetId]
}

export function listFrameworkPresets(): FrameworkPreset[] {
  return FRAMEWORK_PRESET_IDS.map((id) => FRAMEWORK_PRESETS[id])
}

export function presetIdForStack(
  stack: Stack,
  framework?: string
): FrameworkPresetId {
  if (framework === "Next.js") return "next"
  if (framework === "Nuxt") return "nuxt"
  if (framework === "SvelteKit") return "sveltekit"
  if (framework === "TanStack Start") return "tanstack-start"
  if (framework === "Rails") return "rails"
  if (framework === "Phoenix") return "phoenix"
  if (framework === "Spring Boot") return "spring-boot"
  if (framework === "Vite") return "vite"
  return stack
}

/**
 * Apply a persisted user choice to fresh repository evidence. The evidence is
 * kept for the UI, while the selected preset controls build method and the
 * framework used by workers. Suggestions from a different detected framework
 * are discarded so a Dockerfile selection cannot inherit Laravel or Node env.
 */
export function classificationForPreset(
  presetId: FrameworkPresetId | string,
  detected: StackClassification
): StackClassification {
  const parsedId = FrameworkPresetIdSchema.safeParse(presetId)
  if (!parsedId.success) return detected
  const normalizedPresetId = parsedId.data
  const preset = getFrameworkPreset(normalizedPresetId)
  if (!preset) return detected
  const {
    requiresExplicitBuildChoice: _detectedBuildChoice,
    requiresStartCommand: _detectedStartCommand,
    ambiguous: _detectedAmbiguous,
    suggestedStartCommand: _detectedStartCommandValue,
    ...detectedWithoutSelectionFlags
  } = detected
  const samePreset = detected.presetId === normalizedPresetId
  return {
    ...detectedWithoutSelectionFlags,
    stack: preset.stack,
    framework: preset.label,
    presetId: normalizedPresetId,
    preset,
    recommendedBuild: preset.defaults.buildMethod,
    warnings: samePreset ? detected.warnings : [],
    suggestedEnvVars: samePreset
      ? detected.suggestedEnvVars
      : { ...(preset.defaults.suggestedEnvVars ?? {}) },
    ...(samePreset && _detectedStartCommandValue
      ? { suggestedStartCommand: _detectedStartCommandValue }
      : !samePreset && preset.defaults.startCommand
        ? { suggestedStartCommand: preset.defaults.startCommand }
        : {}),
  }
}
