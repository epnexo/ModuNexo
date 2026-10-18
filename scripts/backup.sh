#!/usr/bin/env bash
# Save everything the platform needs to come back: the database, the installed modules and the received packages.
#
#   scripts/backup.sh [--out <dir>] [--database-url <url>] [--modules-dir <dir>] [--data-dir <dir>]
#
# Writes <out>/epnexo-backup-<UTC time>/ (default <repo>/backups) with database.dump, modules.tar.gz,
# packages.tar.gz, SHA256SUMS and BACKUP_INFO. The folder and its files are readable by you only: the dump holds
# every password hash and every encrypted secret.
#
# NOT in the backup, on purpose: EPNEXO_MASTER_KEY and your .env. Stored secrets are encrypted with that key, so keep
# it somewhere else (a password manager); a restore without it works, but the stored secrets have to be typed again.
set -euo pipefail
umask 077
# shellcheck source=pg-tools.sh
source "$(dirname "${BASH_SOURCE[0]}")/pg-tools.sh"

usage() {
  echo "usage: scripts/backup.sh [--out <dir>] [--database-url <url>] [--modules-dir <dir>] [--data-dir <dir>]"
  echo "Saves the database, the installed modules and the received packages. EPNEXO_MASTER_KEY is not saved: keep it elsewhere."
}

out="$PG_ROOT/backups"
url="${DATABASE_URL:-}"
modules="$PG_ROOT/modules"
data="${EPNEXO_DATA_DIR:-$PG_ROOT/var}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:?--out needs a directory}"; shift 2 ;;
    --database-url) url="${2:?--database-url needs a value}"; shift 2 ;;
    --modules-dir) modules="${2:?--modules-dir needs a directory}"; shift 2 ;;
    --data-dir) data="${2:?--data-dir needs a directory}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$url" ] || { echo "error: DATABASE_URL is not set (or pass --database-url)" >&2; exit 2; }
[ -d "$modules" ] || fail "modules directory $modules does not exist"

dir="$out/epnexo-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
mkdir "$dir" || fail "$dir already exists; wait a second and run again"
ok=0
trap 'if [ "$ok" != 1 ]; then rm -rf "$dir"; fi' EXIT

PG_MODE_CACHE="$(pg_mode)"
pg_dump_db "$url" > "$dir/database.dump"
[ -s "$dir/database.dump" ] || fail "the database dump is empty"
tar -czf "$dir/modules.tar.gz" -C "$modules" --exclude=node_modules --exclude=.next .
if [ -d "$data/packages" ]; then tar -czf "$dir/packages.tar.gz" -C "$data" packages; else tar -czf "$dir/packages.tar.gz" -T /dev/null; fi

{
  echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "database: $(db_part "$url" name)"
  echo "commit: $(git -C "$PG_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "note: EPNEXO_MASTER_KEY is not included. Keep it elsewhere; stored secrets are encrypted with it."
} > "$dir/BACKUP_INFO"
(cd "$dir" && sha256sum database.dump modules.tar.gz packages.tar.gz BACKUP_INFO > SHA256SUMS)
ok=1
echo "backup written to $dir"
