// SPDX-License-Identifier: AGPL-3.0-only
import { parse } from "yaml"
import { createHmac } from "node:crypto"
import { describe, expect, it } from "bun:test"
import { prepareTemplateInstall } from "./template-toml"
import { protectServiceSecrets } from "../services/service-secrets"

describe("prepareTemplateInstall with template.toml", () => {
  it("resolves two-pass variables and both config.env shapes", () => {
    const result = prepareTemplateInstall({
      projectSlug: "demo",
      compose: `services:
  web:
    image: nginx
    expose: [8080]
    environment:
      APP: \${APP_NAME}
      URL: \${PUBLIC_URL}
      OBJECT: \${OBJECT_VALUE}
      LIST: \${LIST_VALUE}
`,
      templateToml: `[variables]
APP_NAME = "overridden-name"
HOST = "example.test"
PUBLIC_URL = "https://\${HOST}"
OBJECT_VALUE = "object-value"
LIST_VALUE = "list-value"

[config.env]
OBJECT_VALUE = true
LIST_VALUE = 42
`,
    })

    expect(result.composeResolved).toContain("APP: overridden-name")
    expect(result.composeResolved).toContain("URL: https://example.test")
    expect(result.composeResolved).toContain("OBJECT: true")
    expect(result.composeResolved).toContain("LIST: 42")
    expect(result.runtimeMode).toBe("swarm")
  })

  it("resolves config.env list entries and stringifies object values", () => {
    const result = prepareTemplateInstall({
      projectSlug: "demo",
      compose: `services:
  web:
    image: nginx
    expose: [8080]
    environment:
      STRING: \${STRING}
      NUMBER: \${NUMBER}
      BOOLEAN: \${BOOLEAN}
`,
      templateToml: `[variables]
STRING = "from-variable"

[config]
env = ["STRING=from-list", { NUMBER = 42, BOOLEAN = true }]
`,
    })

    expect(result.composeResolved).toContain("STRING: from-list")
    expect(result.composeResolved).toContain("NUMBER: 42")
    expect(result.composeResolved).toContain("BOOLEAN: true")
  })

  it("applies Compose interpolation and keeps escaped dollars literal", () => {
    const result = prepareTemplateInstall({
      projectSlug: "demo",
      compose: `services:
  web:
    image: nginx
    environment:
      escaped: "$\${KEEP}"
      colon_default: \${MISSING:-fallback}
      dash_default: \${MISSING-fallback}
      plus: \${KNOWN:+present}
      plus_missing: \${MISSING+not-present}
      required: \${KNOWN?required}
`,
      templateToml: `[variables]
KNOWN = "yes"
`,
    })

    expect(parse(result.composeResolved).services.web.environment.escaped).toBe("${KEEP}")
    expect(result.composeResolved).toContain("colon_default: fallback")
    expect(result.composeResolved).toContain("dash_default: fallback")
    expect(result.composeResolved).toContain("plus: present")
    expect(result.composeResolved).toContain("plus_missing:")
    expect(result.composeResolved).toContain("required: yes")
  })

  it("raises a validation error for a required missing variable", () => {
    expect(() =>
      prepareTemplateInstall({
        projectSlug: "demo",
        compose: `services:
  web:
    image: nginx
    environment:
      REQUIRED: \${REQUIRED:?configure REQUIRED}
`,
        templateToml: "[variables]\n",
      })
    ).toThrow(/Missing required Compose variable REQUIRED: configure REQUIRED/)
  })

  it("supports the Dokploy generators and only marks generated values as secrets", () => {
    const result = prepareTemplateInstall({
      projectSlug: "demo",
      compose: `services:
  web:
    image: nginx
    expose: [8080]
    environment:
      PASSWORD: \${PASSWORD}
      JWT: \${JWT}
      USERNAME: \${USERNAME}
      EMAIL: \${EMAIL}
      PORT: \${PORT}
      LITERAL: \${LITERAL}
      DIRECT: \${password:8}
`,
      templateToml: `[variables]
PASSWORD = "\${password:24}"
JWT = "\${jwt}"
USERNAME = "\${username}"
EMAIL = "\${email}"
PORT = "\${randomPort}"
LITERAL = "5678"
`,
    })

    expect(result.generatedVars).toHaveProperty("PASSWORD:password:24")
    expect(result.generatedVars).toHaveProperty("JWT:jwt")
    expect(result.generatedVars).toHaveProperty("USERNAME:username")
    expect(result.generatedVars).toHaveProperty("EMAIL:email")
    expect(result.generatedVars).toHaveProperty("PORT:randomPort")
    expect(Number(result.generatedVars["PORT:randomPort"])).toBeGreaterThanOrEqual(1)
    expect(Number(result.generatedVars["PORT:randomPort"])).toBeLessThanOrEqual(65535)
    expect(result.generatedVars).toHaveProperty("password:8")
    expect(result.generatedVars).not.toHaveProperty("LITERAL")
    expect(result.composeResolved).toContain("LITERAL: 5678")
  })

  it("does not vault short literal environment values", async () => {
    const result = prepareTemplateInstall({
      projectSlug: "demo",
      compose: `services:
  web:
    image: nginx
    expose: [8080]
    environment:
      PASSWORD: \${PASSWORD}
      FLAG: \${FLAG}
`,
      templateToml: `[variables]
PASSWORD = "\${password:16}"
FLAG = "true"
`,
    })
    const protectedValues = await protectServiceSecrets(
      result.composeResolved,
      result.generatedVars
    )

    expect(Object.keys(protectedValues.generated_env)).toEqual(["PASSWORD:password:16"])
    expect(protectedValues.compose_raw).toContain("FLAG: true")
  })

  it.each(["PAYLOAD", '{"sub":"demo"}'])("generates an HS256 JWT with a secret and payload %s", (payload) => {
    const result = prepareTemplateInstall({
      projectSlug: "demo",
      compose: `services:
  web:
    image: nginx
    expose: [8080]
    environment:
      TOKEN: \${TOKEN}
`,
      templateToml: `[variables]
SECRET = "fixed-secret"
PAYLOAD = '{"sub":"demo"}'
TOKEN = '\${jwt:SECRET:${payload}}'
`,
    })

    const token = result.composeResolved.match(/TOKEN: ([^\n]+)/)?.[1]
    expect(token?.split(".")).toHaveLength(3)
    expect(JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString()).sub).toBe("demo")
    expect(token?.startsWith("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.")).toBe(true)
  })

  it("uses the first declared domain and entrypoint", () => {
    const result = prepareTemplateInstall({
      projectSlug: "n8n-demo",
      compose: `services:
  worker:
    image: n8nio/n8n:latest
  n8n:
    image: n8nio/n8n:latest
    expose: [5678]
`,
      templateToml: `[variables]
main_domain = "\${domain}"

[[config.domains]]
serviceName = "n8n"
port = 5678
host = "\${main_domain}"

[[config.domains]]
serviceName = "worker"
port = 5679
host = "ignored.example"
`,
    })

    expect(result.domain).toMatch(/^n8n-demo-[0-9a-f]{6}\.traefik\.me$/)
    expect(result.declaredEntrypoint).toEqual({ serviceName: "n8n", port: 5678 })
    expect(result.composeResolved).not.toContain("${main_domain}")
  })

  it("keeps the legacy resolver when template.toml is absent", () => {
    expect(() =>
      prepareTemplateInstall({
        projectSlug: "demo",
        compose: "services:\n  web:\n    image: nginx\n    environment:\n      VALUE: \${ordinary_variable}\n",
      })
    ).toThrow("Unknown DSL helper: ${ordinary_variable}")
  })
})

it("resolves forward JWT dependencies, independent generators and opaque injected dollars", () => {
  const result = prepareTemplateInstall({ projectSlug: "demo",
    templateToml: `[variables]
TOKEN = "\${jwt:SECRET:PAYLOAD}"
URL = "https://\${HOST}"
HOST = "example.test"
SECRET = "\${password:24}"
SECOND = "\${password:24}"
PAYLOAD = '{"role":"admin"}'
LITERAL = '$UNSET'
`,
    compose: `services:
  web:
    image: nginx
    environment:
      TOKEN: \${TOKEN}
      SECRET: \${SECRET}
      SECOND: \${SECOND}
      LITERAL: \${LITERAL}
      URL: \${URL}
      DEFAULT: \${UNSET:-\${OTHER:-fallback}}
` });
  const values = parse(result.composeResolved).services.web.environment;
  expect(values.SECRET).not.toBe(values.SECOND);
  expect(values.URL).toBe("https://example.test");
  expect(values.LITERAL).toBe("$UNSET");
  expect(values.DEFAULT).toBe("fallback");
  const [head, payload, signature] = values.TOKEN.split(".");
  expect(signature).toBe(createHmac("sha256", values.SECRET).update(`${head}.${payload}`).digest("base64url"));
  expect(JSON.parse(Buffer.from(payload, "base64url").toString()).role).toBe("admin");
});

it("prepares an n8n-style template with its declared port and only generated secrets", () => {
  const result = prepareTemplateInstall({ projectSlug: "n8n-demo",
    templateToml: `[variables]
main_domain = "\${domain}"
encryption_key = "\${password:32}"
[config.env]
N8N_HOST = "\${main_domain}"
N8N_PORT = 5678
N8N_ENCRYPTION_KEY = "\${encryption_key}"
WEBHOOK_URL = "https://\${main_domain}/"
[[config.domains]]
serviceName = "n8n"
port = 5678
host = "\${main_domain}"
`,
    compose: `services:
  sidecar:
    image: nginx
    expose: [80]
  n8n:
    image: n8nio/n8n
    environment:
      N8N_HOST: \${N8N_HOST}
      N8N_PORT: \${N8N_PORT}
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      WEBHOOK_URL: \${WEBHOOK_URL}
` });
  expect(result.composeResolved).not.toContain("${");
  const values = parse(result.composeResolved).services.n8n.environment;
  expect(values.N8N_HOST).toBe(result.domain);
  expect(values.N8N_PORT).toBe(5678);
  expect(result.declaredEntrypoint).toEqual({ serviceName: "n8n", port: 5678 });
  expect(Object.values(result.generatedVars)).not.toContain("5678");
});

it("supports helper lengths, dated timestamps and unset versus empty operators", () => {
  const result = prepareTemplateInstall({ projectSlug: "demo", templateToml: '[variables]\nEMPTY = ""\n',
    compose: `services:
  web:
    image: nginx
    environment:
      RAW: \${jwt:16}
      HASH: \${hash}
      MS: \${timestampms:2030-01-01T00:00:00Z}
      SECONDS: \${timestamps:2030-01-01T00:00:00Z}
      DEFAULT: \${EMPTY:-fallback}
      EMPTY: "\${EMPTY-fallback}"
      PRESENT: \${EMPTY+present}
      NONEMPTY: "\${EMPTY:+present}"
      REQUIRED: "\${EMPTY?must be set}"
      DOMAIN_DEFAULT: \${domain:-fallback}
` });
  const values = parse(result.composeResolved).services.web.environment;
  expect(values.RAW).toMatch(/^[0-9a-f]{32}$/);
  expect(values.HASH).toMatch(/^demo-[0-9a-f]{6}$/);
  expect(values.MS).toBe(Date.parse("2030-01-01T00:00:00Z"));
  expect(values.SECONDS).toBe(1893456000);
  expect(values.DEFAULT).toBe("fallback");
  expect(values.EMPTY).toBe("");
  expect(values.PRESENT).toBe("present");
  expect(values.NONEMPTY).toBe("");
  expect(values.REQUIRED).toBe("");
  expect(values.DOMAIN_DEFAULT).toBe("fallback");
});
