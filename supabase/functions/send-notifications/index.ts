// send-notifications: sends what's due as web push notifications. Runs every minute from pg_cron.
//
//   - urgent prayers that just went live (approved, or posted by an approver / with approval off)
//   - "pray at" times that have arrived
//   - each person's daily prayer reminder
//
// The claim_* database functions mark items as sent as they return them, so calling this more often
// (or by anyone) never sends a notification twice. It needs no caller auth for that reason; deploy with
// --no-verify-jwt so the cron job can call it.
//
// Secrets (Supabase, never in this repo): VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT.
// The service role key is provided to Edge Functions by Supabase automatically.
// Never log prayer text or subscription endpoints.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

type Target = { user_id: string; endpoint: string; p256dh: string; auth: string };
type Payload = { title: string; body: string; url: string; tag: string };

const env = (k: string) => Deno.env.get(k) ?? "";

Deno.serve(async () => {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SECRET_KEY");
  const vapidPublic = env("VAPID_PUBLIC_KEY");
  const vapidPrivate = env("VAPID_PRIVATE_KEY");
  const vapidSubject = env("VAPID_SUBJECT") || "mailto:upheld@macdwellings.com";
  if (!url || !serviceKey || !vapidPublic || !vapidPrivate) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  let sent = 0, failed = 0, removed = 0;

  async function deliver(targets: Target[], payload: Payload) {
    const body = JSON.stringify(payload);
    await Promise.all(targets.map(async (t) => {
      try {
        const req = webpush.generateRequestDetails(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          body,
          { TTL: 60 * 60 * 6, urgency: "high", topic: payload.tag.slice(0, 32) },
        );
        const res = await fetch(req.endpoint, { method: req.method, headers: req.headers, body: req.body });
        if (res.ok) {
          sent++;
        } else if (res.status === 404 || res.status === 410) {
          // The phone unsubscribed or the app was removed: forget this endpoint.
          await db.from("push_subscriptions").delete().eq("endpoint", t.endpoint);
          removed++;
        } else {
          failed++;
          console.error(`send-notifications: push service returned ${res.status}`);
        }
      } catch {
        failed++;
        console.error("send-notifications: could not send one push");
      }
    }));
  }

  // Urgent prayers and pray-at times.
  const { data: due, error: dueError } = await db.rpc("claim_due_notifications");
  if (dueError) console.error("send-notifications: claim_due_notifications failed");
  for (const n of due ?? []) {
    const { data: targets } = await db.rpc("push_targets", { p_group_id: n.group_id, p_kind: n.kind });
    const link = `/app/?group=${n.group_id}&prayer=${n.prayer_id}`;
    const payload: Payload = n.kind === "urgent"
      ? { title: `Urgent prayer · ${n.group_name}`, body: n.title, url: link, tag: `urgent-${n.prayer_id}` }
      : { title: `Pray now · ${n.group_name}`, body: n.title, url: link, tag: `prayat-${n.prayer_id}` };
    await deliver(targets ?? [], payload);
  }

  // Daily prayer reminders.
  const { data: reminders, error: remindError } = await db.rpc("claim_due_reminders");
  if (remindError) console.error("send-notifications: claim_due_reminders failed");
  const userIds = (reminders ?? []).map((r: { user_id: string }) => r.user_id);
  if (userIds.length) {
    const { data: targets } = await db.rpc("push_targets_for_users", { p_user_ids: userIds });
    await deliver(targets ?? [], {
      title: "Time to pray",
      body: "Take a few minutes with your group's prayers.",
      url: "/app/?pray=1",
      tag: "reminder",
    });
  }

  return Response.json({ notifications: (due ?? []).length, reminders: userIds.length, sent, failed, removed });
});
