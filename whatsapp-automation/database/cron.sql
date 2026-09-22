-- =====================================================================
-- cron.sql - Ejecuta el worker de mensajes cada minuto usando Supabase
--
-- Por que existe: en el plan gratuito de Vercel los Cron Jobs solo
-- pueden correr UNA vez al dia. Supabase (pg_cron + pg_net) puede
-- llamar a tu backend en Vercel cada minuto, gratis.
--
-- Como usarlo: Supabase Dashboard -> SQL Editor. Ejecutalo DESPUES de
-- desplegar en Vercel (necesitas la URL final y el CRON_SECRET).
-- Reemplaza los dos valores marcados con  <<< CAMBIAR  y ejecuta.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Guarda URL y secreto en Vault (cifrado; no quedan en texto plano en el job).
--    Si ya los creaste antes, este paso falla por nombre repetido: usa
--    el bloque "Actualizar valores" de abajo.
select vault.create_secret('https://TU-PROYECTO.vercel.app', 'wa_backend_url');      -- <<< CAMBIAR (sin "/" al final)
select vault.create_secret('PEGA_AQUI_TU_CRON_SECRET',      'wa_cron_secret');       -- <<< CAMBIAR (el mismo de Vercel)

-- 2) Programa la llamada cada minuto.
select cron.schedule(
  'wa-worker-tick',
  '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'wa_backend_url') || '/api/cron/tick',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'wa_cron_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------
-- Ver si el job existe y su historial:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
-- Ver respuestas HTTP (status 200 = OK, 401 = secreto incorrecto):
--   select id, status_code, content, error_msg, created from net._http_response order by created desc limit 10;
-- Pausar / eliminar el job:
--   select cron.unschedule('wa-worker-tick');
-- Actualizar valores en Vault (si cambias de dominio o de secreto):
--   select vault.update_secret((select id from vault.secrets where name = 'wa_backend_url'), 'https://nuevo.vercel.app');
--   select vault.update_secret((select id from vault.secrets where name = 'wa_cron_secret'), 'nuevo_secreto');
