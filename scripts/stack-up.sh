#!/bin/sh
# Bring the whole stack up (db, web, worker). The modules the repository carries under modules/ are copied into the
# container's module volume first when they are not there yet, so a database that says "installed" never meets an empty
# volume. Packages already in the volume are never overwritten: upgrading is done from the Apps screen.
#   WEB_PORT=3010 npm run stack:up        (WEB_PORT: the host port of the web app, default 3000)
set -eu
cd "$(dirname "$0")/.."

docker compose --profile app build

if [ -d modules ]; then
  docker compose --profile app run --rm --no-deps -T --no-TTY \
    -v "$PWD/modules:/seed:ro" --entrypoint sh web -c '
      for dir in /seed/*/; do
        [ -f "${dir}manifest.json" ] || continue
        id=$(basename "$dir")
        if [ ! -e "/app/modules/$id" ]; then
          cp -R "$dir" "/app/modules/$id"
          echo "seeded module $id"
        fi
      done'
fi

docker compose --profile app up -d
