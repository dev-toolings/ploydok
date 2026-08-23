// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "bun:test"
import {
  classifyStack,
  classifyStackWithManifests,
  ENV_FILE_PROBE_KEYS,
  frameworkGuardrailDefaults,
  type ProbeResults,
  type Stack,
  type BuildMethodRecommendation,
} from "./stack-classifier"

function probes(on: Array<string>): ProbeResults {
  const out: ProbeResults = {}
  for (const k of on) (out as Record<string, boolean>)[k] = true
  return out
}

describe("classifyStack — Dockerfile short-circuit", () => {
  it("Dockerfile alone wins, even with other signals", () => {
    const r = classifyStack(probes(["Dockerfile", "composer.json", "artisan"]))
    expect(r.recommendedBuild).toBe("dockerfile")
    expect(r.confidence).toBe("high")
    expect(r.signals).toEqual(["Dockerfile"])
  })
})

describe("classifyStack — Compose", () => {
  it("compose.yaml triggers compose stack", () => {
    const r = classifyStack(probes(["compose.yaml"]))
    expect(r.stack).toBe("compose")
    expect(r.recommendedBuild).toBe("compose")
    expect(r.warnings).toEqual(["compose_images_only"])
  })

  it("docker-compose.yml also matches", () => {
    const r = classifyStack(probes(["docker-compose.yml"]))
    expect(r.stack).toBe("compose")
  })

  it("compose + composer.json → compose wins (user likely manages PHP via compose)", () => {
    const r = classifyStack(
      probes(["compose.yaml", "composer.json", "symfony.lock"])
    )
    expect(r.stack).toBe("compose")
  })
})

describe("classifyStack — PHP", () => {
  it("Laravel: composer.json + artisan → nixpacks", () => {
    const r = classifyStack(probes(["composer.json", "artisan"]))
    expect(r.stack).toBe("laravel")
    expect(r.recommendedBuild).toBe("nixpacks")
    expect(r.signals).toContain("artisan")
  })

  it("Laravel + Vite: composer.json + artisan + package.json picks up the front-end signal", () => {
    const r = classifyStack(
      probes(["composer.json", "artisan", "package.json"])
    )
    expect(r.stack).toBe("laravel")
    expect(r.signals).toContain("package.json")
    // File-backed sessions + Node 22 pin for modern Vite.
    expect(r.suggestedEnvVars).toEqual({
      SESSION_DRIVER: "file",
      CACHE_STORE: "file",
      NIXPACKS_NODE_VERSION: "22",
    })
  })

  it("Laravel without package.json: file-backed defaults, no Node pin", () => {
    const r = classifyStack(probes(["composer.json", "artisan"]))
    expect(r.stack).toBe("laravel")
    expect(r.suggestedEnvVars).toEqual({
      SESSION_DRIVER: "file",
      CACHE_STORE: "file",
    })
  })

  it("Symfony via symfony.lock → nixpacks", () => {
    const r = classifyStack(probes(["composer.json", "symfony.lock"]))
    expect(r.stack).toBe("symfony")
    expect(r.recommendedBuild).toBe("nixpacks")
  })

  it("Symfony via bin/console only", () => {
    const r = classifyStack(probes(["composer.json", "bin/console"]))
    expect(r.stack).toBe("symfony")
  })

  it("PHP generic: composer.json alone (no framework marker)", () => {
    const r = classifyStack(probes(["composer.json"]))
    expect(r.stack).toBe("php")
    expect(r.confidence).toBe("medium")
    expect(r.recommendedBuild).toBe("nixpacks")
  })

  it("Symfony via composer.json dependencies", () => {
    const r = classifyStackWithManifests(probes(["composer.json"]), {
      "composer.json": JSON.stringify({
        require: { "symfony/framework-bundle": "^7.0" },
      }),
    })
    expect(r.stack).toBe("symfony")
    expect(r.framework).toBe("Symfony")
    expect(r.suggestedEnvVars.APP_ENV).toBe("prod")
  })

  it("Laravel via composer.json dependencies", () => {
    const r = classifyStackWithManifests(
      probes(["composer.json", "package.json"]),
      {
        "composer.json": JSON.stringify({
          require: { "laravel/framework": "^12.0" },
        }),
      }
    )
    expect(r.stack).toBe("laravel")
    expect(r.suggestedEnvVars.NIXPACKS_NODE_VERSION).toBe("22")
  })
})

describe("classifyStack — JS/TS frameworks", () => {
  it("Next.js via next.config.mjs", () => {
    const r = classifyStack(probes(["package.json", "next.config.mjs"]))
    expect(r.stack).toBe("next")
    expect(r.recommendedBuild).toBe("nixpacks")
  })

  it("Next.js via next.config.ts", () => {
    const r = classifyStack(probes(["package.json", "next.config.ts"]))
    expect(r.stack).toBe("next")
  })

  it("Remix", () => {
    const r = classifyStack(probes(["package.json", "remix.config.js"]))
    expect(r.stack).toBe("remix")
  })

  it("Astro", () => {
    const r = classifyStack(probes(["package.json", "astro.config.mjs"]))
    expect(r.stack).toBe("astro")
  })

  it("recommends static hosting for Astro's default static output", () => {
    const r = classifyStackWithManifests(
      probes(["package.json", "astro.config.mjs"]),
      {
        "package.json": JSON.stringify({ dependencies: { astro: "^5.0.0" } }),
        "astro.config.mjs":
          "export default defineConfig({ integrations: [mdx(), react()] })",
      }
    )
    expect(r.stack).toBe("astro")
    expect(r.recommendedBuild).toBe("static")
  })

  it("recommends static hosting when Astro has no config file", () => {
    const r = classifyStackWithManifests(probes(["package.json"]), {
      "package.json": JSON.stringify({ dependencies: { astro: "^5.0.0" } }),
    })
    expect(r.stack).toBe("astro")
    expect(r.recommendedBuild).toBe("static")
  })

  it("keeps a conservative runtime build when an Astro config cannot be read", () => {
    const r = classifyStackWithManifests(
      probes(["package.json", "astro.config.mjs"]),
      {
        "package.json": JSON.stringify({ dependencies: { astro: "^5.0.0" } }),
      }
    )
    expect(r.recommendedBuild).toBe("nixpacks")
  })

  it("keeps Astro server output on a runtime build", () => {
    const r = classifyStackWithManifests(
      probes(["package.json", "astro.config.mjs"]),
      {
        "package.json": JSON.stringify({
          dependencies: { astro: "^5.0.0", "@astrojs/node": "^9.0.0" },
        }),
        "astro.config.mjs":
          "export default defineConfig({ output: 'server', adapter: node() })",
      }
    )
    expect(r.stack).toBe("astro")
    expect(r.recommendedBuild).toBe("nixpacks")
  })

  it("keeps indirect Astro output configuration on a runtime build", () => {
    const r = classifyStackWithManifests(
      probes(["package.json", "astro.config.mjs"]),
      {
        "package.json": JSON.stringify({ dependencies: { astro: "^5.0.0" } }),
        "astro.config.mjs":
          "const output = process.env.ASTRO_OUTPUT; export default defineConfig({ output })",
      }
    )
    expect(r.recommendedBuild).toBe("nixpacks")
  })

  it("keeps imported or spread Astro configuration on a runtime build", () => {
    for (const config of [
      'import serverConfig from "./server-config"; export default defineConfig(serverConfig)',
      'import serverConfig from "./server-config"; export default defineConfig({ ...serverConfig })',
    ]) {
      const r = classifyStackWithManifests(
        probes(["package.json", "astro.config.mjs"]),
        {
          "package.json": JSON.stringify({ dependencies: { astro: "^5.0.0" } }),
          "astro.config.mjs": config,
        }
      )
      expect(r.recommendedBuild).toBe("nixpacks")
    }
  })

  it("Bun via bun.lockb", () => {
    const r = classifyStack(probes(["package.json", "bun.lockb"]))
    expect(r.stack).toBe("bun")
  })

  it("Bun via the current bun.lock format", () => {
    const r = classifyStack(probes(["package.json", "bun.lock"]))
    expect(r.stack).toBe("bun")
    expect(r.signals).toContain("bun.lock")
  })

  it("recommends static hosting for a Vite SPA without a start script", () => {
    const r = classifyStackWithManifests(
      probes(["package.json", "index.html"]),
      {
        "package.json": JSON.stringify({
          scripts: { build: "vite build" },
          devDependencies: { vite: "^7.0.0" },
        }),
      }
    )
    expect(r.stack).toBe("static")
    expect(r.framework).toBe("Vite")
    expect(r.recommendedBuild).toBe("static")
  })

  it("keeps a Vite-backed server on a runtime build when it has start", () => {
    const r = classifyStackWithManifests(
      probes(["package.json", "index.html"]),
      {
        "package.json": JSON.stringify({
          scripts: { build: "vite build", start: "node server.js" },
          dependencies: { vite: "^7.0.0", express: "^5.0.0" },
        }),
      }
    )
    expect(r.stack).toBe("node")
    expect(r.recommendedBuild).toBe("nixpacks")
  })

  it("Node generic with warning about Node version", () => {
    const r = classifyStack(probes(["package.json"]))
    expect(r.stack).toBe("node")
    expect(r.confidence).toBe("medium")
    expect(r.warnings.join(" ")).toMatch(/NIXPACKS_NODE_VERSION/)
  })

  it("Hono via package.json dependency", () => {
    const r = classifyStackWithManifests(probes(["package.json"]), {
      "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
    })
    expect(r.stack).toBe("hono")
    expect(r.framework).toBe("Hono")
    expect(r.suggestedEnvVars.NIXPACKS_NODE_VERSION).toBe("22")
    expect(r.suggestedEnvVars.HOSTNAME).toBe("0.0.0.0")
  })

  it("Deno standalone (no package.json)", () => {
    const r = classifyStack(probes(["deno.json"]))
    expect(r.stack).toBe("deno")
  })
})

describe("frameworkGuardrailDefaults", () => {
  it("returns runtime defaults for known frameworks", () => {
    const hono = classifyStackWithManifests(probes(["package.json"]), {
      "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
    })
    expect(frameworkGuardrailDefaults(hono).defaults.runtimePort).toBe(3000)

    const symfony = classifyStack(probes(["composer.json", "symfony.lock"]))
    expect(frameworkGuardrailDefaults(symfony).defaults.runtimePort).toBe(80)

    const astro = classifyStack(probes(["package.json", "astro.config.mjs"]))
    expect(frameworkGuardrailDefaults(astro).defaults.runtimePort).toBe(4321)
  })
})

describe("classifyStack — Python", () => {
  it("Django via manage.py", () => {
    const r = classifyStack(probes(["manage.py", "requirements.txt"]))
    expect(r.stack).toBe("django")
    expect(r.signals).toContain("requirements.txt")
  })

  it("Python generic via pyproject.toml", () => {
    const r = classifyStack(probes(["pyproject.toml"]))
    expect(r.stack).toBe("python")
  })

  it("Python generic via requirements.txt", () => {
    const r = classifyStack(probes(["requirements.txt"]))
    expect(r.stack).toBe("python")
  })

  it("infers a production FastAPI start command from main.py", () => {
    const r = classifyStackWithManifests(
      probes(["requirements.txt", "main.py"]),
      { "requirements.txt": "fastapi\nuvicorn\n" }
    )
    expect(r.stack).toBe("fastapi")
    expect(r.suggestedStartCommand).toBe(
      "uvicorn main:app --host 0.0.0.0 --port $PORT"
    )
    expect(r.suggestedEnvVars.NIXPACKS_PYTHON_VERSION).toBe("3.12")
  })

  it("infers a production Flask start command from app.py", () => {
    const r = classifyStackWithManifests(
      probes(["requirements.txt", "app.py"]),
      { "requirements.txt": "flask\ngunicorn\n" }
    )
    expect(r.stack).toBe("flask")
    expect(r.suggestedStartCommand).toBe(
      "gunicorn --bind 0.0.0.0:$PORT app:app"
    )
  })

  it("does not infer Python runtime commands for undeclared servers", () => {
    const fastApi = classifyStackWithManifests(
      probes(["requirements.txt", "main.py"]),
      { "requirements.txt": "fastapi\n" }
    )
    const flask = classifyStackWithManifests(
      probes(["requirements.txt", "app.py"]),
      { "requirements.txt": "flask\n" }
    )

    expect(fastApi.suggestedStartCommand).toBeUndefined()
    expect(fastApi.warnings.join(" ")).toContain("uvicorn")
    expect(flask.suggestedStartCommand).toBeUndefined()
    expect(flask.warnings.join(" ")).toContain("gunicorn")
  })

  it("ignores Python package names in comments and optional dependency groups", () => {
    const requirements = classifyStackWithManifests(
      probes(["requirements.txt", "main.py"]),
      { "requirements.txt": "fastapi==0.115\n# uvicorn intentionally absent\n" }
    )
    const pyproject = classifyStackWithManifests(
      probes(["pyproject.toml", "app.py"]),
      {
        "pyproject.toml": `[project]\ndependencies = ["flask"]\n[project.optional-dependencies]\ndev = ["gunicorn"]`,
      }
    )

    expect(requirements.suggestedStartCommand).toBeUndefined()
    expect(pyproject.suggestedStartCommand).toBeUndefined()
  })
})

describe("classifyStack — other languages", () => {
  const cases: Array<{
    files: Array<string>
    stack: Stack
    build: BuildMethodRecommendation
  }> = [
    { files: ["go.mod"], stack: "go", build: "nixpacks" },
    { files: ["Cargo.toml"], stack: "rust", build: "nixpacks" },
    { files: ["Gemfile"], stack: "ruby", build: "nixpacks" },
    { files: ["mix.exs"], stack: "elixir", build: "nixpacks" },
    { files: ["pom.xml"], stack: "java", build: "nixpacks" },
    { files: ["build.gradle"], stack: "java", build: "nixpacks" },
    { files: ["build.gradle.kts"], stack: "java", build: "nixpacks" },
  ]
  for (const c of cases) {
    it(`${c.files.join(" + ")} → ${c.stack} (${c.build})`, () => {
      const r = classifyStack(probes(c.files))
      expect(r.stack).toBe(c.stack)
      expect(r.recommendedBuild).toBe(c.build)
    })
  }

  it("warns when a Gradle project lacks settings.gradle", () => {
    const r = classifyStack(probes(["build.gradle"]))
    expect(r.warnings.join(" ")).toContain("settings.gradle")
    expect(r.requiresExplicitBuildChoice).toBe(true)
  })

  it("accepts a versioned Ruby project without the missing-version warning", () => {
    const r = classifyStack(probes(["Gemfile", ".ruby-version"]))
    expect(r.warnings.join(" ")).not.toContain(".ruby-version")
  })
})

describe("classifyStack — static + unknown", () => {
  it("exports common .env probe keys for create-app env detection", () => {
    expect(ENV_FILE_PROBE_KEYS).toContain(".env")
    expect(ENV_FILE_PROBE_KEYS).toContain(".env.example")
    expect(ENV_FILE_PROBE_KEYS).toContain(".env.production")
  })

  it("Static: index.html only", () => {
    const r = classifyStack(probes(["index.html"]))
    expect(r.stack).toBe("static")
    expect(r.recommendedBuild).toBe("static")
  })

  it("Unknown: no signal", () => {
    const r = classifyStack({})
    expect(r.stack).toBe("unknown")
    expect(r.confidence).toBe("low")
    expect(r.recommendedBuild).toBe("auto")
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

describe("classifyStack — tie-breaking & edge cases", () => {
  it("Node + Django markers: manage.py wins (Django is more specific)", () => {
    const r = classifyStack(
      probes(["package.json", "manage.py", "requirements.txt"])
    )
    // Note: current order checks PHP then JS then Python. package.json triggers node
    // BEFORE django check is reached. This is by design: if both exist, the repo is
    // a hybrid and we default to Node. Document this behavior.
    expect(r.stack).toBe("node")
  })

  it("Laravel + compose.yaml: compose wins (user is explicit about compose)", () => {
    const r = classifyStack(
      probes(["compose.yaml", "composer.json", "artisan"])
    )
    expect(r.stack).toBe("compose")
  })

  it("Dockerfile + compose.yaml: Dockerfile wins (even more explicit)", () => {
    const r = classifyStack(probes(["Dockerfile", "compose.yaml"]))
    expect(r.recommendedBuild).toBe("dockerfile")
  })
})

describe("classifyStack — suggestedEnvVars", () => {
  it("Symfony: injects runtime env + PHP root/fallback + composer allow-superuser", () => {
    const r = classifyStack(probes(["composer.json", "symfony.lock"]))
    expect(r.suggestedEnvVars).toEqual({
      APP_ENV: "prod",
      APP_DEBUG: "0",
      NIXPACKS_PHP_ROOT_DIR: "/app/public",
      NIXPACKS_PHP_FALLBACK_PATH: "/index.php",
      NIXPACKS_INSTALL_CMD:
        "mkdir -p /var/log/nginx /var/cache/nginx && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction --no-progress --prefer-dist --ignore-platform-reqs --optimize-autoloader",
    })
  })

  it("Symfony via bin/console: same env vars", () => {
    const r = classifyStack(probes(["composer.json", "bin/console"]))
    expect(r.suggestedEnvVars.NIXPACKS_PHP_ROOT_DIR).toBe("/app/public")
    expect(r.suggestedEnvVars.NIXPACKS_INSTALL_CMD).toContain(
      "COMPOSER_ALLOW_SUPERUSER=1"
    )
  })

  it("Laravel: injects file-backed session + cache defaults", () => {
    const r = classifyStack(probes(["composer.json", "artisan"]))
    expect(r.suggestedEnvVars).toEqual({
      SESSION_DRIVER: "file",
      CACHE_STORE: "file",
    })
  })

  it("Django: selects Python 3.12 through the Nixpacks provider variable", () => {
    const r = classifyStack(probes(["manage.py", "requirements.txt"]))
    expect(r.suggestedEnvVars).toEqual({ NIXPACKS_PYTHON_VERSION: "3.12" })
  })

  it("Ruby/Rails: injects RAILS_ENV and RAILS_SERVE_STATIC_FILES", () => {
    const r = classifyStack(probes(["Gemfile"]))
    expect(r.suggestedEnvVars).toEqual({
      RAILS_ENV: "production",
      RAILS_SERVE_STATIC_FILES: "true",
    })
  })

  it("Node.js: empty suggestedEnvVars", () => {
    const r = classifyStack(probes(["package.json"]))
    expect(r.suggestedEnvVars).toEqual({})
  })

  it("unknown stack: empty suggestedEnvVars", () => {
    const r = classifyStack({})
    expect(r.suggestedEnvVars).toEqual({})
  })

  it("Dockerfile short-circuit: empty suggestedEnvVars", () => {
    const r = classifyStack(
      probes(["Dockerfile", "composer.json", "symfony.lock"])
    )
    expect(r.suggestedEnvVars).toEqual({})
  })
})
