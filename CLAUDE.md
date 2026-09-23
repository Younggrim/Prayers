# Upheld

A private prayer app for small groups. Named for Exodus 17:12: Aaron and Hur held up Moses' hands until sunset.

Owner: Jeremy McAdoo. Repo: Younggrim/Prayers. Live site: https://upheld.macdwellings.com (GitHub Pages, custom domain via CNAME).

## Hard rules

- This repo is public. Never commit real prayer data: no names from real requests, no exports, no CSVs, no seed files with real people. Use obviously fake sample data only ("Sample Person"). .gitignore blocks *.csv and data/.
- Never commit secrets. The Supabase URL and anon key may be committed (public by design). The service-role key must never appear in this repo, in client code, or in logs.
- The browser gate is not security. index.html sends home-screen launches to app/, and app/ sends browser visitors back to the landing page. That's a product choice so prayers are only used in the installed app. Real protection comes from Supabase Auth plus Row Level Security. Every table with group data must have RLS enabled and tested.
- The landing page never shows prayer content.
- Static site: plain HTML, CSS, and JavaScript on GitHub Pages. No build step unless agreed. Libraries load from a CDN at pinned versions (e.g. @supabase/supabase-js UMD from jsDelivr).

## Structure

    index.html              Landing page: description, verse, features, install steps, privacy
    app/index.html          The installed app (shell); app/app.js (logic), app/app.css, app/config.js (Supabase URL + publishable key)
    manifest.webmanifest    PWA manifest: name Upheld, start_url ./app/, scope ./, display standalone, background and theme #2C5F6F, icons 192, 512, maskable 512
    sw.js                   Service worker: network-first, caches only same-origin GET requests (never API or auth traffic); shows push notifications and opens the linked prayer when tapped
    icons/                  App icons and SVG source
    CNAME                   upheld.macdwellings.com
    supabase/migrations/    SQL migrations (apply with: supabase db push)
    supabase/functions/     Edge Functions: draft-prayer (supabase functions deploy draft-prayer),
                            send-notifications (supabase functions deploy send-notifications --no-verify-jwt)
    supabase/tests/         RLS privacy tests (rls_privacy_test.sql); scripts/test-rls-local.sh runs them on a throwaway Postgres

## Landing page

Browser visitors only see this page. If opened from the home screen (display-mode standalone, or navigator.standalone on iOS), redirect to app/ immediately. Include the manifest, apple-touch-icon, favicon, theme-color #2C5F6F, and apple-mobile-web-app tags. Register sw.js. Sections in order:

1. Hero on #2C5F6F with cream text: "Upheld" (large serif), lede "A private prayer app for small groups. Keep your prayer lists in one place, pray through them together, and never let a request get lost.", amber button "Add Upheld to your phone" linking to #install, and the icon scene as a large inline illustration with its hill blending into the next band.
2. Verse band on #1E4450: "But Moses' hands were heavy… and Aaron and Hur stayed up his hands, the one on the one side, and the other on the other side; and his hands were steady until the going down of the sun." Exodus 17:12 (KJV).
3. Heading "Nobody should have to hold their arms up alone" with: "Upheld started with a small prayer group that kept its requests on a slide deck that grew longer every week. Upheld gives a group one shared list that stays current, a simple way to pray through it, and a place to celebrate the prayers God answers."
4. Four features: Prayer time on a timer; Request a prayer; Private groups with approvers; Answered prayer (one or two sentences each, based on Features below).
5. Install (id="install"): "Prayer lists open only in the app, not in a web browser. Add it to your home screen, open it from there, and sign in to join your group." iPhone steps (Safari, Share, Add to Home Screen, open from home screen) and Android steps (Chrome, menu, Install app, open from home screen). An "Install Upheld" button shown only when beforeinstallprompt fires.
6. Privacy: "Your group's requests stay in your group" with a short note that every group is private, members are approved, and prayers are only shown to signed-in members.
7. Footer: "Upheld. Made for any small group that prays together."

app/index.html: if not standalone, redirect to ../#install. Otherwise run the app (app/app.js).

## Stack

- Hosting: GitHub Pages (static).
- Backend: Supabase (Postgres, Auth, Row Level Security, Edge Functions). Project "upheld", ref vyiznjphjwehawdzapce, free plan, West US (Oregon). URL and publishable key live in app/config.js.
- Client library: @supabase/supabase-js 2.117.0 UMD from jsDelivr, pinned with an SRI hash in app/index.html. When upgrading, update the version and the integrity hash together.
- Sign-in: passwordless email with a 6-digit code (Supabase email OTP: signInWithOtp, then verifyOtp with type 'email'). The person types the code into the app. Don't rely on tapping the link: on iPhone, home-screen apps don't share storage with Safari, so a link would sign them in to Safari instead of the app. Both the "Confirm signup" template (used the first time an email signs in) and the "Magic Link" template must include {{ .Token }}, and Supabase only applies custom templates once custom SMTP is set up. Auth Site URL and redirect URL: https://upheld.macdwellings.com/app/. After sign-in, people set a display name (profiles.display_name) before joining a group. Email goes through Resend (custom SMTP in Supabase: smtp.resend.com:465, user "resend", sender Upheld <upheld@macdwellings.com>); the Resend API key lives only in Supabase's SMTP settings. DNS for Resend on macdwellings.com: TXT resend._domainkey, CNAME send and rsend (Proton Mail records on the root domain are separate and untouched).
- Push notifications: standard Web Push with VAPID. Public key in app/config.js (vapidPublicKey; empty = notifications off). Supabase secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:). pg_cron calls send-notifications every minute (migration 20260926000100); it claims what's due with claim_due_notifications() / claim_due_reminders(), which mark items sent in the same statement, so extra calls never duplicate a push. That's why the function runs without JWT verification. Push requests are built with npm:web-push and sent with fetch; 404/410 responses delete the dead subscription. Notification links: /app/?group=<id>&prayer=<id> or /app/?pray=1. Lock-screen text: "Urgent prayer · <group>" / "Pray now · <group>" with the prayer title as the body; "Time to pray" for reminders. On iPhone, pushes need iOS 16.4+ and the home-screen app.
- Prayer writing: "Request a prayer" drafts a prayer from who + need via the draft-prayer Supabase Edge Function (keys stay server-side). If unavailable, use the template in Prayer style.
  draft-prayer details: Claude API through the official SDK (npm:@anthropic-ai/sdk@0.127.0), model claude-opus-5, output_config.effort "low", server-side refusal fallbacks (fallbacks: "default", beta server-side-fallback-2026-07-01). The key is the Supabase secret ANTHROPIC_API_KEY. The function only serves active members of the requested group (checked with my_groups() under the caller's session), accepts browser calls only from https://upheld.macdwellings.com, caps input length, and never logs request text. Any failure (not deployed, no key, refusal, timeout) makes the app use the template, with a notice. Pin npm versions at least a day old (Deno's minimum dependency age policy).

## Roles

Per group, in group_members.role:

- owner: created the group (or received it by transfer). Everything an approver can do, plus choose approvers, rename or delete the group, remove anyone, and transfer ownership to another active member.
- approver: approves or declines join requests; approves, edits, or declines new prayer requests; marks prayers answered; removes prayers.
- member: sees approved prayers, runs prayer time, taps "I prayed", submits requests.

Each group has require_approval (default true). When false, member requests post directly.

## Data model

    profiles        id (= auth.users.id), display_name, created_at
    groups          id, name, description, require_approval bool, invite_code (unique), created_by, created_at
    group_members   group_id, user_id, role ('owner'|'approver'|'member'), status ('pending'|'active'), created_at
    lists           id, group_id, name, sort_order
    prayers         id, group_id, list_id, title, body, status ('pending'|'active'|'answered'|'removed'),
                    requested_by, approved_by, created_at, answered_at, requester_name (optional "Requested by"),
                    urgent bool, pray_at timestamptz, urgent_notified_at, pray_at_notified_at
    prayed_marks    prayer_id, user_id, created_at
    push_subscriptions      id, user_id, endpoint (unique, https), p256dh, auth, created_at   (one row per phone)
    notification_settings   user_id, urgent, scheduled, reminder_enabled, reminder_time, reminder_days (0=Sun..6=Sat),
                            timezone (IANA), reminder_last_sent, updated_at

RLS:

- A user sees a group, its lists, and its active/answered prayers only if they are an active member.
- Pending prayers are visible to their requester and to the group's approvers and owner.
- Members insert prayers as pending (or active when require_approval is false). Only approvers/owner change status.
- Joining: a user with a valid invite_code inserts a pending membership; approvers/owner activate it.
- Users insert and delete only their own prayed_marks.
- Users see and delete only their own push_subscriptions (added via save_push_subscription()), and read/write only their own notification_settings. Nobody but the sender sets the *_notified_at stamps or reminder_last_sent.

Server functions (SECURITY DEFINER, signed-in users only):

- create_group(name, description): creates the group; caller becomes its active owner.
- join_group(invite_code): creates a pending membership; returns only the group's id, name, and the caller's status.
- rotate_invite_code(group_id): owner only.
- prayed_totals(group_id): per-prayer "Prayed Nx" totals (group total and the caller's own) for active/answered prayers; active members only.
- my_groups(): the caller's groups, including pending ones (name and status only). Invite codes go only to approvers/owner.
- group_roster(group_id): names, roles, and statuses. Members see active people; approvers/owner also see pending join requests.
- transfer_ownership(group_id, new_owner): owner only; the new owner must be an active member; the old owner becomes an approver. The role guard allows owner changes only inside this function.
- save_push_subscription(endpoint, p256dh, auth): registers this phone for the caller (a shared phone moves to whoever turned notifications on last).
- Service role only (sender): claim_due_notifications(), claim_due_reminders(), push_targets(group_id, kind), push_targets_for_users(ids).

Triggers enforce what policies can't: only the owner changes roles (never to or from owner); memberships only move pending -> active; approved_by and answered_at are stamped automatically; prayers can't move between groups. The owner can't leave their own group.

## Features

1. Lists by tab: All, each list, and Praise. Tap a prayer to open its full text and tap "I prayed". Show "Prayed 3x" totals.
2. Prayer time: pick a length (3, 5, 10, 15, 20, 30 min) and which lists. Shuffle into one stack; one prayer on screen at a time; tap the card or "Next prayer" to advance (each advance counts as prayed). Countdown ring, Pause, End. Keep the screen awake (Wake Lock API). Soft two-note chime at the end, then "Amen" with how many were prayed for.
3. Request a prayer: who / what's going on / your name (optional). Draft the prayer, let the requester edit title and text, then submit (pending if the group requires approval).
4. Approvals: approvers get a queue of pending members and pending prayers with Approve / Edit / Decline.
5. Answered prayer: approvers move a prayer to Praise; it leaves prayer time but stays in the Praise tab.
6. Urgent and timed prayers: a request can be marked urgent (push to the group once it's live) and/or carry a "pray at" time (a "Pray now" push at that time, sent up to 2 hours late). Urgent prayers sort first and show an Urgent badge.
7. Notifications (Group tab): turn on per phone; choose urgent / pray-at pushes; a personal daily prayer reminder (time + days, in the phone's time zone, sent within an hour of the chosen time).

Build order: auth + groups/invites, then lists/prayers, then prayer time, then requests + approvals, then praise.

## Status

- Phase 1 (repo, landing page, Pages, DNS): done. Sign-in email via Resend verified working end to end.
- Phase 2 (Supabase schema, RLS, privacy tests): done. Tests pass against the live project.
- Phase 3 (sign-in, create/join group, approver queue for members, owner role management, require-approval setting): built in app/app.js.
- Phase 4 (lists view with All / each list / Praise tabs, prayer detail with "I prayed", "Prayed Nx" totals, prayer time): built in app/app.js.
  Prayer time details: lists order by prayers.created_at (oldest first); Praise orders by answered_at (newest first). Advancing marks the card being left as prayed; when time runs out the card on screen also counts; ending early doesn't count the card on screen. After the whole stack is prayed it reshuffles and continues. Chime is Web Audio (G5 then C5), unlocked on the Begin tap for iOS. Screen Wake Lock is held while running and re-requested when the app returns to the foreground.
- Phase 5 (request a prayer with a drafted, editable prayer; approver queue with Approve / Edit / Decline; mark answered / move back / remove; approvers manage lists in the Group tab): built.
  Declining a request or removing a prayer sets status 'removed' (kept, hidden from members). Approvers and owners post directly; members post directly only when require_approval is off. The Prayers tab shows approvers a "Waiting for approval" queue (badge on the tab); members see their own pending requests.
  Template when drafting is unavailable: "Heavenly Father,\n\nWe lift up <who> to You today. <need>. Surround them with Your peace, give them strength for each day, and let them know they are not alone.\n\nIn Jesus' name, Amen."
- Phase 7 (urgent and pray-at pushes, daily prayer reminders, ownership transfer): built and live (migrations pushed, VAPID secrets set, send-notifications deployed).
- Next: Phase 6 (one-time import of the group's lists; script and data never committed).

## Prayer style

    Heavenly Father,

    We lift up <person> to You today. <2 to 4 sentences, specific to the need.>

    In Jesus' name, Amen.

## Design

- Colors: river #2C5F6F, deep river #1E4450, sun #E2AA4E, cream #F3E4C8, ink #1B2A31, mist background #EEF2F3. Light and dark mode.
- Type: Source Serif 4 for headings and prayer text; Public Sans for UI (Google Fonts, with fallbacks).
- Mobile first; safe-area insets; visible focus states; honor reduced motion.
- Icon: Moses on a hill at sunset, arms raised, with Aaron and Hur holding up his hands (icons/upheld-icon.svg).
