// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  UnsupportedComposeFeatureError,
  composeToContainers,
} from "./compose-to-containers"

const PREFIX = "ploydok-svc-test-abc123"
const NETWORK = "ploydok-public"

function run(
  compose: string,
  opts?: Partial<Parameters<typeof composeToContainers>[0]>
) {
  return composeToContainers({
    compose,
    servicePrefix: PREFIX,
    network: NETWORK,
    ...opts,
  })
}

describe("composeToContainers", () => {
  it("minimal single service", () => {
    const result = run(`
services:
  web:
    image: nginx:1.25-alpine
    ports:
      - "8080:80"
    environment:
      FOO: bar
`)
    expect(result).toHaveLength(1)
    const c = result[0]!
    expect(c.name).toBe(`${PREFIX}-web`)
    expect(c.image).toBe("nginx:1.25-alpine")
    expect(c.env).toEqual({ FOO: "bar" })
    expect(c.ports).toEqual([
      { containerPort: 80, hostPort: 8080, proto: "tcp" },
    ])
    expect(c.networks).toEqual([NETWORK])
    expect(c.restartPolicy).toBe("unless-stopped")
    expect(c.exposedPort).toBe(80)
  })

  it("depends_on → topological order", () => {
    const result = run(`
services:
  app:
    image: myapp:latest
    depends_on:
      - db
  db:
    image: postgres:16
`)
    expect(result[0]!.name).toBe(`${PREFIX}-db`)
    expect(result[1]!.name).toBe(`${PREFIX}-app`)
    expect(result[1]!.dependsOn).toEqual(["db"])
  })

  it("environment as map", () => {
    const result = run(`
services:
  svc:
    image: alpine
    environment:
      KEY1: value1
      KEY2: value2
`)
    expect(result[0]!.env).toEqual({ KEY1: "value1", KEY2: "value2" })
  })

  it("environment as array", () => {
    const result = run(`
services:
  svc:
    image: alpine
    environment:
      - KEY1=value1
      - KEY2=value2
`)
    expect(result[0]!.env).toEqual({ KEY1: "value1", KEY2: "value2" })
  })

  it("labels as map", () => {
    const result = run(`
services:
  svc:
    image: alpine
    labels:
      com.example.foo: bar
`)
    expect(result[0]!.labels["com.example.foo"]).toBe("bar")
  })

  it("labels as array", () => {
    const result = run(`
services:
  svc:
    image: alpine
    labels:
      - com.example.foo=bar
`)
    expect(result[0]!.labels["com.example.foo"]).toBe("bar")
  })

  it("merges extra labels from input", () => {
    const result = run(
      `
services:
  svc:
    image: alpine
    labels:
      user.label: hello
`,
      { labels: { "ploydok.service_id": "uuid-123" } }
    )
    expect(result[0]!.labels["user.label"]).toBe("hello")
    expect(result[0]!.labels["ploydok.service_id"]).toBe("uuid-123")
  })

  it("named volume → mapped under volumes root", () => {
    const result = run(`
volumes:
  data:
services:
  db:
    image: postgres:16
    volumes:
      - data:/var/lib/postgresql/data
`)
    expect(result[0]!.volumes[0]!.hostPath).toBe(
      `/var/lib/ploydok/volumes/${PREFIX}/data`
    )
    expect(result[0]!.volumes[0]!.containerPath).toBe(
      "/var/lib/postgresql/data"
    )
    expect(result[0]!.volumes[0]!.readOnly).toBe(false)
  })

  it("relative bind volume ./data → mapped under volumes root", () => {
    const result = run(`
services:
  app:
    image: alpine
    volumes:
      - ./data:/app/data
`)
    expect(result[0]!.volumes[0]!.hostPath).toBe(
      `/var/lib/ploydok/volumes/${PREFIX}/data`
    )
  })

  it("volume with :ro flag", () => {
    const result = run(`
services:
  app:
    image: alpine
    volumes:
      - ./config:/etc/app:ro
`)
    expect(result[0]!.volumes[0]!.readOnly).toBe(true)
  })

  it("port format 5432:5432", () => {
    const result = run(`
services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
`)
    expect(result[0]!.ports[0]).toEqual({
      containerPort: 5432,
      hostPort: 5432,
      proto: "tcp",
    })
  })

  it("rejects address-specific port publication instead of widening it", () => {
    expect(() => run('services:\n  db:\n    image: postgres:16\n    ports: ["127.0.0.1:5432:5432"]')).toThrow(/host IP/)
  })

  it("healthcheck with 30s/1m intervals", () => {
    const result = run(`
services:
  app:
    image: alpine
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 1m
`)
    const hc = result[0]!.healthcheck!
    expect(hc.test).toEqual(["CMD", "curl", "-f", "http://localhost/health"])
    expect(hc.intervalSeconds).toBe(30)
    expect(hc.timeoutSeconds).toBe(10)
    expect(hc.retries).toBe(3)
    expect(hc.startPeriodSeconds).toBe(60)
  })

  it("command string is split", () => {
    const result = run(`
services:
  app:
    image: alpine
    command: sh -c "echo hello"
`)
    expect(result[0]!.command).toEqual(["sh", "-c", "echo hello"])
  })

  it("command array is preserved", () => {
    const result = run(`
services:
  app:
    image: alpine
    command: ["sh", "-c", "echo hello"]
`)
    expect(result[0]!.command).toEqual(["sh", "-c", "echo hello"])
  })

  it("invalid YAML throws with message", () => {
    expect(() => run("{ unclosed")).toThrow(/Invalid YAML/i)
  })

  it("build: present → UnsupportedComposeFeatureError", () => {
    expect(() =>
      run(`
services:
  app:
    build: .
    image: myapp
`)
    ).toThrow(UnsupportedComposeFeatureError)
  })

  it("env_file: present → UnsupportedComposeFeatureError", () => {
    expect(() =>
      run(`
services:
  app:
    image: alpine
    env_file: .env
`)
    ).toThrow(UnsupportedComposeFeatureError)
  })

  it("host volume /etc/passwd → UnsupportedComposeFeatureError", () => {
    expect(() =>
      run(`
services:
  app:
    image: alpine
    volumes:
      - /etc/passwd:/etc/passwd:ro
`)
    ).toThrow(UnsupportedComposeFeatureError)
  })

  it("cycle in depends_on → throws", () => {
    expect(() =>
      run(`
services:
  a:
    image: alpine
    depends_on:
      - b
  b:
    image: alpine
    depends_on:
      - a
`)
    ).toThrow(/Cycle detected/)
  })

  it("missing image → throws", () => {
    expect(() =>
      run(`
services:
  app:
    environment:
      FOO: bar
`)
    ).toThrow(/"image" is required/)
  })

  it("rejects readiness dependency conditions", () => {
    expect(() => run('services:\n  app:\n    image: alpine\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres:16')).toThrow(/service_healthy/)
  })

  it("networks override → UnsupportedComposeFeatureError", () => {
    expect(() =>
      run(`
services:
  app:
    image: alpine
    networks:
      - custom-net
`)
    ).toThrow(UnsupportedComposeFeatureError)
  })

  it("top-level x-* extensions are ignored", () => {
    expect(() =>
      run(`
x-common: &common
  restart: unless-stopped
services:
  app:
    image: alpine
`)
    ).not.toThrow()
  })

  it("deploy: swarm → UnsupportedComposeFeatureError", () => {
    expect(() =>
      run(`
services:
  app:
    image: alpine
    deploy:
      replicas: 2
`)
    ).toThrow(UnsupportedComposeFeatureError)
  })

  it("privileged → UnsupportedComposeFeatureError", () => {
    expect(() =>
      run(`
services:
  app:
    image: alpine
    privileged: true
`)
    ).toThrow(/privileged/)
  })

  it("network_mode host → UnsupportedComposeFeatureError", () => {
    expect(() =>
      run(`
services:
  app:
    image: alpine
    network_mode: host
`)
    ).toThrow(/network_mode/)
  })

  it("keeps the compose service name", () => {
    const result = run(`
services:
  api-gateway:
    image: alpine
`)
    expect(result[0]!.composeName).toBe("api-gateway")
  })
})
