#!/bin/bash
# Weekly Upheld database backup for a Mac. Installed and scheduled by install-mac.sh; you don't run
# this from the repo. It reads its settings from ~/.config/upheld-backup/config and the database
# password from the macOS Keychain (item "upheld-db-password"), so no secret lives in any file.
#
# Each run writes ~/Upheld Backups/upheld-YYYY-MM-DD_HHMM.tar.gz containing:
#   public.sql       the app's tables and data (groups, members, lists, prayers, ...)
#   auth-users.sql   the sign-in accounts those rows point to (auth.users, auth.identities)
# and keeps the newest $KEEP backups. Backups hold real prayer data: never copy them into the repo.
set -euo pipefail

conf="$HOME/.config/upheld-backup/config"
# shellcheck source=/dev/null
. "$conf"   # sets PG_DUMP, DB_URL, BACKUP_DIR, KEEP

log="$BACKUP_DIR/backup.log"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
work="$(mktemp -d)"

fail() {
  echo "$(date '+%Y-%m-%d %H:%M') FAILED: $1" >> "$log"
  osascript -e "display notification \"$1\" with title \"Upheld backup failed\"" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit 1
}
trap 'fail "unexpected error (line $LINENO)"' ERR

PGPASSWORD="$(security find-generic-password -s upheld-db-password -w 2>/dev/null)" \
  || fail "database password not found in Keychain; run install-mac.sh again"
export PGPASSWORD

stamp="$(date +%Y-%m-%d_%H%M)"
"$PG_DUMP" "$DB_URL" --schema=public --no-owner --no-privileges --file "$work/public.sql" 2>>"$log" \
  || fail "could not back up the app's tables (see backup.log)"
"$PG_DUMP" "$DB_URL" --data-only --table=auth.users --table=auth.identities \
  --file "$work/auth-users.sql" 2>>"$log" \
  || fail "could not back up sign-in accounts (see backup.log)"
unset PGPASSWORD

out="$BACKUP_DIR/upheld-$stamp.tar.gz"
tar -czf "$out" -C "$work" public.sql auth-users.sql
chmod 600 "$out"
rm -rf "$work"

# Keep only the newest $KEEP backups.
ls -1t "$BACKUP_DIR"/upheld-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
  rm -f "$old"
done

echo "$(date '+%Y-%m-%d %H:%M') ok: $(basename "$out") ($(du -h "$out" | cut -f1 | tr -d ' '))" >> "$log"
