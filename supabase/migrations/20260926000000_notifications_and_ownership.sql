-- Push notifications (urgent prayers, "pray at" times, personal prayer reminders) and ownership transfer.
--
-- Sending happens in the send-notifications Edge Function, which runs every minute (see the next
-- migration) with the service role. The claim_* functions below mark items as sent in the same
-- statement that returns them, so each notification goes out at most once.

-- ---------------------------------------------------------------------------
-- Prayers: urgent flag and an optional time to pray
-- ---------------------------------------------------------------------------

alter table public.prayers
  add column urgent              boolean not null default false,
  add column pray_at             timestamptz,
  add column urgent_notified_at  timestamptz,
  add column pray_at_notified_at timestamptz;

-- Same rules as before, plus: people can't set the "already notified" stamps, and turning urgent on
-- (or changing the pray-at time) makes the notification go out again.
create or replace function public.stamp_prayer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Direct SQL and the service role (no end-user JWT) may set these fields freely.
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.answered_at := null;
      new.approved_by := case when new.status = 'active' then auth.uid() else null end;
      new.urgent_notified_at := null;
      new.pray_at_notified_at := null;
    end if;
    return new;
  end if;

  if new.group_id <> old.group_id or new.created_at <> old.created_at
     or new.requested_by is distinct from old.requested_by then
    raise exception 'group_id, created_at and requested_by cannot be changed';
  end if;

  if auth.uid() is not null then
    if new.status <> old.status and old.status = 'pending' and new.status = 'active' then
      new.approved_by := auth.uid();
    else
      new.approved_by := old.approved_by;
    end if;

    new.urgent_notified_at := case when new.urgent and not old.urgent then null else old.urgent_notified_at end;
    new.pray_at_notified_at := case when new.pray_at is distinct from old.pray_at then null else old.pray_at_notified_at end;
  end if;

  if new.status = 'answered' and old.status <> 'answered' then
    new.answered_at := coalesce(new.answered_at, now());
  elsif new.status <> 'answered' then
    new.answered_at := null;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Push subscriptions: one row per phone that turned on notifications
-- ---------------------------------------------------------------------------

create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint   text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh     text not null check (char_length(p256dh) <= 200),
  auth       text not null check (char_length(auth) <= 100),
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;

create policy push_select on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy push_delete on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());
-- Inserts go through save_push_subscription() so a shared phone moves to whoever signed in last.

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth);
end;
$$;

-- ---------------------------------------------------------------------------
-- Notification settings: what each person wants, and their daily prayer reminder
-- ---------------------------------------------------------------------------

create table public.notification_settings (
  user_id            uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  urgent             boolean not null default true,
  scheduled          boolean not null default true,
  reminder_enabled   boolean not null default false,
  reminder_time      time not null default '07:00',
  reminder_days      smallint[] not null default '{0,1,2,3,4,5,6}'
                       check (reminder_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  timezone           text not null default 'America/New_York' check (char_length(timezone) <= 64),
  reminder_last_sent date,
  updated_at         timestamptz not null default now()
);

alter table public.notification_settings enable row level security;
revoke all on public.notification_settings from anon;

create policy settings_select on public.notification_settings
  for select to authenticated using (user_id = auth.uid());
create policy settings_insert on public.notification_settings
  for insert to authenticated with check (user_id = auth.uid());
create policy settings_update on public.notification_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.guard_notification_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Reject unknown time zones up front (this raises for an invalid name).
  perform now() at time zone new.timezone;
  new.updated_at := now();
  if auth.uid() is not null then
    -- Only the sender stamps reminder_last_sent. Changing the reminder lets it fire again today.
    if tg_op = 'INSERT' then
      new.reminder_last_sent := null;
    elsif new.reminder_time <> old.reminder_time or new.timezone <> old.timezone
          or new.reminder_days <> old.reminder_days or (new.reminder_enabled and not old.reminder_enabled) then
      new.reminder_last_sent := null;
    else
      new.reminder_last_sent := old.reminder_last_sent;
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_notification_settings
  before insert or update on public.notification_settings
  for each row execute function public.guard_notification_settings();

-- ---------------------------------------------------------------------------
-- Sender helpers (service role only)
-- ---------------------------------------------------------------------------

-- Urgent prayers that are live and not yet announced, then "pray at" times that have arrived
-- (within the last two hours). Each is marked as sent as it's returned.
create or replace function public.claim_due_notifications()
returns table (kind text, prayer_id uuid, group_id uuid, group_name text, title text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    with claimed as (
      update public.prayers p set urgent_notified_at = now()
      where p.status = 'active' and p.urgent and p.urgent_notified_at is null
      returning p.id, p.group_id, p.title
    )
    select 'urgent'::text, c.id, c.group_id, g.name, c.title
    from claimed c join public.groups g on g.id = c.group_id;

  return query
    with claimed as (
      update public.prayers p set pray_at_notified_at = now()
      where p.status = 'active' and p.pray_at is not null and p.pray_at_notified_at is null
        and p.pray_at <= now() and p.pray_at > now() - interval '2 hours'
      returning p.id, p.group_id, p.title
    )
    select 'pray_at'::text, c.id, c.group_id, g.name, c.title
    from claimed c join public.groups g on g.id = c.group_id;
end;
$$;

-- People whose daily reminder is due now (in their own time zone), within an hour of the chosen time.
create or replace function public.claim_due_reminders()
returns table (user_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.notification_settings n
  set reminder_last_sent = (now() at time zone n.timezone)::date
  where n.reminder_enabled
    and extract(dow from now() at time zone n.timezone)::smallint = any (n.reminder_days)
    and (now() at time zone n.timezone)::time >= n.reminder_time
    and (now() at time zone n.timezone)::time - n.reminder_time < interval '60 minutes'
    and (n.reminder_last_sent is null or n.reminder_last_sent < (now() at time zone n.timezone)::date)
  returning n.user_id;
$$;

-- Phones to notify about a group's prayer: active members who kept that kind of notification on.
create or replace function public.push_targets(p_group_id uuid, p_kind text)
returns table (user_id uuid, endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id, s.endpoint, s.p256dh, s.auth
  from public.push_subscriptions s
  join public.group_members m on m.user_id = s.user_id and m.group_id = p_group_id and m.status = 'active'
  left join public.notification_settings n on n.user_id = s.user_id
  where (p_kind = 'urgent' and coalesce(n.urgent, true))
     or (p_kind = 'pray_at' and coalesce(n.scheduled, true));
$$;

create or replace function public.push_targets_for_users(p_user_ids uuid[])
returns table (user_id uuid, endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id, s.endpoint, s.p256dh, s.auth
  from public.push_subscriptions s
  where s.user_id = any (p_user_ids);
$$;

-- ---------------------------------------------------------------------------
-- Ownership transfer
-- ---------------------------------------------------------------------------

-- The role guard below lets role changes through only while transfer_ownership() is running.
create or replace function public.guard_member_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Direct SQL and the service role (no end-user JWT) are trusted.
  if auth.uid() is null then
    return new;
  end if;

  if new.group_id <> old.group_id or new.user_id <> old.user_id or new.created_at <> old.created_at then
    raise exception 'group_id, user_id and created_at cannot be changed';
  end if;

  if new.status <> old.status then
    if not (old.status = 'pending' and new.status = 'active') then
      raise exception 'membership can only move from pending to active';
    end if;
    if not public.is_approver(old.group_id) then
      raise exception 'only approvers or the owner can approve members';
    end if;
  end if;

  if new.role <> old.role and coalesce(current_setting('upheld.ownership_transfer', true), '') <> 'on' then
    if not public.is_owner(old.group_id) then
      raise exception 'only the owner can change roles';
    end if;
    if old.role = 'owner' or new.role = 'owner' then
      raise exception 'the owner role cannot be changed here';
    end if;
    if new.status <> 'active' then
      raise exception 'only active members can be made approvers';
    end if;
  end if;

  return new;
end;
$$;

-- The owner hands the group to another active member and becomes an approver.
create or replace function public.transfer_ownership(p_group_id uuid, p_new_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_owner(p_group_id) then
    raise exception 'only the owner can transfer ownership';
  end if;
  if p_new_owner = auth.uid() then
    raise exception 'choose someone else to be the owner';
  end if;
  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_new_owner and status = 'active'
  ) then
    raise exception 'the new owner must be an active member of the group';
  end if;

  perform set_config('upheld.ownership_transfer', 'on', true);
  update public.group_members set role = 'approver' where group_id = p_group_id and user_id = auth.uid();
  update public.group_members set role = 'owner' where group_id = p_group_id and user_id = p_new_owner;
  perform set_config('upheld.ownership_transfer', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function public.save_push_subscription(text, text, text) from public, anon;
revoke execute on function public.transfer_ownership(uuid, uuid)            from public, anon;
grant  execute on function public.save_push_subscription(text, text, text) to authenticated;
grant  execute on function public.transfer_ownership(uuid, uuid)            to authenticated;

revoke execute on function public.claim_due_notifications()        from public, anon, authenticated;
revoke execute on function public.claim_due_reminders()            from public, anon, authenticated;
revoke execute on function public.push_targets(uuid, text)         from public, anon, authenticated;
revoke execute on function public.push_targets_for_users(uuid[])   from public, anon, authenticated;
grant  execute on function public.claim_due_notifications()        to service_role;
grant  execute on function public.claim_due_reminders()            to service_role;
grant  execute on function public.push_targets(uuid, text)         to service_role;
grant  execute on function public.push_targets_for_users(uuid[])   to service_role;
