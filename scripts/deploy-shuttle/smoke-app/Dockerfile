# Reference app for the post-deploy smoke test (scripts/deploy-shuttle/smoke.ts).
# It reproduces what broke real deploys: a slim image without curl or wget, a
# Dockerfile ARG without default that must come from a build variable, and a
# non-root process that writes to /tmp.
FROM node:22-bookworm-slim
ARG SMOKE_BUILD_TOKEN
RUN test -n "$SMOKE_BUILD_TOKEN"
ENV SMOKE_BUILD_TOKEN=$SMOKE_BUILD_TOKEN
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
