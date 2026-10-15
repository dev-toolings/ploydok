// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  UnsupportedComposeFeatureError,
  composeRequiresContainerRuntime,
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

  it("preserves health and completion conditions for the orchestration wait", () => {
    const result = run(`
services:
  app:
    image: myapp:latest
    depends_on:
      db:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD", "pg_isready"]
  migrate:
    image: migrate:latest
    restart: "no"
`)

    expect(result.map((service) => service.composeName)).toEqual([
      "db",
      "migrate",
      "app",
    ])
    expect(result[2]!.dependsOn).toEqual(["db", "migrate"])
    expect(result[2]!.dependsOnConditions).toEqual({
      db: "service_healthy",
      migrate: "service_completed_successfully",
    })
  })

  it("refuses service_healthy when the dependency has no healthcheck", () => {
    expect(() => run(`
services:
  app:
    image: myapp:latest
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
`)).toThrow(/service_healthy.*healthcheck|healthcheck.*service_healthy/i)
  })

  it("keeps a successful one-shot dependency eligible for service_completed_successfully", () => {
    const result = run(`
services:
  app:
    image: myapp:latest
    depends_on:
      migrate:
        condition: service_completed_successfully
  migrate:
    image: migrate:latest
    restart: "no"
`)

    const migration = result.find((service) => service.composeName === "migrate")!
    expect(migration.restartPolicy).toBe("no")
    expect(result.find((service) => service.composeName === "app")!.dependsOnConditions).toEqual({
      migrate: "service_completed_successfully",
    })
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

  it("protects the service volume root from Compose and input label spoofing", () => {
    const result = run(
      `
services:
  svc:
    image: alpine
    labels:
      ploydok.volume_root: compose-spoof
`,
      { labels: { "ploydok.volume_root": "input-spoof" } }
    )
    expect(result[0]!.labels["ploydok.volume_root"]).toBe(
      `/var/lib/ploydok/volumes/${PREFIX}`
    )
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

  it("preserves explicit IPv4 and IPv6 host IPs", () => {
    const result = run(`
services:
  v4:
    image: nginx:alpine
    ports: ["127.0.0.1:8080:80"]
  v6:
    image: nginx:alpine
    ports:
      - target: 80
        published: 8081
        host_ip: ::1
`)
    expect(result[0]!.ports[0]).toMatchObject({
      containerPort: 80,
      hostPort: 8080,
      hostIp: "127.0.0.1",
    })
    expect(result[1]!.ports[0]).toMatchObject({
      containerPort: 80,
      hostPort: 8081,
      hostIp: "::1",
    })
  })

  it("rejects wildcard host IPs and selects Docker only for explicit bindings", () => {
    expect(() => run('services:\n  db:\n    image: postgres:16\n    ports: ["0.0.0.0:5432:5432"]')).toThrow(/wildcard host IP/)
    expect(composeRequiresContainerRuntime('services:\n  db:\n    image: postgres:16\n    ports: ["127.0.0.1:5432:5432"]')).toBe(true)
    expect(composeRequiresContainerRuntime('services:\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]')).toBe(false)
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

  it("rejects unknown dependency conditions", () => {
    expect(() => run('services:\n  app:\n    image: alpine\n    depends_on:\n      db:\n        condition: service_ready\n  db:\n    image: postgres:16')).toThrow(/service_ready|expected service_started/i)
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

describe("volume source containment", () => {
  it.each(["..", "../files/config.yaml", "../../..", "a/../../b", ".", "./data/.."])(
    "rejects a relative source outside the service directory: %s", source => {
      expect(() => run(`services:
  app:
    image: alpine
    volumes:
      - "${source}:/config:ro"
`))
        .toThrow(`Service "app": volume source "${source}" escapes the service volume directory`);
    }
  );
  it("rejects a traversing long-syntax bind source", () => {
    expect(() => run('services:\n  app:\n    image: alpine\n    volumes:\n      - type: bind\n        source: ../files/config.yaml\n        target: /config\n'))
      .toThrow('Service "app": volume source "../files/config.yaml" escapes the service volume directory');
  });
  it.each([
    "/var/lib/ploydok/volumes/../x",
    "/var/lib/ploydok/volumes/a/../../x",
    "/var/lib/ploydok/volumes",
    "/var/lib/ploydok/volumes/",
    "/var/lib/ploydok/volumes//",
    "/var/lib/ploydok/volumes/./",
  ])(
    "rejects an absolute source outside the service volume directory: %s", source => {
      expect(() => run(`services:
  app:
    image: alpine
    volumes: ["${source}:/config"]
`))
        .toThrow(`Service "app": volume source "${source}" escapes the service volume directory`);
    }
  );
  it.each([
    `/var/lib/ploydok/volumes/${PREFIX}`,
    `/var/lib/ploydok/volumes/${PREFIX}/`,
    `/var/lib/ploydok/volumes/${PREFIX}-other/data`,
    `/var/lib/ploydok/volumes/${PREFIX}other/data`,
  ])("rejects the service root and other service lookalikes: %s", source => {
    expect(() => run(`services:
  app:
    image: alpine
    volumes: ["${source}:/config"]
`)).toThrow(`Service "app": volume source "${source}" escapes the service volume directory`);
  });
  it("rejects a directory whose prefix merely resembles the volumes root", () => {
    expect(() => run('services:\n  app:\n    image: alpine\n    volumes: ["/var/lib/ploydok/volumes-other/data:/data"]'))
      .toThrow(UnsupportedComposeFeatureError);
  });
  it.each([
    ["./data", `/var/lib/ploydok/volumes/${PREFIX}/data`],
    ["data/sub", `/var/lib/ploydok/volumes/${PREFIX}/data/sub`],
    ["a/../data", `/var/lib/ploydok/volumes/${PREFIX}/data`],
  ])("keeps and normalizes contained paths: %s", (source, expected) => {
    const [container] = run(`services:
  app:
    image: alpine
    volumes: ["${source}:/data:ro"]
`);
    expect(container!.volumes[0]).toEqual({ hostPath: expected, containerPath: "/data", readOnly: true });
  });
  it.each([
    [`/var/lib/ploydok/volumes/${PREFIX}/data`, `/var/lib/ploydok/volumes/${PREFIX}/data`],
    [`/var/lib/ploydok/volumes/${PREFIX}/data/`, `/var/lib/ploydok/volumes/${PREFIX}/data`],
    [`/var/lib/ploydok/volumes/${PREFIX}/./data`, `/var/lib/ploydok/volumes/${PREFIX}/data`],
    [`/var/lib/ploydok/volumes/${PREFIX}/nested/../data`, `/var/lib/ploydok/volumes/${PREFIX}/data`],
  ])("keeps and normalizes an absolute descendant: %s", (source, expected) => {
    const [container] = run(`services:
  app:
    image: alpine
    volumes: ["${source}:/data:ro"]
`);
    expect(container!.volumes[0]).toEqual({ hostPath: expected, containerPath: "/data", readOnly: true });
  });
});
