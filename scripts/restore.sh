#!/usr/bin/env bash
# Bring a backup made by backup.sh back, into an EMPTY database and empty folders.
#
#   scripts/restore.sh <backup-dir> [--database-url <url>] [--modules-dir <dir>] [--data-dir <dir>]
#
# Refuses, before changing anything, a backup whose files do not match SHA256SUMS, a database that already has
# tables, and a modules folder that already holds modules. It never overwrites. The database must already exist
# (create it empty first).
#
# After a restore on a new machine: copy your .env (with the SAME EPNEXO_MASTER_KEY), then
#   npm install && npm run registry:generate && npm run web:build
# so the restored modules are linked and the web app is built with them.
set -euo pipefail
umask 077
# shellcheck source=pg-tools.sh
source "$(dirname "${BASH_SOURCE[0]}")/pg-tools.sh"

usage() {
  echo "usage: scripts/restore.sh <backup-dir> [--database-url <url>] [--modules-dir <dir>] [--data-dir <dir>]"
  echo "Restores a backup made by backup.sh into an empty database and empty folders; it never overwrites."
}

backup=""
url="${DATABASE_URL:-}"
modules="$PG_ROOT/modules"
data="${EPNEXO_DATA_DIR:-$PG_ROOT/var}"
while [ $# -gt 0 ]; do
  case "$1" in
    --database-url) url="${2:?--database-url needs a value}"; shift 2 ;;
    --modules-dir) modules="${2:?--modules-dir needs a directory}"; shift 2 ;;
    --data-dir) data="${2:?--data-dir needs a directory}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *) [ -z "$backup" ] || { usage >&2; exit 2; }; backup="$1"; shift ;;
  esac
done
[ -n "$backup" ] || { usage >&2; exit 2; }
[ -n "$url" ] || { echo "error: DATABASE_URL is not set (or pass --database-url)" >&2; exit 2; }
[ -d "$backup" ] || fail "$backup is not a backup folder"

# Every check first; nothing is touched until all of them pass.
(cd "$backup" && sha256sum --quiet -c SHA256SUMS) || fail "the backup does not match its SHA256SUMS: it is damaged or was edited"
tables="$(pg_scalar "$url" "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")" ||
  fail "cannot reach the database $(db_part "$url" name); create it empty first"
[ "$tables" = 0 ] || fail "the database $(db_part "$url" name) already has $tables tables; restore only into an empty one"
if [ -d "$modules" ] && [ -n "$(find "$modules" -mindepth 1 -maxdepth 1 ! -name .gitkeep -print -quit)" ]; then
  fail "$modules already holds modules; restore only into an empty folder"
fi
if [ -d "$data/packages" ] && [ -n "$(find "$data/packages" -mindepth 1 -print -quit)" ]; then
  fail "$data/packages already holds packages; restore only into an empty folder"
fi

PG_MODE_CACHE="$(pg_mode)"
pg_restore_db "$url" < "$backup/database.dump" || fail "the database restore stopped at an error; drop and recreate the database, then run again"
mkdir -p "$modules" "$data"
tar -xzf "$backup/modules.tar.gz" -C "$modules"
tar -xzf "$backup/packages.tar.gz" -C "$data"
echo "restored $(cat "$backup/BACKUP_INFO" | head -n 1) into $(db_part "$url" name)"
echo "next: copy your .env (same EPNEXO_MASTER_KEY), then: npm install && npm run registry:generate && npm run web:build"
