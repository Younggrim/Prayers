#!/usr/bin/env bash
# Run the RLS privacy tests against a throwaway local Postgres (no Supabase needed).
# Requires Postgres 15+ server binaries (initdb, pg_ctl) on PATH or in /usr/lib/postgresql/*/bin.
#
#   scripts/test-rls-local.sh
#
# To test the real schema on Supabase instead, see the header of supabase/tests/rls_privacy_test.sql.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")"
tmp="$(mktemp -d)"
port="${PGTEST_PORT:-54399}"

if [ "$(id -u)" = "0" ]; then
  # Postgres refuses to run as root; use the postgres OS user if present.
  chown -R postgres "$tmp"
  run() { su postgres -s /bin/bash -c "$(printf '%q ' "$@")"; }
else
  run() { "$@"; }
fi

cleanup() {
  run "$bin/pg_ctl" -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

run "$bin/initdb" -D "$tmp/data" -U postgres -A trust >/dev/null
run "$bin/pg_ctl" -D "$tmp/data" -o "-p $port -k $tmp" -l "$tmp/log" -w start >/dev/null

psql_() { psql -h "$tmp" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql_ -f "$root/supabase/tests/local/stub_supabase.sql" >/dev/null
for f in "$root"/supabase/migrations/*.sql; do
  psql_ -f "$f" >/dev/null
done
psql_ -f "$root/supabase/tests/rls_privacy_test.sql"
