-- "Prayed 3x" totals for a group's visible prayers, without sending every mark to the phone.
-- Returns one row per prayer that has marks: the group total and how many are the caller's.
-- Active members only; pending and removed prayers are never counted here.

create or replace function public.prayed_totals(p_group_id uuid)
returns table (prayer_id uuid, total bigint, mine bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select pm.prayer_id,
         count(*),
         count(*) filter (where pm.user_id = auth.uid())
  from public.prayed_marks pm
  join public.prayers p on p.id = pm.prayer_id
  where p.group_id = p_group_id
    and p.status in ('active', 'answered')
    and public.is_active_member(p_group_id)
  group by pm.prayer_id;
$$;

revoke execute on function public.prayed_totals(uuid) from public, anon;
grant  execute on function public.prayed_totals(uuid) to authenticated;
