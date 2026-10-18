#!/usr/bin/env bash
# Shared by backup.sh and restore.sh. Runs the PostgreSQL client tools either from the PATH or, when they are not
# installed, inside the compose "db" service (docker compose exec), so neither script needs a database client on the host.
# Sourced, not executed.

PG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "error: $*" >&2
  exit 1
}

# direct: the client tools are on the PATH and talk to the URL. compose: run them inside the "db" service.
# The probe never reads standard input (a dump may be piped into the function that asked), and the answer is
# remembered by the callers through PG_MODE_CACHE.
pg_mode() {
  if [ -n "${PG_MODE_CACHE:-}" ]; then
    echo "$PG_MODE_CACHE"
    return
  fi
  if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
    echo direct
  elif command -v docker >/dev/null 2>&1 && docker compose -f "$PG_ROOT/docker-compose.yml" exec -T db true </dev/null >/dev/null 2>&1; then
    echo compose
  else
    fail "no PostgreSQL client tools on the PATH and the compose \"db\" service is not running (start it with: docker compose up -d db)"
  fi
}

db_part() { node -p 'const u = new URL(process.argv[1]); decodeURIComponent({ name: u.pathname.slice(1), user: u.username, host: u.hostname }[process.argv[2]])' "$1" "$2"; }

# The compose fallback only reaches the compose "db" service, so it must not silently stand in for another server.
compose_guard() {
  case "$(db_part "$1" host)" in
    127.0.0.1 | localhost | "[::1]" | db) ;;
    *) fail "the compose fallback only reaches its own db service, not $(db_part "$1" host); install the PostgreSQL client tools (pg_dump, pg_restore, psql) to use that server" ;;
  esac
}

compose_exec() { docker compose -f "$PG_ROOT/docker-compose.yml" exec -T db "$@"; }

# pg_dump_db <url>: a custom-format dump on stdout.
pg_dump_db() {
  if [ "$(pg_mode)" = direct ]; then pg_dump -Fc --no-owner "$1"; else compose_guard "$1"; compose_exec pg_dump -Fc --no-owner -U "$(db_part "$1" user)" "$(db_part "$1" name)"; fi
}

# pg_restore_db <url>: reads a custom-format dump on stdin into an existing, empty database. Stops at the first error.
pg_restore_db() {
  if [ "$(pg_mode)" = direct ]; then pg_restore --no-owner --exit-on-error -d "$1"; else compose_guard "$1"; compose_exec pg_restore --no-owner --exit-on-error -U "$(db_part "$1" user)" -d "$(db_part "$1" name)"; fi
}

# pg_scalar <url> <sql>: the single value a query returns.
pg_scalar() {
  if [ "$(pg_mode)" = direct ]; then psql -tA -v ON_ERROR_STOP=1 "$1" -c "$2"; else compose_guard "$1"; compose_exec psql -tA -v ON_ERROR_STOP=1 -U "$(db_part "$1" user)" -d "$(db_part "$1" name)" -c "$2"; fi
}
