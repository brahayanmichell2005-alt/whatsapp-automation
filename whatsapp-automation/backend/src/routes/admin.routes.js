// Endpoint temporal de diagnostico del mensaje entrante. Se elimina al terminar.
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const env = require('../config/env');
const evolutionService = require('../services/evolution.service');
const messageWorker = require('../workers/message.worker');
const queueModel = require('../models/messageQueue.model');
const aiService = require('../services/ai.service');
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

async function safeQuery(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (err) {
    return { error: err.message };
  }
}

router.get('/recent', tempAuth, async (req, res) => {
  const phone = String(req.query.phone || '51918897402');
  const customer = await safeQuery('SELECT * FROM customers WHERE phone = $1 LIMIT 1', [phone]);
  const customerId = customer.rows && customer.rows[0] ? customer.rows[0].id : null;
  const [messages, logs, queue, prefs, conversations, settings] = await Promise.all([
    customerId
      ? safeQuery(
          `SELECT id, direction, message_type, content, external_message_id, status, created_at
             FROM messages WHERE customer_id = $1 ORDER BY id DESC LIMIT 30`,
          [customerId]
        )
      : { rows: [] },
    safeQuery(
      `SELECT id, event_type, level, message, metadata, created_at
         FROM automation_logs ORDER BY id DESC LIMIT 50`
    ),
    safeQuery(
      `SELECT id, customer_id, phone, message, status, attempts, error_message, created_at, updated_at
         FROM message_queue ORDER BY id DESC LIMIT 15`
    ),
    customerId
      ? safeQuery('SELECT * FROM communication_preferences WHERE customer_id = $1', [customerId])
      : { rows: [] },
    customerId
      ? safeQuery(
          `SELECT id, status, last_message_at, created_at FROM conversations
            WHERE customer_id = $1 ORDER BY id DESC LIMIT 5`,
          [customerId]
        )
      : { rows: [] },
    safeQuery('SELECT "key", "value" FROM system_settings ORDER BY "key"'),
  ]);

  res.json({
    ok: true,
    now: new Date().toISOString(),
    phone,
    customer,
    prefs,
    conversations,
    messages,
    logs,
    queue,
    settings,
    ai: {
      enabled: aiService.isEnabled(),
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      hasGeminiKey: Boolean(env.GEMINI_API_KEY),
      lastError: aiService.getLastError(),
    },
    webhookUrl: env.WEBHOOK_URL || null,
    hasWebhookSecret: Boolean(env.WEBHOOK_SECRET),
  });
});

router.post('/repair', tempAuth, async (req, res, next) => {
  try {
    const targetUrl =
      (req.body && req.body.url) ||
      env.WEBHOOK_URL ||
      'https://whatsapp-automation-peach.vercel.app/api/webhooks/whatsapp';
    const result = await evolutionService.setWebhook({ url: targetUrl });
    res.json({ ok: true, targetUrl, result });
  } catch (err) {
    next(err);
  }
});

router.post('/ai-test', tempAuth, async (req, res) => {
  const key = env.GEMINI_API_KEY;
  const keyKind = key.startsWith('AQ.')
    ? 'vertex'
    : key.startsWith('AIza')
      ? 'studio'
      : 'unknown';
  const models = [
    'gemini-3.8-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ];
  const tests = models.map(async (model) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const { data } = await axios.post(
        url,
        {
          contents: [{ role: 'user', parts: [{ text: 'Responde solo: hola' }] }],
          generationConfig: { maxOutputTokens: 10 },
        },
        { headers: { 'x-goog-api-key': key }, timeout: 10000 }
      );
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();
      return {
        model,
        endpoint: 'studio',
        ok: Boolean(text),
        text,
        finishReason: data?.candidates?.[0]?.finishReason || null,
      };
    } catch (err) {
      return {
        model,
        endpoint: 'studio',
        ok: false,
        status: err.response?.status || null,
        error: String(err.response?.data?.error?.message || err.message || 'error').slice(0, 300),
      };
    }
  });
  const results = await Promise.all(tests);
  res.json({
    ok: true,
    provider: env.AI_PROVIDER,
    configuredModel: env.AI_MODEL,
    keyKind,
    aiLastError: aiService.getLastError(),
    results,
  });
});

router.post('/reply-now', tempAuth, async (req, res, next) => {
  try {
    const phone = String((req.body && req.body.phone) || '51918897402');
    const customer = await pool.query('SELECT * FROM customers WHERE phone = $1 LIMIT 1', [phone]);
    if (!customer.rows[0]) return res.status(404).json({ error: 'cliente no encontrado' });
    const c = customer.rows[0];

    const pending = await pool.query(
      `SELECT id FROM message_queue
        WHERE customer_id = $1 AND status IN ('PENDING', 'PROCESSING')
        ORDER BY id DESC LIMIT 1`,
      [c.id]
    );
    let queued = null;
    if (!pending.rows[0]) {
      const message =
        (req.body && req.body.message) ||
        `Hola ${c.name || ''}, gracias por escribirnos. Cuentanos un poco mas: buscas informacion sobre un producto o un servicio?`;
      queued = await queueModel.enqueue({ customerId: c.id, phone: c.phone, message });
    }

    const worker = await messageWorker.tick({ budgetMs: 45000 });
    res.json({
      ok: true,
      customerId: c.id,
      queuedId: queued ? queued.id : null,
      reusedPendingId: pending.rows[0] ? pending.rows[0].id : null,
      worker,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
