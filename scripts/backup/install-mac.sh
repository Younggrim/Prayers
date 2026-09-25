#!/bin/bash
# One-time setup for a weekly Upheld backup on this Mac (every Sunday at 8 PM).
#
# Run from the Prayers folder, after `supabase link` (it reads the connection address from
# supabase/.temp/pooler-url):
#
#   bash scripts/backup/install-mac.sh
#
# It asks for the database password once and stores it in your login Keychain. Backups go to
# ~/Upheld Backups (not the repo, not iCloud). Run it again any time to change the password or
# reinstall. To remove: bash scripts/backup/install-mac.sh --uninstall
#
# Restore notes: each backup is a .tar.gz with public.sql (app tables and data) and auth-users.sql
# (sign-in accounts). On a fresh Supabase project, load auth-users.sql first, then public.sql, with
# psql. Ask for help before restoring over the live project.
set -euo pipefail

label="com.macdwellings.upheld-backup"
conf_dir="$HOME/.config/upheld-backup"
plist="$HOME/Library/LaunchAgents/$label.plist"
backup_dir="$HOME/Upheld Backups"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  rm -f "$plist"
  rm -rf "$conf_dir"
  security delete-generic-password -s upheld-db-password >/dev/null 2>&1 || true
  echo "Weekly backup removed. Existing backups in \"$backup_dir\" were kept."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "This is for a Mac."; exit 1; }

# pg_dump from Homebrew's libpq (the same tools used for psql earlier).
pg_dump="$(brew --prefix libpq 2>/dev/null)/bin/pg_dump"
if [ ! -x "$pg_dump" ]; then
  echo "Installing the Postgres command-line tools (libpq)…"
  brew install libpq
  pg_dump="$(brew --prefix libpq)/bin/pg_dump"
fi

# Connection address (no password inside). pg_dump needs the session pooler, port 5432.
here="$(cd "$(dirname "$0")/../.." && pwd)"
url_file="$here/supabase/.temp/pooler-url"
[ -f "$url_file" ] || { echo "Can't find $url_file. Run this from the Prayers folder after 'supabase link'."; exit 1; }
db_url="$(tr -d '[:space:]' < "$url_file" | sed 's/:6543\//:5432\//')"
case "$db_url" in *\?*) db_url="$db_url&sslmode=require" ;; *) db_url="$db_url?sslmode=require" ;; esac

echo "Enter the Supabase database password (the one you use with psql). It's stored in your Keychain."
read -r -s -p "Password: " pw; echo
[ -n "$pw" ] || { echo "No password entered."; exit 1; }
if ! PGPASSWORD="$pw" "$(dirname "$pg_dump")/psql" "$db_url" -Atqc 'select 1' >/dev/null 2>&1; then
  echo "That password didn't work (or the database can't be reached). Nothing was changed."
  exit 1
fi
security add-generic-password -U -s upheld-db-password -a upheld -w "$pw"
unset pw

mkdir -p "$conf_dir" "$backup_dir" "$HOME/Library/LaunchAgents"
chmod 700 "$conf_dir" "$backup_dir"
cp "$here/scripts/backup/upheld-backup.sh" "$conf_dir/upheld-backup.sh"
chmod 700 "$conf_dir/upheld-backup.sh"
{
  printf 'PG_DUMP=%q\n' "$pg_dump"
  printf 'DB_URL=%q\n' "$db_url"
  printf 'BACKUP_DIR=%q\n' "$backup_dir"
  printf 'KEEP=12\n'
} > "$conf_dir/config"
chmod 600 "$conf_dir/config"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$conf_dir/upheld-backup.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>$backup_dir/launchd.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"

echo "Making the first backup now…"
if /bin/bash "$conf_dir/upheld-backup.sh"; then
  echo "Done. Weekly backups run Sundays at 8 PM (or when the Mac next wakes) into \"$backup_dir\"."
  echo "The newest 12 are kept. Latest:"
  ls -lh "$backup_dir"/upheld-*.tar.gz | tail -1
else
  echo "The first backup failed; see \"$backup_dir/backup.log\"."
  exit 1
fi
