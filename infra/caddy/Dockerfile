# Caddy custom build with DNS-01 provider modules (xcaddy).
# Required for wildcard TLS certificates via DNS challenge.
# To rebuild after changing modules: make infra-down && make infra-up
#
# Pinned to Caddy 2.11 because caddy-l4 v0.1.x requires Caddy >= 2.11.1.
#
# Module versions are pinned: an unpinned `--with` resolves the latest release
# on every cache miss, so the same source produced a different binary, a new
# image digest and a Caddy restart (a traffic drop) on each deploy. Bump them
# here, on purpose. Base images stay on the 2.11 tags to receive upstream fixes.
FROM caddy:2.11-builder AS builder

RUN xcaddy build \
  --with github.com/mholt/caddy-l4@v0.1.2 \
  --with github.com/mholt/caddy-ratelimit@v0.1.0 \
  --with github.com/caddyserver/cache-handler@v0.17.0 \
  --with github.com/ueffel/caddy-brotli@v1.6.0 \
  --with github.com/ueffel/caddy-imagefilter/resize@v1.3.0 \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --with github.com/caddy-dns/route53@v1.6.2 \
  --with github.com/caddy-dns/ovh@v1.1.0 \
  --with github.com/caddy-dns/digitalocean@v0.0.0-20250606074528-04bde2867106

FROM caddy:2.11-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
