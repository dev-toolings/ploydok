// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for buildImage().
 *
 * buildctl is not available in the test environment, so we mock
 * `Bun.spawn` via a spy to test the command construction, log streaming,
 * digest parsing, and error handling without actually running BuildKit.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake process that yields the given stdout/stderr lines and exits. */
function fakeBunProcess(opts: {
  stdoutLines?: string[];
  stderrLines?: string[];
  exitCode?: number;
}) {
  const stdoutText = (opts.stdoutLines ?? []).join("\n") + (opts.stdoutLines?.length ? "\n" : "");
  const stderrText = (opts.stderrLines ?? []).join("\n") + (opts.stderrLines?.length ? "\n" : "");
  const enc = new TextEncoder();

  function makeStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        if (text) controller.enqueue(enc.encode(text));
        controller.close();
      },
    });
  }

  return {
    stdout: makeStream(stdoutText),
    stderr: makeStream(stderrText),
    exited: Promise.resolve(opts.exitCode ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildImage", () => {
  let tmpDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ploydok-buildkit-test-"));
  });

  afterEach(async () => {
    spawnSpy?.mockRestore?.();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("calls buildctl with correct flags on success", async () => {
    const controller = new AbortController();
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stderrLines: [
          "#1 [internal] load .dockerignore",
          "#5 exporting to image",
          "#5 pushing manifest for 127.0.0.1:5000/app-abc:sha sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        ],
      }) as ReturnType<typeof Bun.spawn>,
    );

    const { buildImage } = await import("./buildkit");

    const result = await buildImage({
      contextDir: tmpDir,
      dockerfile: path.join(tmpDir, "Dockerfile"),
      imageRef: "127.0.0.1:5000/app-abc:sha",
      cacheDir: path.join(tmpDir, "cache"),
      signal: controller.signal,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnMock = spawnSpy as unknown as { mock: { calls: Array<[string[], object]> } };
    const firstCall = spawnMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const cmd = firstCall![0];
    expect(firstCall![1]).toMatchObject({ signal: controller.signal });
    expect(cmd[0]).toBe("buildctl");
    expect(cmd).toContain("build");
    expect(cmd).toContain("--frontend");
    expect(cmd).toContain("dockerfile.v0");
    expect(cmd).toContain("--output");
    // Check push=true is in the output option
    const outputIdx = cmd.indexOf("--output");
    expect(cmd[outputIdx + 1]).toContain("push=true");
    expect(cmd[outputIdx + 1]).toContain("127.0.0.1:5000/app-abc:sha");

    expect(result.imageDigest).toBe(
      "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("builds through Docker buildx when the address names a builder", async () => {
    const digest =
      "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
      const metadata = cmd[cmd.indexOf("--metadata-file") + 1]!;
      writeFileSync(metadata, JSON.stringify({ "containerimage.digest": digest }));
      return fakeBunProcess({
        stderrLines: [
          "#9 exporting manifest sha256:2222222222222222222222222222222222222222222222222222222222222222",
        ],
      });
    }) as unknown as typeof Bun.spawn);

    // env is typed read-only; tests swap the address and restore it.
    const env = (await import("../env")).env as { PLOYDOK_BUILDKIT_ADDR: string };
    const previous = env.PLOYDOK_BUILDKIT_ADDR;
    env.PLOYDOK_BUILDKIT_ADDR = "buildx://ploydok-dev";
    try {
      const { buildImage } = await import("./buildkit");
      const result = await buildImage({
        contextDir: tmpDir,
        dockerfile: path.join(tmpDir, "Dockerfile"),
        imageRef: "127.0.0.1:5000/app-abc:sha",
        cacheDir: path.join(tmpDir, "cache"),
        buildArgs: { NODE_ENV: "production" },
      });

      const spawnMock = spawnSpy as unknown as {
        mock: { calls: Array<[string[], object]> };
      };
      const cmd = spawnMock.mock.calls[0]![0];
      expect(cmd.slice(0, 5)).toEqual([
        "docker",
        "buildx",
        "build",
        "--builder",
        "ploydok-dev",
      ]);
      expect(cmd).toContain("--push");
      expect(cmd[cmd.indexOf("--tag") + 1]).toBe("127.0.0.1:5000/app-abc:sha");
      expect(cmd[cmd.indexOf("--build-arg") + 1]).toBe("NODE_ENV=production");
      expect(cmd.at(-1)).toBe(tmpDir);
      expect(result.imageDigest).toBe(digest);
    } finally {
      env.PLOYDOK_BUILDKIT_ADDR = previous;
    }
  });

  it("streams all log lines via onLog callback", async () => {
    const lines = [
      "#1 [internal] load build definition",
      "#2 [1/3] FROM node:20",
      "#3 [2/3] RUN npm install",
    ];
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({ stderrLines: lines }) as ReturnType<typeof Bun.spawn>,
    );

    const { buildImage } = await import("./buildkit");
    const captured: string[] = [];

    await buildImage({
      contextDir: tmpDir,
      dockerfile: path.join(tmpDir, "Dockerfile"),
      imageRef: "127.0.0.1:5000/app-test:latest",
      cacheDir: path.join(tmpDir, "cache"),
      onLog: (line) => captured.push(line),
    });

    for (const line of lines) {
      expect(captured).toContain(line);
    }
  });

  it("throws if buildctl exits with non-zero code", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stderrLines: ["Error: failed to solve: failed to fetch"],
        exitCode: 1,
      }) as ReturnType<typeof Bun.spawn>,
    );

    const { buildImage } = await import("./buildkit");

    await expect(
      buildImage({
        contextDir: tmpDir,
        dockerfile: path.join(tmpDir, "Dockerfile"),
        imageRef: "127.0.0.1:5000/app-fail:sha",
        cacheDir: path.join(tmpDir, "cache"),
      }),
    ).rejects.toThrow(/buildctl failed \(exit 1\)/);
  });

  it("falls back to sha256:unknown when no digest in output", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({
        stderrLines: ["build complete — no digest line here"],
      }) as ReturnType<typeof Bun.spawn>,
    );

    const { buildImage } = await import("./buildkit");

    const result = await buildImage({
      contextDir: tmpDir,
      dockerfile: path.join(tmpDir, "Dockerfile"),
      imageRef: "127.0.0.1:5000/app-nodigest:sha",
      cacheDir: path.join(tmpDir, "cache"),
    });

    expect(result.imageDigest).toBe("sha256:unknown");
  });

  it("creates cacheDir if it does not exist", async () => {
    const cacheDir = path.join(tmpDir, "nested", "cache");
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>,
    );

    const { buildImage } = await import("./buildkit");

    // Should not throw even though nested/cache doesn't exist yet.
    await buildImage({
      contextDir: tmpDir,
      dockerfile: path.join(tmpDir, "Dockerfile"),
      imageRef: "127.0.0.1:5000/app-cache:sha",
      cacheDir,
    });

    const { stat } = await import("node:fs/promises");
    const s = await stat(cacheDir);
    expect(s.isDirectory()).toBe(true);
  });

  it("includes --import-cache and --export-cache flags", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>,
    );

    const { buildImage } = await import("./buildkit");

    await buildImage({
      contextDir: tmpDir,
      dockerfile: path.join(tmpDir, "Dockerfile"),
      imageRef: "127.0.0.1:5000/app-cache:sha",
      cacheDir: path.join(tmpDir, "cache"),
    });

    const spawnMock2 = spawnSpy as unknown as { mock: { calls: Array<[string[]]> } };
    const firstCall2 = spawnMock2.mock.calls[0];
    expect(firstCall2).toBeDefined();
    const cmd = firstCall2![0];
    expect(cmd).toContain("--export-cache");
    expect(cmd).toContain("--import-cache");
    const exportIdx = cmd.indexOf("--export-cache");
    expect(cmd[exportIdx + 1]).toContain("type=local");
    expect(cmd[exportIdx + 1]).toContain("mode=max");
  });

  it("forwards build args and BuildKit secrets", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      fakeBunProcess({}) as ReturnType<typeof Bun.spawn>,
    );

    const { buildImage } = await import("./buildkit");

    await buildImage({
      contextDir: tmpDir,
      dockerfile: path.join(tmpDir, "Dockerfile"),
      imageRef: "127.0.0.1:5000/app-build-env:sha",
      cacheDir: path.join(tmpDir, "cache"),
      buildArgs: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
      buildSecrets: { INTERNAL_TOKEN: "super-secret" },
    });

    const spawnMock = spawnSpy as unknown as { mock: { calls: Array<[string[]]> } };
    const cmd = spawnMock.mock.calls[0]![0];
    expect(cmd).toContain("--opt");
    expect(cmd).toContain("build-arg:NEXT_PUBLIC_API_URL=https://api.example.com");
    expect(cmd).toContain("--secret");
    const secretIdx = cmd.indexOf("--secret");
    expect(cmd[secretIdx + 1]).toContain("id=INTERNAL_TOKEN,src=");
  });
});
