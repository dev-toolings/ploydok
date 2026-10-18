// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for the registry client.
 *
 * All HTTP calls are intercepted via a global `fetch` mock so no real registry
 * is required. We test listTags, getManifest, deleteDigest, gcKeepLast, and
 * diskGuard.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function makeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// listTags
// ---------------------------------------------------------------------------

describe("listTags", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore?.();
    mock.restore();
  });

  it("returns tags array on 200", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ name: "myapp", tags: ["v1", "v2", "latest"] }),
    );

    const { listTags } = await import("./registry");
    const tags = await listTags("myapp");

    expect(tags).toEqual(["v1", "v2", "latest"]);
  });

  it("returns [] on 404 (repo not found)", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ errors: [] }, 404),
    );

    const { listTags } = await import("./registry");
    const tags = await listTags("nonexistent");

    expect(tags).toEqual([]);
  });

  it("throws on unexpected status", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ errors: ["internal error"] }, 500),
    );

    const { listTags } = await import("./registry");

    await expect(listTags("myapp")).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// getManifest
// ---------------------------------------------------------------------------

describe("getManifest", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore?.();
    mock.restore();
  });

  it("returns manifest with digest from header on 200", async () => {
    const manifestBody = {
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    };

    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse(manifestBody, 200, {
        "Docker-Content-Digest": "sha256:abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd",
      }),
    );

    const { getManifest } = await import("./registry");
    const m = await getManifest("myapp", "latest");

    expect(m).not.toBeNull();
    expect(m?.digest).toBe("sha256:abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd");
    expect(m?.schemaVersion).toBe(2);
  });

  it("returns null on 404", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({}, 404),
    );

    const { getManifest } = await import("./registry");
    const m = await getManifest("myapp", "nonexistent");

    expect(m).toBeNull();
  });

  it("throws on 500", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({}, 500),
    );

    const { getManifest } = await import("./registry");

    await expect(getManifest("myapp", "latest")).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// deleteDigest
// ---------------------------------------------------------------------------

describe("deleteDigest", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore?.();
    mock.restore();
  });

  it("succeeds on 202 (accepted by registry)", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 202 }),
    );

    const { deleteDigest } = await import("./registry");

    // Should not throw.
    await expect(
      deleteDigest("myapp", "sha256:deadbeef"),
    ).resolves.toBeUndefined();
  });

  it("no-ops silently on 404", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404 }),
    );

    const { deleteDigest } = await import("./registry");

    await expect(
      deleteDigest("myapp", "sha256:doesnotexist"),
    ).resolves.toBeUndefined();
  });

  it("throws on unexpected error", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ error: "not allowed" }, 403),
    );

    const { deleteDigest } = await import("./registry");

    await expect(
      deleteDigest("myapp", "sha256:abc"),
    ).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// gcKeepLast
// ---------------------------------------------------------------------------

describe("gcKeepLast", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore?.();
    mock.restore();
  });

  it("returns empty array when tag count ≤ n", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ name: "myapp", tags: ["v1", "v2"] }),
    );

    const { gcKeepLast } = await import("./registry");
    const deleted = await gcKeepLast("myapp", 3);

    expect(deleted).toEqual([]);
  });

  it("deletes oldest tags when count > n (sorts by createdAt desc, keeps newest)", async () => {
    // We need to mock multiple fetch calls:
    // 1. listTags → ["v1", "v2", "v3", "v4"]
    // 2-5. getManifest for each tag (returns manifest + triggers config blob fetch)
    // 6-7. deleteDigest for the 2 oldest

    const manifests: Record<string, { digest: string; created: string }> = {
      v1: { digest: "sha256:" + "a".repeat(64), created: "2024-01-01T00:00:00Z" },
      v2: { digest: "sha256:" + "b".repeat(64), created: "2024-02-01T00:00:00Z" },
      v3: { digest: "sha256:" + "c".repeat(64), created: "2024-03-01T00:00:00Z" },
      v4: { digest: "sha256:" + "d".repeat(64), created: "2024-04-01T00:00:00Z" },
    };

    const callCount = { n: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      callCount.n++;

      // listTags
      if (url.includes("/tags/list")) {
        return makeResponse({ name: "myapp", tags: ["v1", "v2", "v3", "v4"] });
      }

      // DELETE
      if (url.includes("/manifests/sha256:") && url.match(/sha256:[a-f0-9]{64}/)) {
        return new Response(null, { status: 202 });
      }

      // getManifest — match /manifests/v1, /manifests/v2 etc.
      for (const [tag, m] of Object.entries(manifests)) {
        if (url.includes(`/manifests/${tag}`)) {
          return makeResponse(
            {
              schemaVersion: 2,
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              config: {
                digest: `sha256:config${tag}`,
                mediaType: "application/vnd.docker.container.image.v1+json",
              },
            },
            200,
            { "Docker-Content-Digest": m.digest },
          );
        }
      }

      // config blob fetch
      for (const [tag, m] of Object.entries(manifests)) {
        if (url.includes(`/blobs/sha256:config${tag}`)) {
          return makeResponse({ created: m.created });
        }
      }

      return makeResponse({}, 404);
    }) as unknown as typeof fetch);

    const { gcKeepLast } = await import("./registry");
    const deleted = await gcKeepLast("myapp", 2);

    // Should have deleted 2 oldest: v1 (Jan) and v2 (Feb)
    expect(deleted).toHaveLength(2);
    expect(deleted).toContain("sha256:" + "a".repeat(64));
    expect(deleted).toContain("sha256:" + "b".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// diskGuard
// ---------------------------------------------------------------------------

describe("diskGuard", () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    spawnSpy?.mockRestore?.();
    mock.restore();
  });

  it("does not throw when disk usage is below threshold", async () => {
    const enc = new TextEncoder();
    const dfOutput = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000 30000 70000 30% /\n";

    spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: new ReadableStream({ start(c) { c.enqueue(enc.encode(dfOutput)); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>);

    const { diskGuard } = await import("./registry");

    await expect(diskGuard(80)).resolves.toBeUndefined();
  });

  it("throws when disk usage meets or exceeds threshold", async () => {
    const enc = new TextEncoder();
    const dfOutput = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000 85000 15000 85% /\n";

    spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: new ReadableStream({ start(c) { c.enqueue(enc.encode(dfOutput)); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>);

    const { diskGuard } = await import("./registry");

    await expect(diskGuard(80)).rejects.toThrow(/85%.*above threshold/);
  });

  it("does not throw when df fails (graceful degradation)", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(1), // df failure
    } as unknown as ReturnType<typeof Bun.spawn>);

    const { diskGuard } = await import("./registry");

    // diskUsagePct returns 0 on df failure → no throw
    await expect(diskGuard(80)).resolves.toBeUndefined();
  });
});

describe("deleteRepository", () => {
  afterEach(() => mock.restore());

  it("deletes all manifests including latest and undated tags once per digest", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url,
      init
    ) => {
      if (String(url).includes("tags/list"))
        return makeResponse({ tags: ["latest", "old"] });
      if (init?.method === "DELETE") return makeResponse({}, 202);
      return makeResponse({ schemaVersion: 2 }, 200, {
        "Docker-Content-Digest": digest,
      });
    }) as typeof fetch);
    const { deleteRepository } = await import("./registry");
    expect(await deleteRepository("app-demo")).toEqual({
      tagsDeleted: 2,
      errors: [],
    });
    const deletes = fetchSpy.mock.calls.filter(
      ([, init]) => init?.method === "DELETE"
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]?.[0])).toEndWith(
      `/v2/app-demo/manifests/${digest}`
    );
    expect(
      fetchSpy.mock.calls.every(([url]) =>
        String(url).includes("/v2/app-demo/")
      )
    ).toBeTrue();
  });

  it("reports unresolved digests and DELETE failures and still deletes other manifests", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url,
      init
    ) => {
      const target = String(url);
      if (target.includes("tags/list"))
        return makeResponse({ tags: ["missing-digest", "blocked", "good"] });
      if (init?.method === "DELETE")
        return makeResponse({}, target.endsWith("b".repeat(64)) ? 405 : 202);
      const tag = target.split("/").at(-1);
      return makeResponse(
        { schemaVersion: 2 },
        200,
        tag === "missing-digest"
          ? {}
          : {
              "Docker-Content-Digest": `sha256:${(tag === "blocked" ? "b" : "c").repeat(64)}`,
            }
      );
    }) as typeof fetch);
    const { deleteRepository } = await import("./registry");
    const result = await deleteRepository("app-demo");
    expect(result.tagsDeleted).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join(";")).toContain(
      "missing or invalid Docker-Content-Digest"
    );
    expect(result.errors.join(";")).toContain("405");
    expect(
      fetchSpy.mock.calls.filter(([, init]) => init?.method === "DELETE")
    ).toHaveLength(2);
  });

  it("follows registry tag pagination", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeResponse({ tags: ["a"] }, 200, {
          Link: '</v2/app-demo/tags/list?n=1&last=a>; rel="next"',
        })
      )
      .mockResolvedValueOnce(makeResponse({ tags: ["b"] }));
    const { listTags } = await import("./registry");
    expect(await listTags("app-demo")).toEqual(["a", "b"]);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toEndWith(
      "/v2/app-demo/tags/list?n=1&last=a"
    );
  });
});
