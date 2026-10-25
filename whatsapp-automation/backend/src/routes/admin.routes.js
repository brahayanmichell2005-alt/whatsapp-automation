// Diagnostico temporal de Evolution API. Se elimina al terminar.
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

function brief(response) {
  if (!response) return null;
  if (response.error) return { error: response.error, code: response.code };
  return {
    status: response.status,
    statusText: response.statusText,
    data:
      typeof response.data === 'string'
        ? response.data.slice(0, 600)
        : response.data,
  };
}

router.get('/diagnose', tempAuth, async (req, res) => {
  const url = String(env.EVOLUTION_API_URL || '');
  const result = {
    url,
    instance: env.EVOLUTION_INSTANCE,
    hasKey: Boolean(env.EVOLUTION_API_KEY),
    root: null,
    instances: null,
    state: null,
    envKeys: [],
    settings: [],
    logs: [],
  };

  result.envKeys = Object.keys(process.env).filter((key) =>
    /EVOLUTION|RAILWAY|WHATSAPP/i.test(key)
  );

  try {
    const { rows } = await pool.query(
      'SELECT "key", "value" FROM system_settings ORDER BY "key"'
    );
    result.settings = rows;
  } catch (err) {
    result.settings = [{ error: String(err.message || err) }];
  }

  try {
    const { rows } = await pool.query(
      'SELECT created_at, event_type, level, message FROM automation_logs ORDER BY created_at DESC LIMIT 15'
    );
    result.logs = rows;
  } catch (err) {
    result.logs = [{ error: String(err.message || err) }];
  }

  try {
    result.root = brief(
      await axios.get(url, { timeout: 15000, validateStatus: () => true })
    );
  } catch (err) {
    result.root = { error: String(err.message || err), code: err.code || null };
  }

  try {
    result.instances = brief(
      await axios.get(`${url}/instance/fetchInstances`, {
        headers: { apikey: env.EVOLUTION_API_KEY },
        timeout: 15000,
        validateStatus: () => true,
      })
    );
  } catch (err) {
    result.instances = { error: String(err.message || err), code: err.code || null };
  }

  try {
    result.state = await evolutionService.checkConnection();
  } catch (err) {
    result.state = { error: String(err.message || err) };
  }

  res.json(result);
});

router.post('/connect', tempAuth, async (req, res, next) => {
  try {
    const qr = await evolutionService.getQrCode({});
    res.json({
      ok: true,
      status: qr.status,
      pending: qr.pending,
      base64: qr.base64,
      code: qr.code,
      pairingCode: qr.pairingCode,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
