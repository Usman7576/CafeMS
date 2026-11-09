# CafeMS production image.
# Stage 1 installs production packages only. The final image is Google's distroless Node image: it has
# no shell, no package manager, no npm and none of the usual system tools, so there is very little for
# an attacker to use and very little for scanners to flag. It runs as an unprivileged user (65532), and
# the container is started with a read-only file system (see deploy/docker-compose.yml).
# Base images are pinned by digest so a changed upstream image cannot slip in; Dependabot updates them.

FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs exactly the locked versions and checks their integrity hashes
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Writable folders are prepared here, because the final image has no shell to create them
RUN mkdir -p /out/data/uploads /out/backups && chown -R 65532:65532 /out

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
# The code is owned by root and read-only to the app; only the upload folder is writable
COPY --from=deps --chown=0:0 /app/node_modules ./node_modules
COPY --chown=0:0 package.json ./
COPY --chown=0:0 server ./server
COPY --chown=0:0 public ./public
COPY --chown=0:0 scripts ./scripts
COPY --chown=0:0 docs/security ./docs/security
COPY --from=deps --chown=65532:65532 /out/data /data
COPY --from=deps --chown=65532:65532 /out/backups /backups
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# The image's entrypoint is node; commands such as the backup pass only the script and its arguments
CMD ["server/index.js"]
