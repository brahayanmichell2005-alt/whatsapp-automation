// Revision temporal de solo lectura. Se elimina al terminar.
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const env = require('../config/env');
const aiService = require('../services/ai.service');
const evolutionService = require('../services/evolution.service');
const messageWorker = require('../workers/message.worker');
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

async function q(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return { rows: r.rows };
  } catch (err) {
    return { error: err.message };
  }
}

router.get('/recent', tempAuth, async (req, res) => {
  const phone = req.query.phone ? String(req.query.phone) : '';
  const search = req.query.q ? String(req.query.q) : '';
  const [customers, messages, logs, queue, conversations, settings] = await Promise.all([
    q(
      `SELECT id, phone, name, status, interest_type, last_message_at, created_at
         FROM customers ORDER BY id DESC LIMIT 50`
    ),
    q(
      `SELECT m.id, m.customer_id, c.phone, c.name, m.direction, m.content,
              m.external_message_id, m.status, m.created_at
         FROM messages m JOIN customers c ON c.id = m.customer_id
        ORDER BY m.id DESC LIMIT 60`
    ),
    q(
      `SELECT id, event_type, level, message, metadata, created_at
         FROM automation_logs ORDER BY id DESC LIMIT 120`
    ),
    q(
      `SELECT id, customer_id, phone, message, status, attempts, error_message,
              created_at, updated_at
         FROM message_queue ORDER BY id DESC LIMIT 25`
    ),
    q(
      `SELECT c.id, c.customer_id, cu.phone, cu.name, c.status, c.last_message_at, c.created_at
         FROM conversations c JOIN customers cu ON cu.id = c.customer_id
        ORDER BY c.id DESC LIMIT 30`
    ),
    q('SELECT "key", "value" FROM system_settings ORDER BY "key"'),
  ]);

  let focus = null;
  if (phone || search) {
    const like = `%${search || phone}%`;
    const found = await q(
      `SELECT id, phone, name, status, interest_type, last_message_at, created_at
         FROM customers
        WHERE phone = $1 OR phone ILIKE $2 OR name ILIKE $2
        ORDER BY id DESC LIMIT 5`,
      [phone, like]
    );
    const ids = (found.rows || []).map((c) => c.id);
    let focusMessages = { rows: [] };
    let focusQueue = { rows: [] };
    if (ids.length) {
      focusMessages = await q(
        `SELECT id, customer_id, direction, message_type, content, external_message_id,
                status, created_at
           FROM messages WHERE customer_id = ANY($1::int[])
          ORDER BY id DESC LIMIT 40`,
        [ids]
      );
      focusQueue = await q(
        `SELECT id, customer_id, phone, message, status, attempts, error_message,
                created_at, updated_at
           FROM message_queue WHERE customer_id = ANY($1::int[])
          ORDER BY id DESC LIMIT 15`,
        [ids]
      );
    }
    focus = { found, focusMessages, focusQueue };
  }

  res.json({
    ok: true,
    now: new Date().toISOString(),
    phone,
    search,
    customers,
    messages,
    logs,
    queue,
    conversations,
    settings,
    focus,
    ai: {
      enabled: aiService.isEnabled(),
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      lastError: aiService.getLastError(),
      lastModel: aiService.getLastModel(),
    },
    webhookUrl: env.WEBHOOK_URL || null,
  });
});

router.get('/connection', tempAuth, async (req, res) => {
  const state = await evolutionService.checkConnection();
  res.json({ ok: true, state });
});

router.post('/repair', tempAuth, async (req, res, next) => {
  try {
    const result = await evolutionService.setWebhook();
    res.json({ ok: true, targetUrl: env.WEBHOOK_URL || null, result });
  } catch (err) {
    next(err);
  }
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

// Proxy temporal para inspeccionar la API de Evolution (chats/mensajes).
router.post('/evolution', tempAuth, async (req, res) => {
  const { method = 'GET', path, body } = req.body || {};
  if (!path || !String(path).startsWith('/')) {
    return res.status(400).json({ error: 'path requerido' });
  }
  try {
    const r = await axios.request({
      method,
      baseURL: env.EVOLUTION_API_URL,
      url: path,
      data: body,
      headers: { apikey: env.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
      timeout: 20000,
      validateStatus: () => true,
    });
    return res.status(200).json({ ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: (err.response && err.response.status) || null,
      error: String(err.message || 'error').slice(0, 300),
    });
  }
});

// Prueba de extremo a extremo: inyecta un mensaje entrante por el webhook real,
// deja que la IA responda y procesa la cola de inmediato.
router.post('/simulate', tempAuth, async (req, res, next) => {
  try {
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    const text = String((req.body && req.body.text) || 'Hola').slice(0, 500);
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    if (!env.WEBHOOK_URL) return res.status(503).json({ error: 'WEBHOOK_URL no configurado' });

    const externalMessageId = `TEST-${Date.now()}`;
    const payload = {
      event: 'messages.upsert',
      instance: env.EVOLUTION_INSTANCE,
      data: {
        key: {
          id: externalMessageId,
          remoteJid: `${phone}@s.whatsapp.net`,
          fromMe: false,
        },
        pushName: 'Prueba',
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };

    const started = Date.now();
    const webhook = await axios.post(env.WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-token': env.WEBHOOK_SECRET,
      },
      timeout: 50000,
    });
    const worker = await messageWorker.tick({ budgetMs: 45000 });
    res.json({
      ok: true,
      phone,
      text,
      externalMessageId,
      webhookStatus: webhook.status,
      webhook: webhook.data,
      worker,
      tookMs: Date.now() - started,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
