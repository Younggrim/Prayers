# Upheld

A private prayer app for small groups, built first for the New River Church (Clover, SC) Friday morning men's group. Named for Exodus 17:12: Aaron and Hur held up Moses' hands until sunset.

Owner: Jeremy McAdoo. Repo: Younggrim/Prayers. Live site: https://upheld.macdwellings.com (GitHub Pages, custom domain via CNAME).

## Hard rules

- This repo is public. Never commit real prayer data: no names from real requests, no exports, no CSVs, no seed files with real people. Use obviously fake sample data only ("Sample Person"). .gitignore blocks *.csv and data/.
- Never commit secrets. The Supabase URL and anon key may be committed (public by design). The service-role key must never appear in this repo, in client code, or in logs.
- The browser gate is not security. index.html sends home-screen launches to app/, and app/ sends browser visitors back to the landing page. That's a product choice so prayers are only used in the installed app. Real protection comes from Supabase Auth plus Row Level Security. Every table with group data must have RLS enabled and tested.
- The landing page never shows prayer content.
- Static site: plain HTML, CSS, and JavaScript on GitHub Pages. No build step unless agreed. Libraries load from a CDN at pinned versions (e.g. @supabase/supabase-js UMD from jsDelivr).

## Structure

    index.html              Landing page: description, verse, features, install steps, privacy
    app/index.html          The installed app
    manifest.webmanifest    PWA manifest: name Upheld, start_url ./app/, scope ./, display standalone, background and theme #2C5F6F, icons 192, 512, maskable 512
    sw.js                   Service worker: network-first, caches only same-origin GET requests (never API or auth traffic)
    icons/                  App icons and SVG source
    CNAME                   upheld.macdwellings.com
    supabase/migrations/    SQL migrations

## Landing page

Browser visitors only see this page. If opened from the home screen (display-mode standalone, or navigator.standalone on iOS), redirect to app/ immediately. Include the manifest, apple-touch-icon, favicon, theme-color #2C5F6F, and apple-mobile-web-app tags. Register sw.js. Sections in order:

1. Hero on #2C5F6F with cream text: "Upheld" (large serif), lede "A private prayer app for small groups. Keep your prayer lists in one place, pray through them together, and never let a request get lost.", amber button "Add Upheld to your phone" linking to #install, and the icon scene as a large inline illustration with its hill blending into the next band.
2. Verse band on #1E4450: "But Moses' hands were heavy… and Aaron and Hur stayed up his hands, the one on the one side, and the other on the other side; and his hands were steady until the going down of the sun." Exodus 17:12 (KJV).
3. Heading "Nobody should have to hold their arms up alone" with: "Upheld started with a small prayer group that kept its requests on a slide deck that grew longer every week. Upheld gives a group one shared list that stays current, a simple way to pray through it, and a place to celebrate the prayers God answers."
4. Four features: Prayer time on a timer; Request a prayer; Private groups with approvers; Answered prayer (one or two sentences each, based on Features below).
5. Install (id="install"): "Prayer lists open only in the app, not in a web browser. Add it to your home screen, open it from there, and sign in to join your group." iPhone steps (Safari, Share, Add to Home Screen, open from home screen) and Android steps (Chrome, menu, Install app, open from home screen). An "Install Upheld" button shown only when beforeinstallprompt fires.
6. Privacy: "Your group's requests stay in your group" with a short note that every group is private, members are approved, and prayers are only shown to signed-in members.
7. Footer: "Upheld. Made for any small group that prays together."

app/index.html: if not standalone, redirect to ../#install. Otherwise show the icon, "Upheld", and "Sign-in and your group's prayers are coming soon" until sign-in is built.

## Stack

- Hosting: GitHub Pages (static).
- Backend: Supabase (Postgres, Auth, Row Level Security, Edge Functions).
- Sign-in: email magic link (no passwords).
- Prayer writing: "Request a prayer" drafts a prayer from who + need via a Supabase Edge Function (keys stay server-side). If unavailable, use the template in Prayer style.

## Roles

Per group, in group_members.role:

- owner: created the group. Everything an approver can do, plus choose approvers, rename or delete the group, remove anyone.
- approver: approves or declines join requests; approves, edits, or declines new prayer requests; marks prayers answered; removes prayers.
- member: sees approved prayers, runs prayer time, taps "I prayed", submits requests.

Each group has require_approval (default true). When false, member requests post directly.

## Data model

    profiles        id (= auth.users.id), display_name, created_at
    groups          id, name, description, require_approval bool, invite_code (unique), created_by, created_at
    group_members   group_id, user_id, role ('owner'|'approver'|'member'), status ('pending'|'active'), created_at
    lists           id, group_id, name, sort_order
    prayers         id, group_id, list_id, title, body, status ('pending'|'active'|'answered'|'removed'),
                    requested_by, approved_by, created_at, answered_at
    prayed_marks    prayer_id, user_id, created_at

RLS:

- A user sees a group, its lists, and its active/answered prayers only if they are an active member.
- Pending prayers are visible to their requester and to the group's approvers and owner.
- Members insert prayers as pending (or active when require_approval is false). Only approvers/owner change status.
- Joining: a user with a valid invite_code inserts a pending membership; approvers/owner activate it.
- Users insert and delete only their own prayed_marks.

## Features

1. Lists by tab: All, each list, and Praise. Tap a prayer to open its full text and tap "I prayed". Show "Prayed 3x" totals.
2. Prayer time: pick a length (3, 5, 10, 15, 20, 30 min) and which lists. Shuffle into one stack; one prayer on screen at a time; tap the card or "Next prayer" to advance (each advance counts as prayed). Countdown ring, Pause, End. Keep the screen awake (Wake Lock API). Soft two-note chime at the end, then "Amen" with how many were prayed for.
3. Request a prayer: who / what's going on / your name (optional). Draft the prayer, let the requester edit title and text, then submit (pending if the group requires approval).
4. Approvals: approvers get a queue of pending members and pending prayers with Approve / Edit / Decline.
5. Answered prayer: approvers move a prayer to Praise; it leaves prayer time but stays in the Praise tab.

Build order: auth + groups/invites, then lists/prayers, then prayer time, then requests + approvals, then praise.

## Prayer style

    Heavenly Father,

    We lift up <person> to You today. <2 to 4 sentences, specific to the need.>

    In Jesus' name, Amen.

## Design

- Colors: river #2C5F6F, deep river #1E4450, sun #E2AA4E, cream #F3E4C8, ink #1B2A31, mist background #EEF2F3. Light and dark mode.
- Type: Source Serif 4 for headings and prayer text; Public Sans for UI (Google Fonts, with fallbacks).
- Mobile first; safe-area insets; visible focus states; honor reduced motion.
- Icon: Moses on a hill at sunset, arms raised, with Aaron and Hur holding up his hands (icons/upheld-icon.svg).
