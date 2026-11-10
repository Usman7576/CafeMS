# Caddy with two modules added at build time:
# - Coraza, a web application firewall running the OWASP Core Rule Set, which blocks requests that look
#   like SQL injection, cross-site scripting, path traversal and similar attacks before the app sees them
# - caddy-ratelimit, which limits requests per address at the edge, before they reach the app
# Both base images and both modules are pinned, so the build is the same every time.
FROM caddy:2.11.9-builder-alpine@sha256:d26fbc8a56ed8c3c1534f5573162d148ad3ed41732665da8526eb181fac0b728 AS build
# No file capability on the binary: it runs unprivileged, and the container grants no capabilities
ENV XCADDY_SETCAP=0
RUN xcaddy build v2.11.9 \
    --with github.com/corazawaf/coraza-caddy/v2@v2.6.2 \
    --with github.com/mholt/caddy-ratelimit@5625512f24f6

FROM caddy:2-alpine@sha256:78bd35025c7ba85961dd149ae670315129954e77abe2383ac47c89106b35ade9
COPY --from=build /usr/bin/caddy /usr/bin/caddy
# Caddy runs as an unprivileged user. It may bind ports 80 and 443 because the container lowers the
# privileged-port limit for itself (see docker-compose.yml), so no capability is needed.
RUN mkdir -p /data/caddy /config/caddy && chown -R 1000:1000 /data /config
USER 1000:1000
