# SPDX-License-Identifier: AGPL-3.0-only
# Production image for the Ploydok API (Bun runtime).
# Build context must be the monorepo root.
#   docker build -f apps/api/Dockerfile -t ghcr.io/makfly/ploydok-api:0.0.1 .

FROM oven/bun:1-debian AS dependencies
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libsecret-1-dev \
      python3 \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY apps/api ./apps/api
COPY apps/web/package.json ./apps/web/package.json
COPY packages ./packages

# chmod: COPY keeps the host file modes and the read bit is not versioned, so a
# 0600 source file would be unreadable by the non-root runtime user.
# Filter out web/UI runtime dependencies too: their production graph includes
# bundlers. Boot migrations use drizzle-orm and the checked-in SQL files.
RUN bun install --frozen-lockfile --production --filter '@ploydok/*' \
 && chmod -R a+rX /app/apps /app/packages \
 && rm -rf /root/.bun/install/cache /app/apps/web /app/packages/ui \
 && test -z "$(find /app/node_modules -type f -name esbuild -print -quit)"

FROM moby/buildkit:v0.29.0-rootless AS buildkit

FROM debian:bookworm-slim AS nixpacks
ARG TARGETARCH
ARG NIXPACKS_VERSION=1.41.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in \
      amd64) artifact="nixpacks-v${NIXPACKS_VERSION}-x86_64-unknown-linux-gnu.tar.gz"; checksum="194bcad8c379f78a309eee1a88b2e6b2abc59f354efe7ecd7b4bbaf21de99a06" ;; \
      arm64) artifact="nixpacks-v${NIXPACKS_VERSION}-aarch64-unknown-linux-musl.tar.gz"; checksum="912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39" ;; \
      *) echo "unsupported Nixpacks architecture: $TARGETARCH" >&2; exit 2 ;; \
    esac \
 && curl -fsSL --retry 3 \
      "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/${artifact}" \
      -o /tmp/nixpacks.tar.gz \
 && echo "${checksum}  /tmp/nixpacks.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin nixpacks \
 && chmod 0755 /usr/local/bin/nixpacks

FROM oven/bun:1-debian AS runtime
ARG PLOYDOK_BUILD_VERSION=dev
WORKDIR /app

RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      libsecret-1-0 \
      tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=prod \
    PORT=3335 \
    PLOYDOK_BUILD_VERSION=${PLOYDOK_BUILD_VERSION}

COPY --from=buildkit /usr/bin/buildctl /usr/local/bin/buildctl
COPY --from=nixpacks /usr/local/bin/nixpacks /usr/local/bin/nixpacks
COPY --from=dependencies /app /app

EXPOSE 3335

WORKDIR /app/apps/api
USER bun
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
