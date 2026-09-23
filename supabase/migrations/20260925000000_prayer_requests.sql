-- Prayer requests: the requester may add their name ("your name (optional)" on the request form).
-- It's shown with the prayer as "Requested by …". Left blank, the request carries no name.

alter table public.prayers
  add column requester_name text
    check (requester_name is null or char_length(requester_name) between 1 and 80);
