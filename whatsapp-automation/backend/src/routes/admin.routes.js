// Ruta TEMPORAL de migracion a Oracle Cloud. Se elimina al terminar.
// Token protegido; nunca imprime secretos en logs.
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const router = express.Router();
const env = require('../config/env');
const evolutionService = require('../services/evolution.service');
const { pool } = require('../config/database');
const { safeEqual } = require('../middleware/webhookAuth');

const TEMP_TOKEN_HASH = 'e5014e3e3918933f6c1b65ef399ebc3632da5db0020f2742b5f45b451868ca46';

function tempAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const provided = header.replace(/^Bearer\s+/i, '');
  if (provided) {
    const hash = crypto.createHash('sha256').update(provided).digest('hex');
    if (safeEqual(hash, TEMP_TOKEN_HASH)) return next();
  }
  return res.status(404).json({ error: 'not found' });
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

router.use(tempAuth);

router.get('/config', async (req, res, next) => {
  try {
    res.json({
      effective_url: await evolutionService.getBaseUrl(),
      env_url: normalizeUrl(env.EVOLUTION_API_URL),
      instance: env.EVOLUTION_INSTANCE,
      has_api_key: Boolean(env.EVOLUTION_API_KEY),
      has_webhook_secret: Boolean(env.WEBHOOK_SECRET),
      webhook_url: env.WEBHOOK_URL || null,
      ai_provider: env.AI_PROVIDER,
      ai_model: env.AI_MODEL || null,
      ai_enabled: Boolean(env.AI_PROVIDER && env.AI_PROVIDER !== 'none'),
      has_gemini_key: Boolean(env.GEMINI_API_KEY),
      start_time: env.START_TIME,
      end_time: env.END_TIME,
      timezone: env.TIMEZONE,
    });
  } catch (err) {
    next(err);
  }
});

// Devuelve las credenciales existentes para reutilizarlas en el nuevo host.
// Se llama una sola vez y se guardan en un archivo local restringido.
router.get('/secrets', (req, res) => {
  res.json({
    evolution_api_key: env.EVOLUTION_API_KEY,
    webhook_secret: env.WEBHOOK_SECRET,
    webhook_url: env.WEBHOOK_URL,
    instance: env.EVOLUTION_INSTANCE,
    database_url: env.DATABASE_URL,
    db_ssl: env.DB_SSL,
  });
});

router.post('/set-url', async (req, res, next) => {
  try {
    const url = normalizeUrl(req.body && req.body.url);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      return res.status(400).json({ error: 'URL invalida: usa http(s)://host' });
    }
    await pool.query(
      `INSERT INTO system_settings ("key", "value")
       VALUES ('evolution_api_url', $1)
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
      [url]
    );
    evolutionService.clearUrlCache();
    return res.json({ ok: true, evolution_api_url: url });
  } catch (err) {
    return next(err);
  }
});

router.post('/clear-url', async (req, res, next) => {
  try {
    await pool.query("DELETE FROM system_settings WHERE \"key\" = 'evolution_api_url'");
    evolutionService.clearUrlCache();
    return res.json({ ok: true, cleared: true });
  } catch (err) {
    return next(err);
  }
});

router.get('/state', async (req, res, next) => {
  try {
    res.json(await evolutionService.checkConnection());
  } catch (err) {
    next(err);
  }
});

router.post('/connect', async (req, res, next) => {
  try {
    const data = await evolutionService.getQrCode({ number: req.body && req.body.number });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/set-webhook', async (req, res, next) => {
  try {
    const data = await evolutionService.setWebhook({ url: req.body && req.body.url });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/fetch-instances', async (req, res, next) => {
  try {
    const baseURL = await evolutionService.getBaseUrl();
    const { data, status } = await axios.get(`${baseURL}/instance/fetchInstances`, {
      timeout: 15000,
      headers: { apikey: env.EVOLUTION_API_KEY },
    });
    res.status(status).json(data);
  } catch (err) {
    const status = (err.response && err.response.status) || 502;
    res.status(status).json({
      error: (err.response && err.response.data) || err.message,
    });
  }
});

module.exports = router;
