-- Run the send-notifications Edge Function every minute with pg_cron + pg_net.
-- Kept separate from the schema migration so the tables still apply if scheduling needs attention.
-- The function only sends what is due and marks it sent, so an extra call never duplicates a push.
-- Skipped automatically where the extensions aren't available (e.g. the local test database).

do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;

    if exists (select 1 from cron.job where jobname = 'upheld-send-notifications') then
      perform cron.unschedule('upheld-send-notifications');
    end if;

    perform cron.schedule(
      'upheld-send-notifications',
      '* * * * *',
      $job$
        select net.http_post(
          url := 'https://vyiznjphjwehawdzapce.supabase.co/functions/v1/send-notifications',
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body := '{}'::jsonb,
          timeout_milliseconds := 20000
        );
      $job$
    );
  end if;
end;
$outer$;
