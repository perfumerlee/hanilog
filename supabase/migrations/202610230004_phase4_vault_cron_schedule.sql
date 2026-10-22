-- Configure Vault secrets before this migration to install the hosted/local-safe recurring job.
-- Missing Vault/cron/net support or missing secrets intentionally leaves scheduling disabled.
do $$
begin
  if to_regnamespace('vault') is null or to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise notice 'Notification cron was not installed: Vault, pg_cron, or pg_net is unavailable.';
    return;
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name in ('hanilog_project_url','hanilog_publishable_key','hanilog_notification_worker_secret')
    having count(distinct name)=3
  ) then
    raise notice 'Notification cron was not installed: configure the three HaniLog Vault secrets first.';
    return;
  end if;

  execute $schedule$
    select cron.schedule(
      'hanilog-notification-worker',
      '* * * * *',
      $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name='hanilog_project_url') || '/functions/v1/notification-worker',
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'apikey',(select decrypted_secret from vault.decrypted_secrets where name='hanilog_publishable_key'),
            'x-hanilog-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='hanilog_notification_worker_secret')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 10000
        );
      $job$
    );
  $schedule$;
end;
$$;
