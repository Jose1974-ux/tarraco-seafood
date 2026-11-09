-- Deploy tarraco-telegram before scheduling this worker.
select cron.schedule('tsf-chat-registration-telegram', '* * * * *', $job$
  select net.http_post(
    url := 'https://lmenenuazdqshfrwrwqy.supabase.co/functions/v1/tarraco-telegram',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tarraco-worker', (
      select decrypted_secret from vault.decrypted_secrets where name = 'tarraco_telegram_worker'
    )),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
