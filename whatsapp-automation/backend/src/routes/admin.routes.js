// Endpoint temporal de operacion. Se elimina despues de aplicar la migracion
// y ejecutar la prueba interna. Protegido con el mismo CRON_SECRET.
const express = require('express');
const router = express.Router();
const { cronAuth } = require('../middleware/cronAuth');
const { pool } = require('../config/database');
const messageIntakeService = require('../services/messageIntake.service');
const queueModel = require('../models/messageQueue.model');
const aiService = require('../services/ai.service');

router.post('/migrate', cronAuth, async (req, res, next) => {
  try {
    await pool.query(
      `ALTER TABLE message_queue
         ADD COLUMN IF NOT EXISTS scheduled_message_id INTEGER
         REFERENCES scheduled_messages(id) ON DELETE SET NULL`
    );
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_queue_scheduled_msg ON message_queue (scheduled_message_id)'
    );
    const col = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_name = 'message_queue' AND column_name = 'scheduled_message_id'`
    );
    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'message_queue' AND indexname = 'idx_queue_scheduled_msg'`
    );
    res.json({ ok: true, column: col.rows[0] || null, index: idx.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

router.post('/selftest', cronAuth, async (req, res, next) => {
  const phone = `000${Date.now()}`;
  const externalMessageId = `selftest-${Date.now()}`;
  const originalIsEnabled = aiService.isEnabled;
  let customerId = null;
  let queueRow = null;

  async function cleanup() {
    if (!customerId) return;
    try {
      await queueModel.cancelPendingByCustomer(customerId);
      await pool.query(`DELETE FROM automation_logs WHERE metadata->>'customerId' = $1`, [
        String(customerId),
      ]);
      await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
    } catch (_) {
      // La limpieza es best-effort; no debe ocultar el resultado de la prueba.
    }
  }

  try {
    // Fuerza el camino de reglas para que la prueba sea rapida y determinista.
    aiService.isEnabled = () => false;

    const result = await messageIntakeService.handleInboundMessage({
      isGroup: false,
      fromMe: false,
      phone,
      pushName: 'Prueba interna',
      externalMessageId,
      messageType: 'TEXT',
      content: 'precio de laptop',
    });

    customerId = result.customer ? result.customer.id : null;
    if (customerId) {
      const q = await pool.query(
        `SELECT id, phone, message, status
           FROM message_queue
          WHERE customer_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [customerId]
      );
      queueRow = q.rows[0] || null;
    }

    await cleanup();
    res.json({
      ok: true,
      skipped: result.skipped || false,
      reason: result.reason || null,
      customerId,
      queue: queueRow,
    });
  } catch (err) {
    await cleanup();
    next(err);
  } finally {
    aiService.isEnabled = originalIsEnabled;
  }
});

module.exports = router;
