# Upheld

A private prayer app for small groups. Keep your prayer lists in one place, pray through them together, and never let a request get lost.

Named for Exodus 17:12, when Aaron and Hur held up Moses' hands until sunset.

Live site: https://upheld.macdwellings.com

## How it works

- `index.html` is the public landing page. It never shows prayer content.
- `app/` is the app itself. It opens only from the home screen (installed as a PWA). Browser visitors are sent to the install steps.
- Data lives in Supabase. Every table has Row Level Security, so only signed-in, approved members of a group can read that group's lists and prayers. The home-screen redirect is a product choice, not security.

See [CLAUDE.md](CLAUDE.md) for the full spec, data model, and project rules.

## Layout

    index.html              Landing page
    app/index.html          Installed app
    manifest.webmanifest    PWA manifest
    sw.js                   Service worker (network-first, same-origin GETs only)
    icons/                  App icons; upheld-icon.svg is the source
    supabase/migrations/    Database schema and RLS policies
    supabase/tests/         RLS privacy tests
    scripts/                Developer scripts

## Development

It's a static site with no build step. To preview it, serve the folder:

    python3 -m http.server 8000

Then open http://localhost:8000. To see `app/`, use your browser's device mode or install it as an app. Otherwise it redirects to the landing page.

## Privacy tests

The tests in `supabase/tests/rls_privacy_test.sql` sign in as fake users and check that:

- non-members can't read a group's lists or prayers
- members can't see each other's pending requests
- only approvers or the owner can approve anything

All of it runs in a transaction that is rolled back.

- **Plain Postgres (no Supabase needed):** `scripts/test-rls-local.sh`
- **Local Supabase:** `supabase start && supabase db reset`, then `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/rls_privacy_test.sql`
- **Hosted project:** `psql "$DATABASE_URL" -f supabase/tests/rls_privacy_test.sql`

## Rules

This repo is public. Never commit real prayer data (CSVs, exports, names from real requests) or secrets. The Supabase URL and anon key are public by design. The service-role key must never be committed.
