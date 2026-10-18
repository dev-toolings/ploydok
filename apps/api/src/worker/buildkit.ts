// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BuildKit wrapper.
 *
 * Invokes `buildctl` to build a Dockerfile and push the image to a registry.
 * Streams stderr line-by-line via the `onLog` callback.
 *
 * Local development can instead point `PLOYDOK_BUILDKIT_ADDR` at a Docker
 * buildx builder (`buildx://<name>`), the route Dokploy and Coolify take: the
 * Docker CLI drives BuildKit, so the host needs neither `buildctl` nor a
 * rootless daemon, which recent Ubuntu AppArmor policies refuse to start.
 */
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parseDockerfileArgs, requiredDockerfileArgs } from "@ploydok/shared";
import type { DockerfileArg } from "@ploydok/shared";
import { env } from "../env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildImageOptions {
  /** Absolute path to the build context directory. */
  contextDir: string;
  /** Absolute path to the Dockerfile (must reside within contextDir). */
  dockerfile: string;
  /** Full image reference including tag, e.g. `127.0.0.1:5000/app-abc123:sha`. */
  imageRef: string;
  /**
   * Directory used for BuildKit layer cache (--import-cache / --export-cache).
   * Created automatically if missing.
   */
  cacheDir: string;
  /** Build args forwarded to the Dockerfile frontend. */
  buildArgs?: Record<string, string>;
  /**
   * Build secrets mounted via BuildKit `RUN --mount=type=secret,id=...`.
   * Keys the Dockerfile declares with `ARG` are also passed as build args.
   */
  buildSecrets?: Record<string, string>;
  /** Variables defined for the runtime phase only, never sent to the build. */
  runtimeOnlyEnvKeys?: readonly string[];
  /** Called for every log line emitted by buildctl on stdout/stderr. */
  onLog?: (line: string) => void;
  /** Cancels the active buildctl process on deploy cancellation/lease loss. */
  signal?: AbortSignal;
}

export interface BuildImageResult {
  /** OCI image digest, e.g. `sha256:…`. Parsed from buildctl output. */
  imageDigest: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

const BUILDX_SCHEME = "buildx://";
const FAILURE_TAIL_LINES = 200;
async function readDockerfileArgs(file: string): Promise<DockerfileArg[]> {
  try {
    return parseDockerfileArgs(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

/** Root cause of a failed BuildKit run, from its plain progress output. */
export function summarizeBuildFailure(lines: readonly string[]): string | null {
  const stripStep = (line: string) => line.replace(/^#\d+\s+(?:\d+\.\d+\s+)?/, "").trim();
  const errors = lines
    .map(stripStep)
    .filter((line) => /^ERROR:\s/.test(line))
    .map((line) =>
      line
        .replace(/^ERROR:\s+/, "")
        .replace(/^(?:failed to (?:build|solve):\s*)+/i, "")
    );
  const cause = errors.at(-1);
  if (!cause) return null;
  const location = lines.map(stripStep).find((line) => /^Dockerfile[^\s:]*:\d+$/.test(line));
  return location ? `${location}: ${cause}` : cause;
}

/** Builder name when the address selects Docker buildx, otherwise null. */
export function buildxBuilderName(addr: string): string | null {
  if (!addr.startsWith(BUILDX_SCHEME)) return null;
  const name = addr.slice(BUILDX_SCHEME.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`invalid buildx builder name in ${addr}`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a Docker image with BuildKit rootless and push it to the configured
 * local registry.
 *
 * Uses `buildctl` on PATH (installed inside the `moby/buildkit` image or the
 * host if buildkit-rootless is in use without a socket proxy).
 *
 * BuildKit socket: `PLOYDOK_BUILDKIT_ADDR` env var (default:
 * `docker-container://ploydok-buildkitd`).
 */
export async function buildImage(
  opts: BuildImageOptions
): Promise<BuildImageResult> {
  await mkdir(opts.cacheDir, { recursive: true });

  const addr = env.PLOYDOK_BUILDKIT_ADDR;

  // Resolve the Dockerfile directory (passed as --local dockerfile=<dir>).
  const dockerfileDir = path.dirname(opts.dockerfile);
  const dockerfileName = path.basename(opts.dockerfile);

  const builder = buildxBuilderName(addr);
  const declaredArgs = await readDockerfileArgs(opts.dockerfile);
  const buildArgs: Record<string, string> = {};
  for (const { name } of declaredArgs) {
    const value = opts.buildSecrets?.[name];
    if (value !== undefined) buildArgs[name] = value;
  }
  Object.assign(buildArgs, opts.buildArgs);
  const missingArgs = requiredDockerfileArgs(declaredArgs).filter(
    (name) => !buildArgs[name]
  );
  if (Object.keys(buildArgs).length > 0) {
    opts.onLog?.(`[build] build args: ${Object.keys(buildArgs).join(", ")}`);
  }
  const runtimeOnly = new Set(opts.runtimeOnlyEnvKeys ?? []);
  const runtimeOnlyArgs = missingArgs.filter((name) => runtimeOnly.has(name));
  const undefinedArgs = missingArgs.filter((name) => !runtimeOnly.has(name));
  const missingHint = [
    undefinedArgs.length > 0
      ? `no value for build args ${undefinedArgs.join(", ")}`
      : null,
    runtimeOnlyArgs.length > 0
      ? `${runtimeOnlyArgs.join(", ")} defined for the runtime phase only, set the phase to build or both`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  if (missingHint) {
    opts.onLog?.(
      `[build] WARNING: ${missingHint}${undefinedArgs.length > 0 ? "; define them in the app environment variables" : ""}`
    );
  }
  const metadataDir = builder
    ? await mkdtemp(path.join(os.tmpdir(), "ploydok-buildx-meta-"))
    : null;
  const metadataFile = metadataDir ? path.join(metadataDir, "meta.json") : null;
  // buildctl creates $HOME/.docker for registry auth; in production HOME is a
  // read-only root, so give it a throwaway config under the writable /tmp.
  const dockerConfigDir =
    !builder && !process.env["DOCKER_CONFIG"]
      ? await mkdtemp(path.join(os.tmpdir(), "ploydok-docker-config-"))
      : null;

  const args = builder
    ? [
        "buildx",
        "build",
        "--builder",
        builder,
        "--file",
        opts.dockerfile,
        "--tag",
        opts.imageRef,
        "--push",
        // Keep a single-platform manifest, like the buildctl path.
        "--provenance=false",
        "--cache-to",
        `type=local,dest=${opts.cacheDir},mode=max`,
        "--cache-from",
        `type=local,src=${opts.cacheDir}`,
        "--metadata-file",
        metadataFile!,
        "--progress",
        "plain",
      ]
    : [
        "--addr",
        addr,
        "build",
        "--frontend",
        "dockerfile.v0",
        "--opt",
        `filename=${dockerfileName}`,
        "--local",
        `context=${opts.contextDir}`,
        "--local",
        `dockerfile=${dockerfileDir}`,
        "--output",
        `type=image,name=${opts.imageRef},push=true`,
        "--export-cache",
        `type=local,dest=${opts.cacheDir},mode=max`,
        "--import-cache",
        `type=local,src=${opts.cacheDir}`,
        "--progress",
        "plain",
      ];

  for (const [key, value] of Object.entries(buildArgs)) {
    if (builder) args.push("--build-arg", `${key}=${value}`);
    else args.push("--opt", `build-arg:${key}=${value}`);
  }

  let secretDir: string | null = null;
  try {
    if (opts.buildSecrets && Object.keys(opts.buildSecrets).length > 0) {
      secretDir = await mkdtemp(
        path.join(os.tmpdir(), "ploydok-buildkit-secrets-")
      );
      for (const [key, value] of Object.entries(opts.buildSecrets)) {
        const secretPath = path.join(secretDir, key);
        await writeFile(secretPath, value, { mode: 0o600 });
        args.push("--secret", `id=${key},src=${secretPath}`);
      }
    }

    const startMs = Date.now();

    // buildx takes the build context as its last positional argument.
    if (builder) args.push(opts.contextDir);

    const proc = Bun.spawn([builder ? "docker" : "buildctl", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      ...(dockerConfigDir
        ? { env: { ...process.env, DOCKER_CONFIG: dockerConfigDir } }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    // Collect digest from output while streaming logs.
    let imageDigest = "";
    const tail: string[] = [];
    const remember = (line: string) => {
      tail.push(line);
      if (tail.length > FAILURE_TAIL_LINES) tail.shift();
    };

    async function pipeLines(
      stream: ReadableStream<Uint8Array>
    ): Promise<void> {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          // Try to parse the pushed digest from buildctl output.
          const digestMatch = line.match(/sha256:[a-f0-9]{64}/);
          if (digestMatch && !imageDigest) {
            imageDigest = digestMatch[0];
          }
          remember(line);
          opts.onLog?.(line);
        }
      }
      // Flush remaining content without trailing newline.
      if (buf) {
        const digestMatch = buf.match(/sha256:[a-f0-9]{64}/);
        if (digestMatch && !imageDigest) imageDigest = digestMatch[0];
        remember(buf);
        opts.onLog?.(buf);
      }
    }

    await Promise.all([
      pipeLines(proc.stdout as ReadableStream<Uint8Array>),
      pipeLines(proc.stderr as ReadableStream<Uint8Array>),
    ]);

    const code = await proc.exited;
    const durationMs = Date.now() - startMs;

    if (code !== 0) {
      const cause = summarizeBuildFailure(tail);
      const hint = missingHint ? ` (${missingHint})` : "";
      throw new Error(
        `${builder ? "docker buildx" : "buildctl"} failed (exit ${code})${
          cause ? `: ${cause}` : ` for image ${opts.imageRef}`
        }${hint}`
      );
    }

    if (metadataFile) {
      const digest = await readBuildxDigest(metadataFile);
      if (digest) imageDigest = digest;
    }

    // If we couldn't parse the digest from output, fall back to a placeholder
    // so callers can still proceed — the image was pushed successfully.
    if (!imageDigest) {
      imageDigest = "sha256:unknown";
    }

    return { imageDigest, durationMs };
  } finally {
    if (secretDir) {
      await rm(secretDir, { recursive: true, force: true });
    }
    if (metadataDir) {
      await rm(metadataDir, { recursive: true, force: true });
    }
    if (dockerConfigDir) {
      await rm(dockerConfigDir, { recursive: true, force: true });
    }
  }
}

async function readBuildxDigest(file: string): Promise<string | null> {
  try {
    const metadata = JSON.parse(await readFile(file, "utf8")) as {
      "containerimage.digest"?: unknown;
    };
    const digest = metadata["containerimage.digest"];
    return typeof digest === "string" && /^sha256:[a-f0-9]{64}$/.test(digest)
      ? digest
      : null;
  } catch {
    return null;
  }
}
