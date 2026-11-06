#!/bin/sh
# Start of the web container. The image carries the platform with an empty module registry; the modules live in the
# /app/modules volume. Before serving, this brings the container in line with what the database says is installed:
#   1. link every module package as @local/<id> (the workspace links `npm ci` would have made, which the image cannot
#      have because modules/ is not part of it);
#   2. apply the migrations and write the registration (routes and registry) for the enabled modules;
#   3. rebuild the web app, but only when the modules or their registration changed since the last build, so a plain
#      restart is quick and a new container (or a module added to the volume) builds once.
set -eu
cd /app

log() { echo "entrypoint: $*"; }

mkdir -p node_modules/@local
for dir in modules/*/; do
  [ -f "${dir}manifest.json" ] || continue
  id=$(basename "$dir")
  ln -sfn "../../modules/$id" "node_modules/@local/$id"
done
# A link whose module left the volume points nowhere and would break the bundler.
for link in node_modules/@local/*; do
  [ -L "$link" ] && [ ! -e "$link" ] && rm -f "$link"
done

npm run --silent db:migrate
npm run --silent registry:generate > /dev/null

if npm run --silent modules -- list 2> /dev/null | grep -q orphaned; then
  log "warning: a module is installed in the database but its package is not in /app/modules (see 'modules list'). Copy the package into the volume, or run 'npm run stack:up' from the repository, which seeds it."
fi

stamp=apps/web/.next/.registry-stamp
current=$(cat modules/*/manifest.json apps/web/src/generated/.manifest.json 2> /dev/null | sha256sum | cut -d' ' -f1)
if [ ! -f apps/web/.next/BUILD_ID ] || [ "$(cat "$stamp" 2> /dev/null)" != "$current" ]; then
  log "the modules changed since the last build: building the web app (a few minutes)"
  npm run --silent web:build
  echo "$current" > "$stamp"
fi

exec npm run --silent web:start
