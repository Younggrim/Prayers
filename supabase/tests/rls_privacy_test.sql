-- Upheld privacy tests for Row Level Security.
--
-- Proves, among other things, that:
--   * a signed-in user who is not a member of a group cannot read its lists or prayers,
--   * a member cannot see another member's pending request,
--   * only approvers or the owner can approve members and prayers.
--
-- Everything runs inside one transaction that is rolled back, so it leaves no data behind.
-- All people here are fake test users.
--
-- Run against a local Supabase stack:
--   supabase start && supabase db reset
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/rls_privacy_test.sql
-- Or against the hosted project (Dashboard > Connect > connection string, postgres user):
--   psql "$DATABASE_URL" -f supabase/tests/rls_privacy_test.sql
--
-- Exit status is non-zero if any check fails.

\set ON_ERROR_STOP on
\set QUIET on
\pset footer off
\pset pager off
\o /dev/null

begin;

-- ---------------------------------------------------------------------------
-- Test harness (temporary; disappears with the session)
-- ---------------------------------------------------------------------------

create temp table results (n serial, label text, ok boolean, detail text);
grant all on results to authenticated, anon;
grant usage on sequence results_n_seq to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant select on ids to authenticated, anon;

create function pg_temp.id(key text) returns uuid language sql stable
as $$ select v from ids where k = key $$;

-- Act as a signed-in user (by key), or as a signed-out visitor ('anon').
create function pg_temp.act_as(who text) returns void language plpgsql as $$
begin
  if who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', pg_temp.id(who), 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', pg_temp.id(who)::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $$;

create function pg_temp.check(label text, ok boolean, detail text default null) returns void
language sql as $$ insert into results (label, ok, detail) values (label, coalesce(ok, false), detail) $$;

-- Run a query that returns one number and compare it.
create function pg_temp.expect_count(label text, q text, expected bigint) returns void
language plpgsql as $$
declare got bigint;
begin
  execute q into got;
  perform pg_temp.check(label, got = expected, format('expected %s, got %s', expected, got));
exception when others then
  perform pg_temp.check(label, false, 'error: ' || sqlerrm);
end $$;

-- Run a statement that must be refused: it raises, or it changes no rows.
create function pg_temp.expect_blocked(label text, q text) returns void
language plpgsql as $$
declare n bigint;
begin
  execute q;
  get diagnostics n = row_count;
  perform pg_temp.check(label, n = 0, format('statement affected %s row(s)', n));
exception when others then
  perform pg_temp.check(label, true, 'refused: ' || sqlerrm);
end $$;

-- Run a statement that must succeed and change at least one row.
create function pg_temp.expect_ok(label text, q text) returns void
language plpgsql as $$
declare n bigint;
begin
  execute q;
  get diagnostics n = row_count;
  perform pg_temp.check(label, n > 0, format('statement affected %s row(s)', n));
exception when others then
  perform pg_temp.check(label, false, 'error: ' || sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- Fake users
-- ---------------------------------------------------------------------------

insert into ids (k, v) values
  ('owner',    gen_random_uuid()),
  ('approver', gen_random_uuid()),
  ('member',   gen_random_uuid()),
  ('member2',  gen_random_uuid()),
  ('pending',  gen_random_uuid()),
  ('outsider', gen_random_uuid());

insert into auth.users (id, email, raw_user_meta_data)
select v, k || '@example.test', json_build_object('display_name', 'Sample ' || initcap(k))::jsonb
from ids;

-- ---------------------------------------------------------------------------
-- Setup, done through the app's own paths
-- ---------------------------------------------------------------------------

select pg_temp.act_as('owner');
select pg_temp.check('owner can create a group via create_group()',
  (select g.id is not null from public.create_group('Sample Group', 'Fake group for tests') g));
reset role;
insert into ids select 'group', id from public.groups where name = 'Sample Group' and created_by = pg_temp.id('owner');
insert into ids values ('list', gen_random_uuid());

select pg_temp.act_as('owner');
select pg_temp.expect_count('creator is the active owner',
  format($q$select count(*) from public.group_members where group_id = %L and user_id = %L and role = 'owner' and status = 'active'$q$,
         pg_temp.id('group'), pg_temp.id('owner')), 1);
select pg_temp.expect_ok('owner can add a list',
  format($q$insert into public.lists (id, group_id, name, sort_order) values (%L, %L, 'Sample List', 1)$q$,
         pg_temp.id('list'), pg_temp.id('group')));
select pg_temp.expect_ok('owner can post an active prayer',
  format($q$insert into public.prayers (group_id, list_id, title, body, status, requested_by)
            values (%L, %L, 'Sample Person', 'Heavenly Father, we lift up Sample Person.', 'active', %L)$q$,
         pg_temp.id('group'), pg_temp.id('list'), pg_temp.id('owner')));
reset role;
insert into ids select 'active_prayer', id from public.prayers where title = 'Sample Person' and group_id = pg_temp.id('group');

-- Everyone but the outsider joins with the invite code.
do $$
declare who text; code text;
begin
  select invite_code into code from public.groups where id = pg_temp.id('group');
  foreach who in array array['approver', 'member', 'member2', 'pending'] loop
    perform pg_temp.act_as(who);
    perform pg_temp.check(who || ' joins with the invite code and is pending',
      (select j.status = 'pending' from public.join_group(lower(code)) j));
    reset role;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Pending members see nothing yet
-- ---------------------------------------------------------------------------

select pg_temp.act_as('member');
select pg_temp.expect_count('pending member cannot read the group',
  format('select count(*) from public.groups where id = %L', pg_temp.id('group')), 0);
select pg_temp.expect_count('pending member cannot read lists',
  format('select count(*) from public.lists where group_id = %L', pg_temp.id('group')), 0);
select pg_temp.expect_count('pending member cannot read prayers',
  format('select count(*) from public.prayers where group_id = %L', pg_temp.id('group')), 0);
select pg_temp.expect_count('pending member sees only their own membership row',
  format('select count(*) from public.group_members where group_id = %L', pg_temp.id('group')), 1);
select pg_temp.expect_blocked('pending member cannot approve themselves',
  format($q$update public.group_members set status = 'active' where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('member')));
reset role;

-- ---------------------------------------------------------------------------
-- Owner approves members and chooses an approver
-- ---------------------------------------------------------------------------

select pg_temp.act_as('owner');
select pg_temp.expect_count('owner sees all four pending join requests',
  format($q$select count(*) from public.group_members where group_id = %L and status = 'pending'$q$, pg_temp.id('group')), 4);
select pg_temp.expect_ok('owner can approve a member',
  format($q$update public.group_members set status = 'active' where group_id = %L and user_id in (%L, %L)$q$,
         pg_temp.id('group'), pg_temp.id('approver'), pg_temp.id('member')));
select pg_temp.expect_ok('owner can make an active member an approver',
  format($q$update public.group_members set role = 'approver' where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('approver')));
reset role;

select pg_temp.act_as('member');
select pg_temp.expect_count('a member cannot see other people''s pending join requests',
  format($q$select count(*) from public.group_members where group_id = %L and status = 'pending'$q$, pg_temp.id('group')), 0);
select pg_temp.expect_blocked('a member cannot approve a pending member',
  format($q$update public.group_members set status = 'active' where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('member2')));
select pg_temp.expect_blocked('a member cannot make themselves an approver',
  format($q$update public.group_members set role = 'approver' where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('member')));
select pg_temp.expect_blocked('a member cannot remove another member',
  format($q$delete from public.group_members where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('approver')));
reset role;

select pg_temp.act_as('approver');
select pg_temp.expect_ok('an approver can approve a pending member',
  format($q$update public.group_members set status = 'active' where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('member2')));
select pg_temp.expect_blocked('an approver cannot change roles',
  format($q$update public.group_members set role = 'approver' where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('member')));
select pg_temp.expect_blocked('an approver cannot remove the owner',
  format($q$delete from public.group_members where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('owner')));
select pg_temp.expect_blocked('an approver cannot change group settings',
  format($q$update public.groups set require_approval = false where id = %L$q$, pg_temp.id('group')));
reset role;

-- ---------------------------------------------------------------------------
-- Outsiders and signed-out visitors
-- ---------------------------------------------------------------------------

select pg_temp.act_as('outsider');
select pg_temp.expect_count('non-member cannot read the group',
  format('select count(*) from public.groups where id = %L', pg_temp.id('group')), 0);
select pg_temp.expect_count('non-member cannot read its lists',
  format('select count(*) from public.lists where group_id = %L', pg_temp.id('group')), 0);
select pg_temp.expect_count('non-member cannot read its prayers',
  format('select count(*) from public.prayers where group_id = %L', pg_temp.id('group')), 0);
select pg_temp.expect_count('non-member cannot read its members',
  format('select count(*) from public.group_members where group_id = %L', pg_temp.id('group')), 0);
select pg_temp.expect_count('non-member cannot read members'' profiles',
  format('select count(*) from public.profiles where id = %L', pg_temp.id('member')), 0);
select pg_temp.expect_blocked('non-member cannot add a prayer',
  format($q$insert into public.prayers (group_id, title, status, requested_by) values (%L, 'Sample', 'pending', %L)$q$,
         pg_temp.id('group'), pg_temp.id('outsider')));
select pg_temp.expect_blocked('non-member cannot add a list',
  format($q$insert into public.lists (group_id, name) values (%L, 'Sample')$q$, pg_temp.id('group')));
select pg_temp.expect_blocked('non-member cannot mark a prayer prayed',
  format($q$insert into public.prayed_marks (prayer_id, user_id) values (%L, %L)$q$,
         pg_temp.id('active_prayer'), pg_temp.id('outsider')));
select pg_temp.expect_blocked('non-member cannot add themselves as an active member',
  format($q$insert into public.group_members (group_id, user_id, role, status) values (%L, %L, 'owner', 'active')$q$,
         pg_temp.id('group'), pg_temp.id('outsider')));
select pg_temp.expect_blocked('a wrong invite code is rejected',
  $q$select * from public.join_group('NOTACODE')$q$);
reset role;

select pg_temp.act_as('anon');
select pg_temp.expect_blocked('signed-out visitor cannot read prayers',
  'select count(*) from public.prayers');
select pg_temp.expect_blocked('signed-out visitor cannot read groups',
  'select count(*) from public.groups');
select pg_temp.expect_blocked('signed-out visitor cannot join a group',
  $q$select * from public.join_group('ANYCODE1')$q$);
reset role;

-- ---------------------------------------------------------------------------
-- my_groups() and group_roster()
-- ---------------------------------------------------------------------------

select pg_temp.act_as('pending');
select pg_temp.expect_count('a pending member sees their own pending group in my_groups()',
  format($q$select count(*) from public.my_groups() where group_id = %L and status = 'pending' and name = 'Sample Group'$q$,
         pg_temp.id('group')), 1);
select pg_temp.expect_count('a pending member does not get the invite code or settings',
  format($q$select count(*) from public.my_groups() where group_id = %L and (invite_code is not null or require_approval is not null)$q$,
         pg_temp.id('group')), 0);
select pg_temp.expect_count('a pending member cannot read the roster',
  format('select count(*) from public.group_roster(%L)', pg_temp.id('group')), 0);
reset role;

select pg_temp.act_as('member');
select pg_temp.expect_count('a member does not get the invite code',
  format($q$select count(*) from public.my_groups() where group_id = %L and invite_code is not null$q$, pg_temp.id('group')), 0);
select pg_temp.expect_count('a member''s roster shows only active people',
  format($q$select count(*) from public.group_roster(%L) where status = 'pending'$q$, pg_temp.id('group')), 0);
select pg_temp.expect_count('a member''s roster shows the four active people',
  format('select count(*) from public.group_roster(%L)', pg_temp.id('group')), 4);
reset role;

select pg_temp.act_as('approver');
select pg_temp.expect_count('an approver gets the invite code',
  format($q$select count(*) from public.my_groups() where group_id = %L and invite_code is not null$q$, pg_temp.id('group')), 1);
select pg_temp.expect_count('an approver''s roster includes pending join requests with names',
  format($q$select count(*) from public.group_roster(%L) where status = 'pending' and display_name = 'Sample Pending'$q$,
         pg_temp.id('group')), 1);
reset role;

select pg_temp.act_as('outsider');
select pg_temp.expect_count('a non-member sees no groups in my_groups()',
  'select count(*) from public.my_groups()', 0);
select pg_temp.expect_count('a non-member cannot read the roster',
  format('select count(*) from public.group_roster(%L)', pg_temp.id('group')), 0);
reset role;

select pg_temp.act_as('anon');
select pg_temp.expect_blocked('a signed-out visitor cannot call my_groups()',
  'select count(*) from public.my_groups()');
select pg_temp.expect_blocked('a signed-out visitor cannot call group_roster()',
  format('select count(*) from public.group_roster(%L)', pg_temp.id('group')));
reset role;

-- ---------------------------------------------------------------------------
-- Prayer requests and approvals
-- ---------------------------------------------------------------------------

select pg_temp.act_as('member');
select pg_temp.expect_count('an active member can read lists',
  format('select count(*) from public.lists where group_id = %L', pg_temp.id('group')), 1);
select pg_temp.expect_count('an active member can read active prayers',
  format($q$select count(*) from public.prayers where group_id = %L and status = 'active'$q$, pg_temp.id('group')), 1);
select pg_temp.expect_ok('a member can submit a pending request',
  format($q$insert into public.prayers (group_id, list_id, title, body, status, requested_by)
            values (%L, %L, 'Sample Request', 'Heavenly Father, we lift up Sample Friend.', 'pending', %L)$q$,
         pg_temp.id('group'), pg_temp.id('list'), pg_temp.id('member')));
select pg_temp.expect_blocked('a member cannot post directly when approval is required',
  format($q$insert into public.prayers (group_id, title, status, requested_by) values (%L, 'Sample Skip', 'active', %L)$q$,
         pg_temp.id('group'), pg_temp.id('member')));
select pg_temp.expect_blocked('a member cannot submit a request as someone else',
  format($q$insert into public.prayers (group_id, title, status, requested_by) values (%L, 'Sample Spoof', 'pending', %L)$q$,
         pg_temp.id('group'), pg_temp.id('member2')));
select pg_temp.expect_count('the requester can see their own pending request',
  format($q$select count(*) from public.prayers where group_id = %L and status = 'pending'$q$, pg_temp.id('group')), 1);
reset role;
insert into ids select 'pending_prayer', id from public.prayers where title = 'Sample Request' and group_id = pg_temp.id('group');

select pg_temp.act_as('member2');
select pg_temp.expect_count('another member cannot see someone else''s pending request',
  format($q$select count(*) from public.prayers where id = %L$q$, pg_temp.id('pending_prayer')), 0);
select pg_temp.expect_blocked('another member cannot approve a pending request',
  format($q$update public.prayers set status = 'active' where id = %L$q$, pg_temp.id('pending_prayer')));
reset role;

select pg_temp.act_as('member');
select pg_temp.expect_blocked('the requester cannot approve their own request',
  format($q$update public.prayers set status = 'active' where id = %L$q$, pg_temp.id('pending_prayer')));
select pg_temp.expect_blocked('a member cannot edit an active prayer',
  format($q$update public.prayers set title = 'Changed' where id = %L$q$, pg_temp.id('active_prayer')));
select pg_temp.expect_blocked('a member cannot mark a prayer answered',
  format($q$update public.prayers set status = 'answered' where id = %L$q$, pg_temp.id('active_prayer')));
select pg_temp.expect_blocked('a member cannot delete a prayer',
  format($q$delete from public.prayers where id = %L$q$, pg_temp.id('active_prayer')));
reset role;

select pg_temp.act_as('outsider');
select pg_temp.expect_blocked('a non-member cannot approve a pending request',
  format($q$update public.prayers set status = 'active' where id = %L$q$, pg_temp.id('pending_prayer')));
reset role;

select pg_temp.act_as('approver');
select pg_temp.expect_count('an approver can see pending requests',
  format($q$select count(*) from public.prayers where id = %L$q$, pg_temp.id('pending_prayer')), 1);
select pg_temp.expect_ok('an approver can edit and approve a request',
  format($q$update public.prayers set status = 'active', title = 'Sample Request (edited)' where id = %L$q$,
         pg_temp.id('pending_prayer')));
select pg_temp.expect_count('approval records who approved it',
  format($q$select count(*) from public.prayers where id = %L and approved_by = %L$q$,
         pg_temp.id('pending_prayer'), pg_temp.id('approver')), 1);
reset role;

select pg_temp.act_as('member2');
select pg_temp.expect_count('once approved, other members can see the request',
  format($q$select count(*) from public.prayers where id = %L$q$, pg_temp.id('pending_prayer')), 1);
reset role;

-- ---------------------------------------------------------------------------
-- Answered prayer and removal
-- ---------------------------------------------------------------------------

select pg_temp.act_as('approver');
select pg_temp.expect_ok('an approver can mark a prayer answered',
  format($q$update public.prayers set status = 'answered' where id = %L$q$, pg_temp.id('pending_prayer')));
select pg_temp.expect_count('answered_at is stamped',
  format($q$select count(*) from public.prayers where id = %L and answered_at is not null$q$, pg_temp.id('pending_prayer')), 1);
select pg_temp.expect_ok('an approver can remove a prayer',
  format($q$update public.prayers set status = 'removed' where id = %L$q$, pg_temp.id('active_prayer')));
reset role;

select pg_temp.act_as('member2');
select pg_temp.expect_count('members still see answered prayers (Praise)',
  format($q$select count(*) from public.prayers where id = %L and status = 'answered'$q$, pg_temp.id('pending_prayer')), 1);
select pg_temp.expect_count('members cannot see removed prayers',
  format($q$select count(*) from public.prayers where id = %L$q$, pg_temp.id('active_prayer')), 0);
reset role;

-- ---------------------------------------------------------------------------
-- "I prayed" marks
-- ---------------------------------------------------------------------------

select pg_temp.act_as('member');
select pg_temp.expect_ok('a member can mark a prayer prayed',
  format($q$insert into public.prayed_marks (prayer_id, user_id) values (%L, %L)$q$,
         pg_temp.id('pending_prayer'), pg_temp.id('member')));
select pg_temp.expect_ok('a member can mark it prayed again',
  format($q$insert into public.prayed_marks (prayer_id, user_id) values (%L, %L)$q$,
         pg_temp.id('pending_prayer'), pg_temp.id('member')));
select pg_temp.expect_blocked('a member cannot add a mark for someone else',
  format($q$insert into public.prayed_marks (prayer_id, user_id) values (%L, %L)$q$,
         pg_temp.id('pending_prayer'), pg_temp.id('member2')));
reset role;

select pg_temp.act_as('member2');
select pg_temp.expect_count('other members see the "Prayed 2x" total',
  format('select count(*) from public.prayed_marks where prayer_id = %L', pg_temp.id('pending_prayer')), 2);
select pg_temp.expect_blocked('a member cannot delete someone else''s mark',
  format('delete from public.prayed_marks where prayer_id = %L', pg_temp.id('pending_prayer')));
reset role;

select pg_temp.act_as('outsider');
select pg_temp.expect_count('non-members cannot see prayed marks',
  format('select count(*) from public.prayed_marks where prayer_id = %L', pg_temp.id('pending_prayer')), 0);
reset role;

select pg_temp.act_as('member');
select pg_temp.expect_ok('a member can delete their own mark',
  format('delete from public.prayed_marks where prayer_id = %L and user_id = %L', pg_temp.id('pending_prayer'), pg_temp.id('member')));
reset role;

-- ---------------------------------------------------------------------------
-- Require approval setting
-- ---------------------------------------------------------------------------

select pg_temp.act_as('owner');
select pg_temp.expect_ok('owner can turn off "Require approval for new requests"',
  format($q$update public.groups set require_approval = false where id = %L$q$, pg_temp.id('group')));
reset role;

select pg_temp.act_as('member');
select pg_temp.expect_ok('with approval off, a member''s request posts directly',
  format($q$insert into public.prayers (group_id, title, status, requested_by) values (%L, 'Sample Direct', 'active', %L)$q$,
         pg_temp.id('group'), pg_temp.id('member')));
reset role;

-- ---------------------------------------------------------------------------
-- Removing and leaving
-- ---------------------------------------------------------------------------

select pg_temp.act_as('approver');
select pg_temp.expect_ok('an approver can decline a pending join request',
  format($q$delete from public.group_members where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('pending')));
reset role;

select pg_temp.act_as('owner');
select pg_temp.expect_ok('owner can remove a member',
  format($q$delete from public.group_members where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('member2')));
select pg_temp.expect_blocked('owner cannot leave (the group would be ownerless)',
  format($q$delete from public.group_members where group_id = %L and user_id = %L$q$,
         pg_temp.id('group'), pg_temp.id('owner')));
reset role;

select pg_temp.act_as('member2');
select pg_temp.expect_count('a removed member can no longer read prayers',
  format('select count(*) from public.prayers where group_id = %L', pg_temp.id('group')), 0);
reset role;

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------

\o
\echo ''
select n as "#", case when ok then 'PASS' else 'FAIL' end as result, label as "check",
       case when ok then '' else detail end as detail
from results order by n;

select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from results;

do $$
begin
  if exists (select 1 from results where not ok) then
    raise exception 'RLS privacy tests failed';
  end if;
  raise notice 'All RLS privacy tests passed.';
end $$;

rollback;
