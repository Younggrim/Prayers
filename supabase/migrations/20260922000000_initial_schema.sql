-- Upheld: initial schema with Row Level Security on every table.
-- See CLAUDE.md "Data model" and "RLS". Group data is visible only to active members.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  created_at   timestamptz not null default now()
);

-- Invite codes: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L).
create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := uuid_send(gen_random_uuid());
  code text := '';
begin
  for i in 0..7 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return code;
end;
$$;

create table public.groups (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 1 and 80),
  description      text check (description is null or char_length(description) <= 500),
  require_approval boolean not null default true,
  invite_code      text not null unique default public.generate_invite_code(),
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now()
);

create table public.group_members (
  group_id   uuid not null references public.groups (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'approver', 'member')),
  status     text not null default 'pending' check (status in ('pending', 'active')),
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

create table public.lists (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  sort_order integer not null default 0,
  unique (id, group_id)
);
create index lists_group_idx on public.lists (group_id, sort_order);

create table public.prayers (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups (id) on delete cascade,
  list_id      uuid,
  title        text not null check (char_length(title) between 1 and 120),
  body         text not null default '' check (char_length(body) <= 4000),
  status       text not null default 'pending' check (status in ('pending', 'active', 'answered', 'removed')),
  requested_by uuid references auth.users (id) on delete set null,
  approved_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  answered_at  timestamptz,
  -- A prayer's list must belong to the same group.
  foreign key (list_id, group_id) references public.lists (id, group_id) on delete set null (list_id)
);
create index prayers_group_status_idx on public.prayers (group_id, status);

create table public.prayed_marks (
  id         bigint generated always as identity primary key,
  prayer_id  uuid not null references public.prayers (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index prayed_marks_prayer_idx on public.prayed_marks (prayer_id);
create index prayed_marks_user_idx on public.prayed_marks (user_id);

-- ---------------------------------------------------------------------------
-- Membership helpers. SECURITY DEFINER so policies can check membership
-- without recursing through group_members' own RLS.
-- ---------------------------------------------------------------------------

create or replace function public.is_active_member(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members
    where group_id = gid and user_id = auth.uid() and status = 'active'
  );
$$;

create or replace function public.is_approver(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members
    where group_id = gid and user_id = auth.uid() and status = 'active'
      and role in ('owner', 'approver')
  );
$$;

create or replace function public.is_owner(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members
    where group_id = gid and user_id = auth.uid() and status = 'active' and role = 'owner'
  );
$$;

create or replace function public.shares_group_with(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members me
    join public.group_members them on them.group_id = me.group_id
    where me.user_id = auth.uid() and me.status = 'active'
      and them.user_id = other
      and (them.status = 'active' or me.role in ('owner', 'approver'))
  );
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.lists         enable row level security;
alter table public.prayers       enable row level security;
alter table public.prayed_marks  enable row level security;

-- Signed-out visitors get nothing.
revoke all on public.profiles, public.groups, public.group_members,
              public.lists, public.prayers, public.prayed_marks from anon;

-- ---------------------------------------------------------------------------
-- profiles: see yourself and people in your groups; edit only yourself.
-- ---------------------------------------------------------------------------

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.shares_group_with(id));

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Create a profile row for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(left(trim(new.raw_user_meta_data ->> 'display_name'), 80), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- groups: active members read; owner updates and deletes.
-- Creation goes through create_group() so the owner membership is atomic.
-- ---------------------------------------------------------------------------

create policy groups_select on public.groups
  for select to authenticated
  using (public.is_active_member(id));

create policy groups_update on public.groups
  for update to authenticated
  using (public.is_owner(id))
  with check (public.is_owner(id));

create policy groups_delete on public.groups
  for delete to authenticated
  using (public.is_owner(id));

create or replace function public.guard_group_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'id, created_by and created_at cannot be changed';
  end if;
  return new;
end;
$$;

create trigger guard_group_update
  before update on public.groups
  for each row execute function public.guard_group_update();

-- ---------------------------------------------------------------------------
-- group_members
--   Read: your own row; active members of your groups; approvers also see pending rows.
--   Update: approvers activate pending members; only the owner changes roles.
--   Delete: leave (non-owners), approvers decline pending, owner removes anyone but the owner.
--   Insert: only via create_group() and join_group().
-- ---------------------------------------------------------------------------

create policy members_select on public.group_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or (status = 'active' and public.is_active_member(group_id))
    or public.is_approver(group_id)
  );

create policy members_update on public.group_members
  for update to authenticated
  using (public.is_approver(group_id))
  with check (public.is_approver(group_id));

create policy members_delete on public.group_members
  for delete to authenticated
  using (
    (user_id = auth.uid() and role <> 'owner')
    or (status = 'pending' and public.is_approver(group_id))
    or (role <> 'owner' and public.is_owner(group_id))
  );

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

  if new.role <> old.role then
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

create trigger guard_member_update
  before update on public.group_members
  for each row execute function public.guard_member_update();

-- Create a group; the caller becomes its active owner.
create or replace function public.create_group(p_name text, p_description text default null)
returns public.groups
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.groups;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;

  insert into public.groups (name, description, created_by)
  values (trim(p_name), nullif(trim(p_description), ''), auth.uid())
  returning * into g;

  insert into public.group_members (group_id, user_id, role, status)
  values (g.id, auth.uid(), 'owner', 'active');

  return g;
end;
$$;

-- Join with an invite code. Creates a pending membership (or returns the existing one).
-- Returns only the group's id and name, so a code reveals nothing else.
create or replace function public.join_group(p_invite_code text)
returns table (group_id uuid, group_name text, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  g record;
  m record;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;

  select id, name into g
  from public.groups
  where invite_code = upper(trim(p_invite_code));

  if not found then
    raise exception 'invalid invite code' using errcode = 'P0002';
  end if;

  insert into public.group_members (group_id, user_id, role, status)
  values (g.id, auth.uid(), 'member', 'pending')
  on conflict on constraint group_members_pkey do nothing;

  select gm.status into m
  from public.group_members gm
  where gm.group_id = g.id and gm.user_id = auth.uid();

  return query select g.id, g.name, m.status;
end;
$$;

-- Owner can issue a fresh invite code (e.g. if one leaks).
create or replace function public.rotate_invite_code(p_group_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  code text;
begin
  if not public.is_owner(p_group_id) then
    raise exception 'only the owner can change the invite code';
  end if;
  update public.groups set invite_code = public.generate_invite_code()
  where id = p_group_id
  returning invite_code into code;
  return code;
end;
$$;

-- ---------------------------------------------------------------------------
-- lists: active members read; approvers and the owner manage.
-- ---------------------------------------------------------------------------

create policy lists_select on public.lists
  for select to authenticated
  using (public.is_active_member(group_id));

create policy lists_insert on public.lists
  for insert to authenticated
  with check (public.is_approver(group_id));

create policy lists_update on public.lists
  for update to authenticated
  using (public.is_approver(group_id))
  with check (public.is_approver(group_id));

create policy lists_delete on public.lists
  for delete to authenticated
  using (public.is_approver(group_id));

-- ---------------------------------------------------------------------------
-- prayers
--   Read: active/answered for active members; pending for the requester and approvers;
--         removed only for approvers.
--   Insert: active members, as themselves; pending, or active when the group doesn't
--           require approval (approvers may always post active).
--   Update/delete: approvers and the owner only.
-- ---------------------------------------------------------------------------

create policy prayers_select on public.prayers
  for select to authenticated
  using (
    (status in ('active', 'answered') and public.is_active_member(group_id))
    or (status = 'pending' and requested_by = auth.uid())
    or public.is_approver(group_id)
  );

create policy prayers_insert on public.prayers
  for insert to authenticated
  with check (
    public.is_active_member(group_id)
    and requested_by = auth.uid()
    and answered_at is null
    and (
      status = 'pending'
      or (
        status = 'active'
        and (
          public.is_approver(group_id)
          or not (select g.require_approval from public.groups g where g.id = group_id)
        )
      )
    )
  );

create policy prayers_update on public.prayers
  for update to authenticated
  using (public.is_approver(group_id))
  with check (public.is_approver(group_id));

create policy prayers_delete on public.prayers
  for delete to authenticated
  using (public.is_approver(group_id));

-- Keep approved_by / answered_at honest and stop prayers moving between groups.
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
  end if;

  if new.status = 'answered' and old.status <> 'answered' then
    new.answered_at := coalesce(new.answered_at, now());
  elsif new.status <> 'answered' then
    new.answered_at := null;
  end if;

  return new;
end;
$$;

create trigger stamp_prayer
  before insert or update on public.prayers
  for each row execute function public.stamp_prayer();

-- ---------------------------------------------------------------------------
-- prayed_marks: members see marks in their groups (for "Prayed 3x" totals);
-- users add and delete only their own, and only on prayers they can pray for.
-- ---------------------------------------------------------------------------

create policy marks_select on public.prayed_marks
  for select to authenticated
  using (
    exists (
      select 1 from public.prayers p
      where p.id = prayer_id and public.is_active_member(p.group_id)
    )
  );

create policy marks_insert on public.prayed_marks
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.prayers p
      where p.id = prayer_id
        and p.status in ('active', 'answered')
        and public.is_active_member(p.group_id)
    )
  );

create policy marks_delete on public.prayed_marks
  for delete to authenticated
  using (user_id = auth.uid());

-- No updates to marks: delete and re-add instead.
revoke update on public.prayed_marks from authenticated;

-- ---------------------------------------------------------------------------
-- Function privileges: signed-in users only.
-- ---------------------------------------------------------------------------

revoke execute on function public.create_group(text, text)   from public, anon;
revoke execute on function public.join_group(text)           from public, anon;
revoke execute on function public.rotate_invite_code(uuid)   from public, anon;
revoke execute on function public.handle_new_user()          from public, anon, authenticated;
revoke execute on function public.generate_invite_code()     from public, anon, authenticated;

grant execute on function public.create_group(text, text)   to authenticated;
grant execute on function public.join_group(text)           to authenticated;
grant execute on function public.rotate_invite_code(uuid)   to authenticated;
