// Modelo de acceso a datos para la tabla `message_queue`.
// El worker de envio y la logica de limites/intervalos viven en
// workers/message.worker.js; aqui solo van las operaciones de datos.

const { pool } = require('../config/database');

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM message_queue WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function enqueue({
  customerId,
  phone,
  message,
  scheduledAt = null,
  scheduledMessageId = null,
  idempotencyKey = null,
  responseJobId = null,
  responseGeneration = null,
}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO message_queue
        (customer_id, phone, message, status, scheduled_at, scheduled_message_id,
         idempotency_key, response_job_id, response_generation)
       VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        customerId,
        phone,
        message,
        scheduledAt,
        scheduledMessageId,
        idempotencyKey,
        responseJobId,
        responseGeneration,
      ]
    );
    if (rows[0]) return rows[0];
    // Ya existia un envio con la misma clave logica: se devuelve el original.
    return findByIdempotencyKey(idempotencyKey);
  } catch (err) {
    // Compatibilidad durante el despliegue: si la migracion de
    // `scheduled_message_id` todavia no se aplico, se guarda el mensaje sin
    // ese vinculo en lugar de perderlo. Error 42703 = undefined_column.
    if (err.code === '42703' && /scheduled_message_id/i.test(err.message || '')) {
      const { rows } = await pool.query(
        `INSERT INTO message_queue (customer_id, phone, message, status, scheduled_at)
         VALUES ($1, $2, $3, 'PENDING', $4)
         RETURNING *`,
        [customerId, phone, message, scheduledAt]
      );
      return rows[0];
    }
    throw err;
  }
}

async function findByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  const { rows } = await pool.query(
    'SELECT * FROM message_queue WHERE idempotency_key = $1 LIMIT 1',
    [idempotencyKey]
  );
  return rows[0] || null;
}

// Antes de enviar una respuesta automatica se verifica que el trabajo siga
// vigente. Un mensaje nuevo o una intervencion humana lo invalida. Se acepta
// PROCESSING porque entre insertar el envio y marcar el trabajo como QUEUED
// hay una ventana muy corta; lo que nunca se acepta es otra generacion.
async function isQueueItemCurrent(queueId, responseJobId, responseGeneration) {
  if (!responseJobId) return true;
  const { rows } = await pool.query(
    `SELECT id FROM response_jobs
     WHERE id = $2 AND generation = $3
       AND status IN ('PROCESSING', 'QUEUED')
       AND (queue_id IS NULL OR queue_id = $1)
     LIMIT 1`,
    [queueId, responseJobId, responseGeneration]
  );
  return Boolean(rows[0]);
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

// El conector no pudo confirmar si el mensaje llego (timeout, 5xx, corte de
// red). Queda en estado incierto y NUNCA se reintenta automaticamente.
async function markUncertain(id, errorMessage) {
  await pool.query(
    `UPDATE message_queue
     SET status = 'UNCERTAIN', attempts = attempts + 1, error_message = $1,
         uncertain_at = NOW()
     WHERE id = $2`,
    [errorMessage, id]
  );
}

// Cancela un envio concreto (respuesta invalidada) sin contarlo como fallo
// del conector.
async function markCancelled(id, reason = null) {
  await pool.query(
    `UPDATE message_queue
     SET status = 'CANCELLED', error_message = COALESCE($1, error_message)
     WHERE id = $2 AND status IN ('PENDING', 'PROCESSING', 'PAUSED')`,
    [reason, id]
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

// Cancela las respuestas aun no enviadas de un cliente. Incluye PAUSED para
// que un mensaje nuevo no deje una respuesta vieja esperando en la cola.
async function cancelPendingByCustomer(customerId) {
  await pool.query(
    "UPDATE message_queue SET status = 'CANCELLED' WHERE customer_id = $1 AND status IN ('PENDING', 'PAUSED')",
    [customerId]
  );
}

// Cancela solo los envios de una conversacion (intervencion humana o
// invalidacion por un mensaje nuevo). No toca envios manuales de otros hilos.
async function cancelPendingByConversation(conversationId) {
  const { rowCount } = await pool.query(
    `UPDATE message_queue q
     SET status = 'CANCELLED'
     WHERE q.status IN ('PENDING', 'PAUSED')
       AND q.response_job_id IN (
         SELECT rj.id FROM response_jobs rj WHERE rj.conversation_id = $1
       )`,
    [conversationId]
  );
  return rowCount;
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
  findByIdempotencyKey,
  isQueueItemCurrent,
  enqueue,
  findNextBatch,
  markProcessing,
  markSent,
  markFailed,
  markUncertain,
  markCancelled,
  incrementAttempt,
  cancelPendingByCustomer,
  cancelPendingByConversation,
  requeueStale,
  pauseAllPending,
  resumeAllPaused,
  cancelAllOpen,
  list,
};
