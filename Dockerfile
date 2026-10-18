# The modunexo web app. Build: docker build -t modunexo-web .   Run it through docker-compose.yml (it needs the database).
#
# The image keeps the whole workspace and its dev dependencies on purpose: installing a module from the Apps screen
# rebuilds the web app inside the running container. Modules and received packages live in volumes, not in the image.
FROM node:22-bookworm-slim

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
# No database exists at image build time, so the image carries the empty module registry (a fresh install has no
# modules). After restoring a backup with modules, run `npm run web:build` inside the container.
ARG WEB_PUBLIC_URL=
ENV WEB_PUBLIC_URL=${WEB_PUBLIC_URL}
RUN node --import tsx apps/web/scripts/ensure-registry.ts \
    && cd apps/web && node ../../node_modules/next/dist/bin/next build \
    && mkdir -p /app/var /app/modules \
    && chown -R node:node /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Migrations are idempotent, so every start brings the schema up to date before serving.
CMD ["sh", "-c", "npm run db:migrate && npm run web:start"]
