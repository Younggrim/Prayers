-- Lists members can add to. Each list has members_can_add (default true). Approvers and the owner
-- can add to any list; members only to lists where it's on. A member request with no list is
-- allowed only while every list in the group is open to members, so a group that restricts some
-- lists steers requests into its open ones.
--
-- Editing prayers was already limited to approvers and the owner (prayers_update policy).

alter table public.lists
  add column members_can_add boolean not null default true;

create or replace function public.member_can_post_to(p_group_id uuid, p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_list_id is not null then exists (
      select 1 from public.lists l
      where l.id = p_list_id and l.group_id = p_group_id and l.members_can_add)
    else not exists (
      select 1 from public.lists l
      where l.group_id = p_group_id and not l.members_can_add)
  end;
$$;

revoke execute on function public.member_can_post_to(uuid, uuid) from public, anon;
grant  execute on function public.member_can_post_to(uuid, uuid) to authenticated;

drop policy prayers_insert on public.prayers;
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
    and (public.is_approver(group_id) or public.member_can_post_to(group_id, list_id))
  );
