// Modelo de acceso a datos para la tabla `message_queue`.
// El worker de envio y la logica de limites/intervalos viven en
// workers/message.worker.js; aqui solo van las operaciones de datos.

const { pool } = require('../config/database');

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM message_queue WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function enqueue({ customerId, phone, message, scheduledAt = null }) {
  const { rows } = await pool.query(
    `INSERT INTO message_queue (customer_id, phone, message, status, scheduled_at)
     VALUES ($1, $2, $3, 'PENDING', $4)
     RETURNING *`,
    [customerId, phone, message, scheduledAt]
  );
  return rows[0];
}

// Trae el siguiente lote de mensajes listos para enviar (usado por el worker).
async function findNextBatch(limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM message_queue
     WHERE status = 'PENDING'
       AND (scheduled_at IS NULL OR scheduled_at <= NOW())
     ORDER BY created_at ASC, id ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function markProcessing(id) {
  await pool.query("UPDATE message_queue SET status = 'PROCESSING' WHERE id = $1", [id]);
}

async function markSent(id) {
  await pool.query("UPDATE message_queue SET status = 'SENT', sent_at = NOW() WHERE id = $1", [id]);
}

async function markFailed(id, errorMessage) {
  await pool.query(
    `UPDATE message_queue
     SET status = 'FAILED', attempts = attempts + 1, error_message = $1
     WHERE id = $2`,
    [errorMessage, id]
  );
}

async function incrementAttempt(id, errorMessage) {
  await pool.query(
    `UPDATE message_queue
     SET attempts = attempts + 1, error_message = $1, status = 'PENDING'
     WHERE id = $2`,
    [errorMessage, id]
  );
}

async function cancelPendingByCustomer(customerId) {
  await pool.query(
    "UPDATE message_queue SET status = 'CANCELLED' WHERE customer_id = $1 AND status = 'PENDING'",
    [customerId]
  );
}

// En serverless una ejecucion puede cortarse (timeout, redeploy) justo despues
// de marcar un mensaje como PROCESSING. Los que llevan demasiado tiempo asi
// vuelven a PENDING para no quedar atascados para siempre.
async function requeueStale(olderThanMinutes = 5) {
  const result = await pool.query(
    `UPDATE message_queue SET status = 'PENDING'
     WHERE status = 'PROCESSING' AND updated_at < NOW() - make_interval(mins => $1::int)`,
    [olderThanMinutes]
  );
  return result.rowCount;
}

// Operaciones masivas del panel (pausar / reanudar / detener la cola).
// Devuelven cuantos mensajes se afectaron.
async function pauseAllPending() {
  const result = await pool.query("UPDATE message_queue SET status = 'PAUSED' WHERE status = 'PENDING'");
  return result.rowCount;
}

async function resumeAllPaused() {
  const result = await pool.query("UPDATE message_queue SET status = 'PENDING' WHERE status = 'PAUSED'");
  return result.rowCount;
}

async function cancelAllOpen() {
  const result = await pool.query(
    "UPDATE message_queue SET status = 'CANCELLED' WHERE status IN ('PENDING', 'PAUSED')"
  );
  return result.rowCount;
}

async function list({ status = null, limit = 50, offset = 0 } = {}) {
  if (status) {
    const { rows } = await pool.query(
      'SELECT * FROM message_queue WHERE status = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3',
      [status, limit, offset]
    );
    return rows;
  }
  const { rows } = await pool.query(
    'SELECT * FROM message_queue ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return rows;
}

module.exports = {
  findById,
  enqueue,
  findNextBatch,
  markProcessing,
  markSent,
  markFailed,
  incrementAttempt,
  cancelPendingByCustomer,
  requeueStale,
  pauseAllPending,
  resumeAllPaused,
  cancelAllOpen,
  list,
};
