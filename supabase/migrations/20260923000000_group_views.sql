-- Read helpers for the app's group screens.
--
-- my_groups(): every group the caller belongs to, including ones they are still pending in.
--   A pending member learns only the group's name and their own status (the groups table itself
--   stays hidden until they are active). Invite codes are returned only to approvers and the owner.
--
-- group_roster(gid): the people in a group with their display names, for the People screen.
--   Active members see active members. Approvers and the owner also see pending join requests.
--   Non-members get nothing.

create or replace function public.my_groups()
returns table (
  group_id         uuid,
  name             text,
  role             text,
  status           text,
  require_approval boolean,
  invite_code      text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    g.id,
    g.name,
    m.role,
    m.status,
    case when m.status = 'active' then g.require_approval end,
    case when m.status = 'active' and m.role in ('owner', 'approver') then g.invite_code end
  from public.group_members m
  join public.groups g on g.id = m.group_id
  where m.user_id = auth.uid()
  order by g.name, g.id;
$$;

create or replace function public.group_roster(p_group_id uuid)
returns table (
  user_id      uuid,
  display_name text,
  role         text,
  status       text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, p.display_name, m.role, m.status, m.created_at
  from public.group_members m
  left join public.profiles p on p.id = m.user_id
  where m.group_id = p_group_id
    and public.is_active_member(p_group_id)
    and (m.status = 'active' or public.is_approver(p_group_id))
  order by
    case m.status when 'pending' then 0 else 1 end,
    case m.role when 'owner' then 0 when 'approver' then 1 else 2 end,
    lower(coalesce(p.display_name, '')),
    m.created_at;
$$;

revoke execute on function public.my_groups()           from public, anon;
revoke execute on function public.group_roster(uuid)    from public, anon;
grant  execute on function public.my_groups()           to authenticated;
grant  execute on function public.group_roster(uuid)    to authenticated;
