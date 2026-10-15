// SPDX-License-Identifier: AGPL-3.0-only
import { parse } from "yaml"
import * as cryptoModule from "node:crypto"
import { resolveServiceCompose } from "../services/service-secrets"
import { createHmac } from "node:crypto"
import { describe, expect, it, spyOn } from "bun:test"
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
    expect(parse(result.composeResolved).services.web.environment.OBJECT).toBe("true")
    expect(parse(result.composeResolved).services.web.environment.LIST).toBe("42")
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
    expect(parse(result.composeResolved).services.web.environment.NUMBER).toBe("42")
    expect(parse(result.composeResolved).services.web.environment.BOOLEAN).toBe("true")
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
    expect(parse(result.composeResolved).services.web.environment.LITERAL).toBe("5678")
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
    expect(parse(protectedValues.compose_raw).services.web.environment.FLAG).toBe("true")
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

    expect(result.domain).toMatch(/^n8n-demo-[0-9a-f]{6}\.demo\.localhost$/)
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
    domainBase: "demo.localhost",
    publicOrigin: "http://localhost:8181",
    publicScheme: "http",
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
  expect(values.N8N_PORT).toBe("5678");
  expect(values.WEBHOOK_URL).toBe(`http://${result.domain}:8181/`)
  expect(result.declaredEntrypoint).toEqual({ serviceName: "n8n", port: 5678 });
  expect(Object.values(result.generatedVars)).not.toContain("5678");
});

it("rewrites every generated domain independently and preserves unrelated URLs", () => {
  const result = prepareTemplateInstall({
    projectSlug: "multi-domain",
    domainBase: "apps.example.test",
    publicOrigin: "https://panel.example.test:8443",
    publicScheme: "https",
    templateToml: `[variables]
domain_a = "\${domain}"
domain_b = "\${domain}"
webhook_a = "https://\${domain_a}/"
unrelated_suffix = "https://\${domain_a}.external.test/"
unrelated_userinfo = "https://\${domain_a}@external.test/"
[config.env]
WEBHOOK_A = "\${webhook_a}"
WEBHOOK_B = "https://\${domain_b}/"
UNRELATED_SUFFIX = "\${unrelated_suffix}"
UNRELATED_USERINFO = "\${unrelated_userinfo}"
[[config.domains]]
serviceName = "web"
port = 8080
host = "\${domain_a}"
`,
    compose: `services:
  web:
    image: nginx
    expose: [8080]
    environment:
      WEBHOOK_A: \${WEBHOOK_A}
      WEBHOOK_B: \${WEBHOOK_B}
      UNRELATED_SUFFIX: \${UNRELATED_SUFFIX}
      UNRELATED_USERINFO: \${UNRELATED_USERINFO}
`,
  })

  const values = parse(result.composeResolved).services.web.environment
  const domainA = String(values.WEBHOOK_A).match(/^https:\/\/([^/:]+):8443\/$/)?.[1]
  const domainB = String(values.WEBHOOK_B).match(/^https:\/\/([^/:]+):8443\/$/)?.[1]

  expect(domainA).toBeDefined()
  expect(domainB).toBeDefined()
  expect(domainA).toMatch(/^multi-domain-[0-9a-f]{6}\.apps\.example\.test$/)
  expect(domainB).toMatch(/^multi-domain-[0-9a-f]{6}\.apps\.example\.test$/)
  expect(domainA).not.toBe(domainB)
  expect(result.domain).toBe(domainA!)
  expect(values.WEBHOOK_A).toBe(`https://${domainA!}:8443/`)
  expect(values.WEBHOOK_B).toBe(`https://${domainB!}:8443/`)
  expect(values.UNRELATED_SUFFIX).toBe(`https://${domainA!}.external.test/`)
  expect(values.UNRELATED_USERINFO).toBe(`https://${domainA!}@external.test/`)
})

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
  expect(values.MS).toBe(String(Date.parse("2030-01-01T00:00:00Z")));
  expect(values.SECONDS).toBe("1893456000");
  expect(values.DEFAULT).toBe("fallback");
  expect(values.EMPTY).toBe("");
  expect(values.PRESENT).toBe("present");
  expect(values.NONEMPTY).toBe("");
  expect(values.REQUIRED).toBe("");
  expect(values.DOMAIN_DEFAULT).toBe("fallback");
});

it("interpolates YAML string scalars and keys without interpreting injected syntax", () => {
  const result = prepareTemplateInstall({
    projectSlug: "demo", templateToml: `[variables]
QUOTES = "''"
FRONT = '\"http://example.test\"'
PORT = "8000 # Do Not Alter"
JSON = '{"headers":{"X-Test":"a: b"}}'
KEY = "INTERPOLATED"
`, compose: `services:
  web:
    image: nginx
    environment:
      QUOTES: \${QUOTES}
      FRONT: \${FRONT}
      PORT: \${PORT}
      JSON: \${JSON}
      "${"$"}KEY": literal
      NUMBER: 123
      BOOLEAN: true
    command: ["echo", "\${JSON}"]
` });
  const service = parse(result.composeResolved).services.web;
  expect(service.environment).toEqual({
    QUOTES: "''", FRONT: '"http://example.test"', PORT: "8000 # Do Not Alter",
    JSON: '{"headers":{"X-Test":"a: b"}}', INTERPOLATED: "literal", NUMBER: 123, BOOLEAN: true,
  });
  expect(service.command).toEqual(["echo", '{"headers":{"X-Test":"a: b"}}']);
});

it("uses interpolation env values before helper names, including empty values", () => {
  const result = prepareTemplateInstall({ projectSlug: "demo",
    templateToml: `[variables]
domain = "chosen.example.test"
password = ""
hash = "chosen-hash"
`, compose: `services:
  web:
    image: nginx
    environment:
      DOMAIN: \${domain}
      PASSWORD: "\${password}"
      DEFAULT: \${password:-fallback}
      HASH: $hash
      GENERATED: \${password:8}
` });
  const values = parse(result.composeResolved).services.web.environment;
  expect(values.DOMAIN).toBe("chosen.example.test");
  expect(values.PASSWORD).toBe("");
  expect(values.DEFAULT).toBe("fallback");
  expect(values.HASH).toBe("chosen-hash");
  expect(values.GENERATED).toHaveLength(8);
  expect(Object.keys(result.generatedVars)).toEqual(["password:8"]);
});

it("keeps generated base64 characters literal through YAML serialization and vault resolution", async () => {
  const random = spyOn(cryptoModule, "randomBytes").mockImplementation(() => Buffer.from([251, 255]));
  const result = (() => {
    try {
      return prepareTemplateInstall({ projectSlug: "demo",
        templateToml: '[variables]\nTOKEN = "\${base64:2}"',
        compose: 'services:\n  web:\n    image: nginx\n    environment:\n      TOKEN: ${TOKEN}\n',
      });
    } finally { random.mockRestore(); }
  })();
  expect(result.generatedVars["TOKEN:base64:2"]).toBe("+/8=");
  expect(result.composeResolved).toContain("+/8=");
  const protectedValues = await protectServiceSecrets(result.composeResolved, result.generatedVars);
  expect(protectedValues.compose_raw).not.toContain("+/8=");
  const resolved = await resolveServiceCompose(protectedValues);
  expect(parse(resolved).services.web.environment.TOKEN).toBe("+/8=");
});
