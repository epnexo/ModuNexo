# The modunexo web app. Build: docker build -t modunexo-web .   Run it through docker-compose.yml (it needs the database).
#
# The image keeps the whole workspace and its dev dependencies on purpose: installing a module from the Apps screen
# rebuilds the web app inside the running container. Modules and received packages live in volumes, not in the image.
FROM node:25-bookworm-slim

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    MODUNEXO_DATA_DIR=/app/var \
    WEB_HOST=0.0.0.0

WORKDIR /app

# The lockfile is the source of versions.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY modules modules
RUN npm ci --include=dev

COPY apps apps
COPY packages packages
COPY scripts/docker-entrypoint.sh scripts/docker-entrypoint.sh
# Routes written on the build machine for its installed modules carry the generator's header and import the registry of
# that machine, which the image does not have. Drop them so the image starts from the platform alone, whatever modules the
# source tree was running; modules installed later regenerate their own routes.
RUN grep -rlE --include='*.ts' --include='*.tsx' -e 'GENERATED FILE - DO NOT EDIT' apps/web/src/app | xargs -r rm -f \
    && find apps/web/src/app -type d -empty -delete
# No database exists at image build time, so the image carries the empty module registry (a fresh install has no
# modules). The entrypoint rebuilds for the modules in the volume the first time a container starts with them.
ARG WEB_PUBLIC_URL=
ENV WEB_PUBLIC_URL=${WEB_PUBLIC_URL}
RUN node --import tsx apps/web/scripts/ensure-registry.ts \
    && cd apps/web && node ../../node_modules/next/dist/bin/next build \
    && mkdir -p /app/var /app/modules \
    && chown -R node:node /app

USER node
EXPOSE 3000
# The start period covers the one-time build of the web app for the modules in the volume (minutes on a small host).
HEALTHCHECK --interval=15s --timeout=5s --start-period=900s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The entrypoint links the modules, applies the migrations (idempotent), writes the registration and builds the web app
# when the modules changed, then serves. See scripts/docker-entrypoint.sh.
CMD ["sh", "scripts/docker-entrypoint.sh"]
