// Endpoint temporal de diagnostico. Se elimina despues de resolver el envio.
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { cronAuth } = require('../middleware/cronAuth');
const { safeEqual } = require('../middleware/webhookAuth');
const { pool } = require('../config/database');
const env = require('../config/env');
const messageWorker = require('../workers/message.worker');
const businessHours = require('../utils/businessHours');

const TEMP_TOKEN_HASH = 'e5014e3e3918933f6c1b65ef399ebc3632da5db0020f2742b5f45b451868ca46';
function tempAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const provided = header.replace(/^Bearer\s+/i, '');
  if (provided) {
    const hash = crypto.createHash('sha256').update(provided).digest('hex');
    if (safeEqual(hash, TEMP_TOKEN_HASH)) return next();
  }
  return cronAuth(req, res, next);
}

async function safeQuery(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (err) {
    return { error: err.message };
  }
}

router.get('/diagnose', tempAuth, async (req, res) => {
  const [settings, counts, queue, cronJob, cronRuns, httpResponses, backendUrl, cronSecret] =
    await Promise.all([
      safeQuery(`SELECT "key", "value" FROM system_settings ORDER BY "key"`),
      safeQuery(`SELECT status, count(*)::int AS count FROM message_queue GROUP BY status ORDER BY status`),
      safeQuery(
        `SELECT id, customer_id, phone, message, status, attempts, scheduled_at,
                scheduled_message_id, error_message, created_at, updated_at
           FROM message_queue ORDER BY id DESC LIMIT 20`
      ),
      safeQuery(
        `SELECT jobid, schedule, active, jobname
           FROM cron.job WHERE jobname = 'wa-worker-tick'`
      ),
      safeQuery(
        `SELECT jobid, runid, status, return_message, start_time, end_time
           FROM cron.job_run_details ORDER BY start_time DESC LIMIT 12`
      ),
      safeQuery(
        `SELECT id, status_code, left(content, 400) AS content, error_msg, created
           FROM net._http_response ORDER BY created DESC LIMIT 12`
      ),
      safeQuery(`SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wa_backend_url'`),
      safeQuery(`SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wa_cron_secret'`),
    ]);

  const vaultUrl = backendUrl.rows && backendUrl.rows[0] ? backendUrl.rows[0].decrypted_secret : null;
  const vaultSecret =
    cronSecret.rows && cronSecret.rows[0] ? cronSecret.rows[0].decrypted_secret : null;

  res.json({
    ok: true,
    now: new Date().toISOString(),
    nodeEnv: env.NODE_ENV,
    hasCronSecret: Boolean(env.CRON_SECRET),
    cronSecretMatchesVault: Boolean(vaultSecret && env.CRON_SECRET && vaultSecret === env.CRON_SECRET),
    vaultBackendUrl: vaultUrl,
    businessHours: businessHours.isWithinBusinessHours(),
    settings,
    counts,
    queue,
    cronJob,
    cronRuns,
    httpResponses,
  });
});

router.post('/send-one', tempAuth, async (req, res, next) => {
  try {
    const id = Number(req.body && req.body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id invalido' });
    }
    const before = await pool.query('SELECT * FROM message_queue WHERE id = $1', [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'mensaje no encontrado' });

    const outcome = await messageWorker.processOne(before.rows[0]);
    const after = await pool.query(
      `SELECT id, status, attempts, error_message, sent_at, updated_at
         FROM message_queue WHERE id = $1`,
      [id]
    );
    res.json({ ok: true, outcome, before: before.rows[0], after: after.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

router.post('/fix-cron', tempAuth, async (req, res, next) => {
  try {
    const result = { secretUpdated: false, urlUpdated: false, job: null, error: null };
    const targetUrl = 'https://whatsapp-automation-peach.vercel.app';

    if (!env.CRON_SECRET) {
      return res.status(409).json({ error: 'CRON_SECRET no esta configurado en Vercel' });
    }

    const current = await pool.query(
      `SELECT name, decrypted_secret FROM vault.decrypted_secrets
        WHERE name IN ('wa_backend_url', 'wa_cron_secret')`
    );
    const map = new Map(current.rows.map((r) => [r.name, r.decrypted_secret]));

    if (map.get('wa_cron_secret') !== env.CRON_SECRET) {
      const r = await pool.query(
        `UPDATE vault.secrets
            SET secret = $1, updated_at = NOW()
          WHERE name = 'wa_cron_secret'`,
        [env.CRON_SECRET]
      );
      result.secretUpdated = (r.rowCount || 0) === 1;
    }

    if (!map.get('wa_backend_url') || map.get('wa_backend_url') !== targetUrl) {
      const r = await pool.query(
        `UPDATE vault.secrets
            SET secret = $1, updated_at = NOW()
          WHERE name = 'wa_backend_url'`,
        [targetUrl]
      );
      result.urlUpdated = (r.rowCount || 0) === 1;
    }

    const job = await pool.query(
      `SELECT jobid, schedule, active FROM cron.job WHERE jobname = 'wa-worker-tick'`
    );
    result.job = job.rows[0] || null;
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
