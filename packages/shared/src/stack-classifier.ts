// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stack classifier — pure function that maps a set of file-exists probes
 * against a Git repo to a stack classification with build recommendation.
 *
 * Design choices:
 *  - Pure function, no I/O. Callers (web wizard, API, CLI) feed the probe
 *    results after running their own HEAD checks.
 *  - Priority-ordered rules: Dockerfile > Compose > framework-specific
 *    (Laravel/Symfony/Next/Django) > generic language > Static > Unknown.
 *  - Each rule yields a confidence: "high" when two independent signals
 *    agree (composer.json + artisan), "medium" when a single strong signal,
 *    "low" for ambiguous cases.
 *  - The recommended build method is orthogonal to the stack: PHP stacks
 *    recommend "nixpacks" by default (like Dokploy/Coolify),
 *    a user-provided Dockerfile always wins.
 */

export type Stack =
  | "laravel"
  | "symfony"
  | "php"
  | "hono"
  | "next"
  | "remix"
  | "astro"
  | "node"
  | "bun"
  | "deno"
  | "django"
  | "flask"
  | "fastapi"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "elixir"
  | "java"
  | "compose"
  | "static"
  | "unknown"

export type BuildMethodRecommendation =
  "auto" | "dockerfile" | "compose" | "nixpacks" | "static"

export type ProbeKey =
  // Docker / Compose
  | "Dockerfile"
  | "compose.yaml"
  | "compose.yml"
  | "docker-compose.yml"
  | "docker-compose.yaml"
  // Env files
  | ".env"
  | ".env.example"
  | ".env.sample"
  | ".env.dist"
  | ".env.local"
  | ".env.development"
  | ".env.dev"
  | ".env.production"
  | ".env.prod"
  | ".env.test"
  // PHP
  | "composer.json"
  | "artisan"
  | "symfony.lock"
  | "bin/console"
  // JS / TS
  | "package.json"
  | "next.config.js"
  | "next.config.mjs"
  | "next.config.ts"
  | "remix.config.js"
  | "astro.config.mjs"
  | "astro.config.ts"
  | "deno.json"
  | "bun.lock"
  | "bun.lockb"
  // Python
  | "pyproject.toml"
  | "requirements.txt"
  | "manage.py"
  | "main.py"
  | "app.py"
  | "wsgi.py"
  // Other languages
  | "go.mod"
  | "Cargo.toml"
  | "Gemfile"
  | ".ruby-version"
  | "mix.exs"
  | "pom.xml"
  | "build.gradle"
  | "build.gradle.kts"
  | "settings.gradle"
  | "settings.gradle.kts"
  // Static
  | "index.html"

/**
 * Map of probe key → existence. A probe absent from the record is treated as
 * false (not yet fetched callers should pre-populate with false explicitly to
 * opt in to a deterministic classification).
 */
export type ProbeResults = Partial<Record<ProbeKey, boolean>>

export type ManifestProbeKey =
  | "package.json"
  | "astro.config.mjs"
  | "astro.config.ts"
  | "composer.json"
  | "composer.lock"
  | "Gemfile"
  | "mix.exs"
  | "pom.xml"
  | "build.gradle"
  | "build.gradle.kts"
  | "requirements.txt"
  | "pyproject.toml"

export type ManifestContents = Partial<Record<ManifestProbeKey, string>>

export interface FrameworkGuardrailRepair {
  key: string
  value?: string
  phase?: "build" | "runtime" | "both"
  reason: string
}

export interface FrameworkGuardrailReport {
  repairs: FrameworkGuardrailRepair[]
  warnings: string[]
  fatal: string[]
  defaults: {
    runtimePort?: number
    healthcheckPath?: string
    healthcheckPort?: number
    suggestedEnvVars: Record<string, string>
  }
}

export interface StackClassification {
  stack: Stack
  framework?: string
  confidence: "high" | "medium" | "low"
  /** Ordered signals that triggered the classification. */
  signals: ProbeKey[]
  recommendedBuild: BuildMethodRecommendation
  /** Human-readable warnings to show the user in the wizard. */
  warnings: string[]
  /**
   * Env vars Ploydok will auto-inject so the detected framework works out-of-the-box
   * under Nixpacks without any manual configuration from the user.
   * Empty for stacks that Nixpacks handles natively (e.g. Laravel).
   */
  suggestedEnvVars: Record<string, string>
  /** Safe conventional runtime command inferred from strong repository signals. */
  suggestedStartCommand?: string
  /** The detected repository cannot be deployed safely without a manual build choice. */
  requiresExplicitBuildChoice?: boolean
}

/** Ordered list of all probe keys the classifier understands. */
export const ALL_PROBE_KEYS: ReadonlyArray<ProbeKey> = [
  "Dockerfile",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env",
  ".env.example",
  ".env.sample",
  ".env.dist",
  ".env.local",
  ".env.development",
  ".env.dev",
  ".env.production",
  ".env.prod",
  ".env.test",
  "composer.json",
  "artisan",
  "symfony.lock",
  "bin/console",
  "package.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "remix.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "deno.json",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "manage.py",
  "main.py",
  "app.py",
  "wsgi.py",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  ".ruby-version",
  "mix.exs",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "index.html",
]

export const ENV_FILE_PROBE_KEYS: ReadonlyArray<ProbeKey> = [
  ".env",
  ".env.example",
  ".env.sample",
  ".env.dist",
  ".env.local",
  ".env.development",
  ".env.dev",
  ".env.production",
  ".env.prod",
  ".env.test",
]

export const MANIFEST_FILE_PROBE_KEYS: ReadonlyArray<ManifestProbeKey> = [
  "package.json",
  "astro.config.mjs",
  "astro.config.ts",
  "composer.json",
  "composer.lock",
  "Gemfile",
  "mix.exs",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
]

function has(probes: ProbeResults, key: ProbeKey): boolean {
  return probes[key] === true
}

function hasAny(probes: ProbeResults, keys: ReadonlyArray<ProbeKey>): boolean {
  for (const k of keys) if (has(probes, k)) return true
  return false
}

function composeSignal(probes: ProbeResults): ProbeKey | null {
  const candidates: ReadonlyArray<ProbeKey> = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
  ]
  for (const k of candidates) if (has(probes, k)) return k
  return null
}

type JsonObject = Record<string, unknown>

function parseJsonObject(content: string | undefined): JsonObject | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content)
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null
  } catch {
    return null
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function hasPackage(manifest: JsonObject | null, packageName: string): boolean {
  if (!manifest) return false
  const maps = [
    asObject(manifest.dependencies),
    asObject(manifest.devDependencies),
    asObject(manifest.peerDependencies),
    asObject(manifest.optionalDependencies),
    asObject(manifest.require),
    asObject(manifest["require-dev"]),
  ]
  return maps.some((map) => typeof map?.[packageName] === "string")
}

function manifestContains(
  manifests: ManifestContents,
  keys: ReadonlyArray<ManifestProbeKey>,
  pattern: RegExp
): boolean {
  return keys.some((key) => pattern.test(manifests[key] ?? ""))
}

function pythonManifestDeclaresPackage(
  requirements: string | undefined,
  pyproject: string | undefined,
  packageName: string
): boolean {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const requirementPattern = new RegExp(
    `^\\s*${escapedName}(?:\\[[^\\]]+\\])?\\s*(?:[<>=!~;@]|$)`,
    "i"
  )
  if (
    requirements
      ?.split(/\r?\n/)
      .some((line) => requirementPattern.test(line.replace(/\s+#.*$/, "")))
  ) {
    return true
  }

  if (!pyproject) return false
  const withoutComments = pyproject.replace(/\s+#.*$/gm, "")
  const projectDependencies = withoutComments.match(
    /(?:^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/
  )?.[1]
  const quotedDependencyPattern = new RegExp(
    `["']${escapedName}(?:\\[[^\\]]+\\])?\\s*(?:[<>=!~;@][^"']*)?["']`,
    "i"
  )
  if (
    projectDependencies &&
    quotedDependencyPattern.test(projectDependencies)
  ) {
    return true
  }

  const poetryDependencies = withoutComments.match(
    /(?:^|\n)\s*\[tool\.poetry\.dependencies\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/
  )?.[1]
  return Boolean(
    poetryDependencies &&
    new RegExp(`^\\s*${escapedName}\\s*=`, "im").test(poetryDependencies)
  )
}

function mergeSuggestedEnvVars(
  classification: StackClassification,
  suggestedEnvVars: Record<string, string>
): StackClassification {
  return {
    ...classification,
    suggestedEnvVars: {
      ...classification.suggestedEnvVars,
      ...suggestedEnvVars,
    },
  }
}

/**
 * classify a repository from probe results. Pure function, deterministic.
 */
export function classifyStack(probes: ProbeResults): StackClassification {
  // 1. User-provided Dockerfile wins — no other signal can override.
  if (has(probes, "Dockerfile")) {
    return {
      stack: "unknown",
      framework: "Dockerfile",
      confidence: "high",
      signals: ["Dockerfile"],
      recommendedBuild: "dockerfile",
      warnings: [],
      suggestedEnvVars: {},
    }
  }

  // 2. Compose detected (Ploydok doesn't yet run compose natively — warn).
  const compose = composeSignal(probes)
  if (compose) {
    return {
      stack: "compose",
      framework: "Docker Compose",
      confidence: "high",
      signals: [compose],
      recommendedBuild: "compose",
      warnings: ["compose_native_unavailable"],
      suggestedEnvVars: {},
      requiresExplicitBuildChoice: true,
    }
  }

  // 3. PHP — Laravel, Symfony, generic
  if (has(probes, "composer.json")) {
    const signals: ProbeKey[] = ["composer.json"]
    if (has(probes, "artisan")) {
      signals.push("artisan")
      // Laravel often has a Vite front-end (package.json)
      const hasNodeFrontend = has(probes, "package.json")
      if (hasNodeFrontend) signals.push("package.json")
      return {
        stack: "laravel",
        framework: "Laravel",
        confidence: "high",
        signals,
        recommendedBuild: "nixpacks",
        warnings: [],
        // Defaults that make a fresh Laravel repo healthy on first deploy
        // without user config:
        // - SESSION_DRIVER=file / CACHE_STORE=file: Laravel 11+ defaults to
        //   `database` which reads/writes a sqlite file the fixture does
        //   not ship. File-backed sessions sidestep that on zero-DB
        //   deploys.
        // - NIXPACKS_NODE_VERSION=22: Vite 8 requires Node ≥ 20.19 or
        //   ≥ 22.12; Nixpacks can default to 18, which crashes on
        //   `vite build` (CustomEvent).
        //   Only pinned when package.json is present.
        // APP_KEY is generated by the API per app during framework env
        // preparation so each Laravel runtime gets a unique key.
        suggestedEnvVars: {
          SESSION_DRIVER: "file",
          CACHE_STORE: "file",
          ...(hasNodeFrontend ? { NIXPACKS_NODE_VERSION: "22" } : {}),
        },
      }
    }
    if (has(probes, "symfony.lock") || has(probes, "bin/console")) {
      if (has(probes, "symfony.lock")) signals.push("symfony.lock")
      if (has(probes, "bin/console")) signals.push("bin/console")
      return {
        stack: "symfony",
        framework: "Symfony",
        confidence: "high",
        signals,
        recommendedBuild: "nixpacks",
        warnings: [],
        // - NIXPACKS_PHP_ROOT_DIR / NIXPACKS_PHP_FALLBACK_PATH: Nixpacks'
        //   Laravel-centric PHP provider only rewrites index.php when these
        //   are set (Coolify documents the same gotcha).
        // - NIXPACKS_INSTALL_CMD: composer runs as root in the Nixpacks
        //   build container, which disables plugins by default. That breaks
        //   symfony/runtime's post-install plugin (it generates
        //   `autoload_runtime.php`, which `public/index.php` requires) and
        //   the Flex `symfony-cmd` helper (which `auto-scripts` invokes).
        //   `COMPOSER_ALLOW_SUPERUSER=1` re-enables plugins in the
        //   build so the autoloader + Flex helpers are wired correctly.
        //   Also prepends `mkdir -p /var/log/nginx /var/cache/nginx` that
        //   the default Nixpacks PHP recipe runs but we override wholesale.
        // APP_ENV / APP_DEBUG: Symfony defaults to dev when APP_ENV is absent,
        // which leaks verbose debug logs through php-fpm/nginx in deployed apps.
        // Keep runtime explicit and production-oriented by default; users can
        // override these in the app env step before first deploy.
        suggestedEnvVars: {
          APP_ENV: "prod",
          APP_DEBUG: "0",
          NIXPACKS_PHP_ROOT_DIR: "/app/public",
          NIXPACKS_PHP_FALLBACK_PATH: "/index.php",
          NIXPACKS_INSTALL_CMD:
            "mkdir -p /var/log/nginx /var/cache/nginx && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction --no-progress --prefer-dist --ignore-platform-reqs --optimize-autoloader",
        },
      }
    }
    return {
      stack: "php",
      framework: "PHP",
      confidence: "medium",
      signals,
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {},
    }
  }

  // 4. JS / TS — frameworks then generic Node/Bun/Deno
  if (has(probes, "package.json")) {
    const nextCfg = (
      ["next.config.js", "next.config.mjs", "next.config.ts"] as const
    ).find((k) => has(probes, k))
    if (nextCfg) {
      return {
        stack: "next",
        framework: "Next.js",
        confidence: "high",
        signals: ["package.json", nextCfg],
        recommendedBuild: "nixpacks",
        warnings: [],
        suggestedEnvVars: {},
      }
    }
    if (has(probes, "remix.config.js")) {
      return {
        stack: "remix",
        framework: "Remix",
        confidence: "high",
        signals: ["package.json", "remix.config.js"],
        recommendedBuild: "nixpacks",
        warnings: [],
        suggestedEnvVars: {},
      }
    }
    const astroCfg = (["astro.config.mjs", "astro.config.ts"] as const).find(
      (k) => has(probes, k)
    )
    if (astroCfg) {
      return {
        stack: "astro",
        framework: "Astro",
        confidence: "high",
        signals: ["package.json", astroCfg],
        recommendedBuild: "nixpacks",
        warnings: [],
        suggestedEnvVars: {},
      }
    }
    const bunLock = (["bun.lock", "bun.lockb"] as const).find((key) =>
      has(probes, key)
    )
    if (bunLock) {
      return {
        stack: "bun",
        framework: "Bun",
        confidence: "high",
        signals: ["package.json", bunLock],
        recommendedBuild: "nixpacks",
        warnings: [],
        suggestedEnvVars: {},
      }
    }
    return {
      stack: "node",
      framework: "Node.js",
      confidence: "medium",
      signals: ["package.json"],
      recommendedBuild: "nixpacks",
      warnings: [
        "Vérifie NIXPACKS_NODE_VERSION si ton projet cible Node ≥ 20 (Node 18 EOL en 2025).",
      ],
      suggestedEnvVars: {},
    }
  }

  if (has(probes, "deno.json")) {
    return {
      stack: "deno",
      framework: "Deno",
      confidence: "high",
      signals: ["deno.json"],
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {},
    }
  }

  // 5. Python — Django / Flask / FastAPI / generic
  if (has(probes, "manage.py")) {
    const signals: ProbeKey[] = ["manage.py"]
    if (has(probes, "pyproject.toml")) signals.push("pyproject.toml")
    else if (has(probes, "requirements.txt")) signals.push("requirements.txt")
    return {
      stack: "django",
      framework: "Django",
      confidence: "high",
      signals,
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: { NIXPACKS_PYTHON_VERSION: "3.12" },
    }
  }
  if (hasAny(probes, ["pyproject.toml", "requirements.txt"])) {
    return {
      stack: "python",
      framework: "Python",
      confidence: "medium",
      signals: has(probes, "pyproject.toml")
        ? ["pyproject.toml"]
        : ["requirements.txt"],
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {},
    }
  }

  // 6. Go / Rust / Ruby / Elixir / Java
  if (has(probes, "go.mod")) {
    return {
      stack: "go",
      framework: "Go",
      confidence: "high",
      signals: ["go.mod"],
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {},
    }
  }
  if (has(probes, "Cargo.toml")) {
    return {
      stack: "rust",
      framework: "Rust",
      confidence: "high",
      signals: ["Cargo.toml"],
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {},
    }
  }
  if (has(probes, "Gemfile")) {
    return {
      stack: "ruby",
      framework: "Ruby",
      confidence: "medium",
      signals: ["Gemfile"],
      recommendedBuild: "nixpacks",
      warnings: [
        ...(has(probes, ".ruby-version")
          ? []
          : [
              "Nixpacks exige une version Ruby : ajoute .ruby-version ou configure NIXPACKS_RUBY_VERSION.",
            ]),
      ],
      suggestedEnvVars: {
        RAILS_ENV: "production",
        RAILS_SERVE_STATIC_FILES: "true",
      },
    }
  }
  if (has(probes, "mix.exs")) {
    return {
      stack: "elixir",
      framework: "Elixir",
      confidence: "high",
      signals: ["mix.exs"],
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {},
    }
  }
  if (hasAny(probes, ["pom.xml", "build.gradle", "build.gradle.kts"])) {
    const sig: ProbeKey = has(probes, "pom.xml")
      ? "pom.xml"
      : has(probes, "build.gradle")
        ? "build.gradle"
        : "build.gradle.kts"
    const missingGradleSettings =
      sig !== "pom.xml" &&
      !hasAny(probes, ["settings.gradle", "settings.gradle.kts"])
    return {
      stack: "java",
      framework: "Java/JVM",
      confidence: "medium",
      signals: [sig],
      recommendedBuild: "nixpacks",
      warnings: missingGradleSettings
        ? [
            "Nixpacks attend settings.gradle(.kts) pour détecter un projet Gradle ; ajoute-le ou fournis un Dockerfile.",
          ]
        : [],
      suggestedEnvVars: {},
      ...(missingGradleSettings ? { requiresExplicitBuildChoice: true } : {}),
    }
  }

  // 7. Static site
  if (has(probes, "index.html")) {
    return {
      stack: "static",
      framework: "Static HTML",
      confidence: "medium",
      signals: ["index.html"],
      recommendedBuild: "static",
      warnings: [],
      suggestedEnvVars: {},
    }
  }

  // 8. Nothing matched
  return {
    stack: "unknown",
    confidence: "low",
    signals: [],
    recommendedBuild: "auto",
    warnings: [
      "Aucune stack reconnue — ajoute un Dockerfile ou choisis manuellement un build method.",
    ],
    suggestedEnvVars: {},
  }
}

export function classifyStackWithManifests(
  probes: ProbeResults,
  manifests: ManifestContents = {}
): StackClassification {
  const base = classifyStack(probes)
  const packageJson = parseJsonObject(manifests["package.json"])
  const composerJson = parseJsonObject(manifests["composer.json"])
  const composerText = `${manifests["composer.json"] ?? ""}\n${
    manifests["composer.lock"] ?? ""
  }`

  if (
    base.stack === "php" &&
    (hasPackage(composerJson, "laravel/framework") ||
      /"name"\s*:\s*"laravel\/framework"/.test(composerText))
  ) {
    const hasNodeFrontend = has(probes, "package.json")
    return {
      stack: "laravel",
      framework: "Laravel",
      confidence: "medium",
      signals: hasNodeFrontend
        ? ["composer.json", "package.json"]
        : ["composer.json"],
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {
        SESSION_DRIVER: "file",
        CACHE_STORE: "file",
        ...(hasNodeFrontend ? { NIXPACKS_NODE_VERSION: "22" } : {}),
      },
    }
  }

  if (
    base.stack === "php" &&
    (hasPackage(composerJson, "symfony/framework-bundle") ||
      hasPackage(composerJson, "symfony/runtime") ||
      hasPackage(composerJson, "symfony/flex") ||
      /"name"\s*:\s*"symfony\/(framework-bundle|runtime|flex)"/.test(
        composerText
      ))
  ) {
    return {
      stack: "symfony",
      framework: "Symfony",
      confidence: "high",
      signals: ["composer.json"],
      recommendedBuild: "nixpacks",
      warnings: [],
      suggestedEnvVars: {
        APP_ENV: "prod",
        APP_DEBUG: "0",
        NIXPACKS_PHP_ROOT_DIR: "/app/public",
        NIXPACKS_PHP_FALLBACK_PATH: "/index.php",
        NIXPACKS_INSTALL_CMD:
          "mkdir -p /var/log/nginx /var/cache/nginx && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction --no-progress --prefer-dist --ignore-platform-reqs --optimize-autoloader",
      },
    }
  }

  const astroFromPackage =
    base.stack === "node" && hasPackage(packageJson, "astro")
  if (base.stack === "astro" || astroFromPackage) {
    const astroBase: StackClassification = astroFromPackage
      ? {
          ...base,
          stack: "astro",
          framework: "Astro",
          confidence: "high",
          signals: ["package.json"],
        }
      : base
    const hasAstroConfig =
      has(probes, "astro.config.mjs") || has(probes, "astro.config.ts")
    const astroConfig =
      manifests["astro.config.mjs"] ?? manifests["astro.config.ts"]
    const outputTokenCount = astroConfig?.match(/\boutput\b/g)?.length ?? 0
    const hasDirectConfigObject = /\bdefineConfig\s*\(\s*\{/.test(
      astroConfig ?? ""
    )
    const configCanBeStatic =
      !hasAstroConfig ||
      (Boolean(astroConfig?.trim()) &&
        hasDirectConfigObject &&
        !/\.\.\./.test(astroConfig ?? "") &&
        !/\badapter\b/.test(astroConfig ?? "") &&
        (outputTokenCount === 0 ||
          (outputTokenCount === 1 &&
            /\boutput\s*:\s*["']static["']/.test(astroConfig ?? ""))))

    if (configCanBeStatic) {
      return {
        ...astroBase,
        recommendedBuild: "static",
        suggestedEnvVars: {},
      }
    }

    return mergeSuggestedEnvVars(astroBase, {
      NIXPACKS_NODE_VERSION: "22",
    })
  }

  const packageScripts = asObject(packageJson?.scripts)
  const packageBuildScript =
    typeof packageScripts?.build === "string" ? packageScripts.build : ""
  const hasPackageStartScript = typeof packageScripts?.start === "string"
  if (
    (base.stack === "node" || base.stack === "bun") &&
    has(probes, "index.html") &&
    hasPackage(packageJson, "vite") &&
    /(?:^|\s|&&)vite\s+build(?:\s|$)/.test(packageBuildScript) &&
    !hasPackageStartScript
  ) {
    return {
      stack: "static",
      framework: "Vite",
      confidence: "high",
      signals: ["package.json", "index.html"],
      recommendedBuild: "static",
      warnings: [],
      suggestedEnvVars: {},
    }
  }

  if (base.stack === "node" && hasPackage(packageJson, "hono")) {
    return {
      ...mergeSuggestedEnvVars(base, {
        NIXPACKS_NODE_VERSION: "22",
        HOSTNAME: "0.0.0.0",
      }),
      stack: "hono",
      framework: "Hono",
      confidence: "high",
      signals: ["package.json"],
      warnings: manifestContains(
        manifests,
        ["package.json"],
        /wrangler|@cloudflare\/workers|cloudflare:satisfies/
      )
        ? [
            "Hono détecté avec un signal Cloudflare/Wrangler — vérifie qu'un serveur Node/Bun écoute sur PORT.",
          ]
        : [],
    }
  }

  if (base.stack === "node") {
    return mergeSuggestedEnvVars(base, {
      NIXPACKS_NODE_VERSION: "22",
    })
  }

  if (base.stack === "next") {
    return mergeSuggestedEnvVars(base, {
      NIXPACKS_NODE_VERSION: "22",
      HOSTNAME: "0.0.0.0",
    })
  }

  if (base.stack === "remix") {
    return mergeSuggestedEnvVars(base, {
      NIXPACKS_NODE_VERSION: "22",
    })
  }

  if (base.stack === "bun" && hasPackage(packageJson, "hono")) {
    return {
      ...mergeSuggestedEnvVars(base, { HOSTNAME: "0.0.0.0" }),
      stack: "hono",
      framework: "Hono",
      confidence: "high",
      signals: base.signals,
    }
  }

  if (base.stack === "symfony" && hasPackage(composerJson, "symfony/runtime")) {
    return mergeSuggestedEnvVars(base, {
      APP_RUNTIME: "Symfony\\Component\\Runtime\\SymfonyRuntime",
    })
  }

  if (base.stack === "python") {
    const requirements = manifests["requirements.txt"]
    const pyproject = manifests["pyproject.toml"]
    if (pythonManifestDeclaresPackage(requirements, pyproject, "fastapi")) {
      const hasUvicorn = pythonManifestDeclaresPackage(
        requirements,
        pyproject,
        "uvicorn"
      )
      const moduleName = has(probes, "main.py")
        ? "main"
        : has(probes, "app.py")
          ? "app"
          : null
      return {
        ...mergeSuggestedEnvVars(base, {
          NIXPACKS_PYTHON_VERSION: "3.12",
          PYTHONUNBUFFERED: "1",
        }),
        stack: "fastapi",
        framework: "FastAPI",
        confidence: "high",
        ...(moduleName && hasUvicorn
          ? {
              suggestedStartCommand: `uvicorn ${moduleName}:app --host 0.0.0.0 --port \$PORT`,
            }
          : {
              warnings: [
                ...base.warnings,
                !hasUvicorn
                  ? "FastAPI détecté sans dépendance uvicorn : ajoute uvicorn au projet avant de configurer sa commande de démarrage."
                  : "FastAPI détecté sans main.py/app.py : configure explicitement la commande uvicorn.",
              ],
            }),
      }
    }
    if (pythonManifestDeclaresPackage(requirements, pyproject, "flask")) {
      const hasGunicorn = pythonManifestDeclaresPackage(
        requirements,
        pyproject,
        "gunicorn"
      )
      const moduleName = has(probes, "wsgi.py")
        ? "wsgi"
        : has(probes, "app.py")
          ? "app"
          : null
      return {
        ...mergeSuggestedEnvVars(base, {
          NIXPACKS_PYTHON_VERSION: "3.12",
          PYTHONUNBUFFERED: "1",
        }),
        stack: "flask",
        framework: "Flask",
        confidence: "high",
        ...(moduleName && hasGunicorn
          ? {
              suggestedStartCommand: `gunicorn --bind 0.0.0.0:\$PORT ${moduleName}:app`,
            }
          : {
              warnings: [
                ...base.warnings,
                !hasGunicorn
                  ? "Flask détecté sans dépendance gunicorn : ajoute gunicorn au projet avant de configurer sa commande de démarrage."
                  : "Flask détecté sans app.py/wsgi.py : configure explicitement la commande gunicorn.",
              ],
            }),
      }
    }
    return mergeSuggestedEnvVars(base, {
      NIXPACKS_PYTHON_VERSION: "3.12",
      PYTHONUNBUFFERED: "1",
    })
  }

  if (base.stack === "django") {
    return mergeSuggestedEnvVars(base, {
      NIXPACKS_PYTHON_VERSION: "3.12",
      PYTHONUNBUFFERED: "1",
    })
  }

  if (
    base.stack === "ruby" &&
    manifestContains(manifests, ["Gemfile"], /\brails\b/)
  ) {
    return {
      ...base,
      framework: "Rails",
      confidence: "high",
      suggestedEnvVars: {
        ...base.suggestedEnvVars,
        RAILS_ENV: "production",
        RAILS_SERVE_STATIC_FILES: "true",
      },
    }
  }

  if (
    base.stack === "elixir" &&
    manifestContains(manifests, ["mix.exs"], /\bphoenix\b/)
  ) {
    return {
      ...base,
      framework: "Phoenix",
      confidence: "high",
      suggestedEnvVars: {
        ...base.suggestedEnvVars,
        MIX_ENV: "prod",
        PHX_SERVER: "true",
      },
    }
  }

  if (
    base.stack === "java" &&
    manifestContains(
      manifests,
      ["pom.xml", "build.gradle", "build.gradle.kts"],
      /spring-boot|org\.springframework\.boot/
    )
  ) {
    return {
      ...base,
      framework: "Spring Boot",
      confidence: "high",
    }
  }

  return base
}

export function frameworkGuardrailDefaults(
  classification: StackClassification
): FrameworkGuardrailReport {
  const suggestedEnvVars = { ...classification.suggestedEnvVars }
  const warnings = [...classification.warnings]
  const fatal: string[] = []
  let runtimePort: number | undefined

  switch (classification.stack) {
    case "laravel":
    case "symfony":
    case "php":
      runtimePort = 80
      break
    case "django":
    case "flask":
    case "fastapi":
    case "python":
      runtimePort = 8000
      break
    case "astro":
      runtimePort = 4321
      break
    case "elixir":
      runtimePort = 4000
      break
    case "go":
    case "rust":
    case "java":
      runtimePort = 8080
      break
    case "static":
      runtimePort = 80
      break
    case "next":
    case "hono":
    case "remix":
    case "node":
    case "bun":
    case "deno":
    case "ruby":
      runtimePort = 3000
      break
  }

  return {
    repairs: [],
    warnings,
    fatal,
    defaults: {
      ...(runtimePort !== undefined
        ? { runtimePort, healthcheckPort: runtimePort }
        : {}),
      healthcheckPath: "/",
      suggestedEnvVars,
    },
  }
}
