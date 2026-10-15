# SPDX-License-Identifier: AGPL-3.0-only
# Production image for the Ploydok web control-plane (TanStack Start/Nitro).
# Build context must be the monorepo root.
#   docker build -f apps/web/Dockerfile -t ghcr.io/makfly/ploydok-web:0.0.1 .

FROM oven/bun:1.3-debian AS builder
WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web ./apps/web
COPY packages ./packages

RUN bun install --frozen-lockfile
RUN bun run --cwd apps/web build
RUN set -eux; \
    public_css="$(find apps/web/.output/public/assets -maxdepth 1 -type f -name 'globals-*.css' -printf '%f\n' | head -n 1)"; \
    test -n "$public_css"; \
    find apps/web/.output/server -type f -name '*.mjs' \
      -exec sed -i -E "s#/assets/globals-[A-Za-z0-9_-]+\\.css#/assets/${public_css}#g" {} +

FROM oven/bun:1.3-debian AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLOYDOK_API_URL=http://api:3335

COPY --from=builder /app/apps/web/.output ./.output

EXPOSE 3000

USER bun
CMD ["bun", ".output/server/index.mjs"]
