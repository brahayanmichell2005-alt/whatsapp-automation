// Revision temporal de solo lectura. Se elimina al terminar.
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const env = require('../config/env');
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

module.exports = router;
