// Cola persistente de trabajos de respuesta automatica.
//
// Un trabajo representa UNA respuesta logica. El indice unico parcial
// uq_response_jobs_open_conversation garantiza que no haya dos trabajos
// abiertos para la misma conversacion aunque lleguen webhooks en paralelo.
// Al llegar otro mensaje del mismo cliente se actualiza el trabajo existente
// (se reinicia la ventana de agrupacion y se invalida la generacion anterior).

const { pool } = require('../config/database');

const OPEN_STATUSES = ['PENDING', 'PROCESSING', 'PAUSED', 'QUEUED'];

async function schedule({
  customerId,
  conversationId,
  latestInboundMessageId,
  idempotencyKey,
  priority = 0,
  dueAt,
  maxAttempts = 3,
}) {
  const { rows } = await pool.query(
    `INSERT INTO response_jobs
      (customer_id, conversation_id, latest_inbound_message_id, idempotency_key,
       priority, due_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (conversation_id) WHERE status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED')
     DO UPDATE SET
       latest_inbound_message_id = EXCLUDED.latest_inbound_message_id,
       idempotency_key = EXCLUDED.idempotency_key,
       priority = EXCLUDED.priority,
       due_at = EXCLUDED.due_at,
       status = 'PENDING',
       generation = response_jobs.generation + 1,
       attempts = 0,
       error_message = NULL,
       reply_text = NULL,
       queue_id = NULL,
       started_at = NULL,
       locked_until = NULL,
       completed_at = NULL
     RETURNING *`,
    [
      customerId,
      conversationId,
      latestInboundMessageId,
      idempotencyKey,
      priority,
      dueAt,
      maxAttempts,
    ]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM response_jobs WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function findOpenByConversation(conversationId) {
  const { rows } = await pool.query(
    `SELECT * FROM response_jobs
     WHERE conversation_id = $1
       AND status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED')
     ORDER BY id DESC LIMIT 1`,
    [conversationId]
  );
  return rows[0] || null;
}

async function findDue(limit = 5) {
  const { rows } = await pool.query(
    `SELECT rj.*, c.name AS customer_name, c.phone AS customer_phone
     FROM response_jobs rj
     JOIN customers c ON c.id = rj.customer_id
     WHERE rj.status = 'PENDING'
       AND rj.due_at <= NOW()
       AND rj.attempts < rj.max_attempts
     ORDER BY rj.priority DESC, rj.due_at ASC, rj.id ASC
     LIMIT $1`,
    [Math.max(1, limit)]
  );
  return rows;
}

async function findEarliestDue() {
  const { rows } = await pool.query(
    `SELECT id, due_at FROM response_jobs
     WHERE status = 'PENDING' AND attempts < max_attempts
     ORDER BY due_at ASC, id ASC
     LIMIT 1`
  );
  return rows[0] || null;
}

// Reclamo atomico. Solo una ejecucion puede pasar PENDING -> PROCESSING.
async function claim(id, lockSeconds = 120) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'PROCESSING',
         attempts = attempts + 1,
         started_at = NOW(),
         locked_until = NOW() + make_interval(secs => $2::int),
         error_message = NULL
     WHERE id = $1
       AND status = 'PENDING'
       AND due_at <= NOW()
       AND attempts < max_attempts
     RETURNING *`,
    [id, Math.max(10, lockSeconds)]
  );
  return rows[0] || null;
}

// Comprueba que el trabajo sigue siendo la generacion vigente antes de
// encolar o enviar. Un mensaje nuevo incrementa generation y lo invalida.
async function stillCurrent(id, generation) {
  const { rows } = await pool.query(
    `SELECT id FROM response_jobs
     WHERE id = $1 AND generation = $2 AND status = 'PROCESSING'
     LIMIT 1`,
    [id, generation]
  );
  return Boolean(rows[0]);
}

async function markQueued(id, generation, queueId, replyText) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'QUEUED', queue_id = $3, reply_text = $4, locked_until = NULL
     WHERE id = $1 AND generation = $2 AND status = 'PROCESSING'
     RETURNING *`,
    [id, generation, queueId, replyText]
  );
  return rows[0] || null;
}

// Devuelve un trabajo reclamado a PENDING sin gastar un intento (por ejemplo
// si el sistema se pauso justo despues de reclamarlo).
async function releaseClaim(id, generation, reason = null) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'PENDING', due_at = NOW(), locked_until = NULL, error_message = $3
     WHERE id = $1 AND generation = $2 AND status = 'PROCESSING'
     RETURNING *`,
    [id, generation, reason]
  );
  return rows[0] || null;
}

// Cierra el trabajo cuando el envio ya termino. Ademas del vinculo directo
// (queue_id), se acepta el caso en que el worker envio el mensaje justo entre
// el INSERT en message_queue y el markQueued: el trabajo aun esta PROCESSING y
// su queue_id todavia es NULL, pero el mensaje ya tiene response_job_id y la
// misma generacion. Nunca se toca una generacion mas nueva.
const QUEUE_JOB_MATCH = `
  status IN ('PROCESSING', 'QUEUED')
  AND (
    queue_id = $1
    OR (
      id = (SELECT response_job_id FROM message_queue WHERE id = $1)
      AND generation = (SELECT response_generation FROM message_queue WHERE id = $1)
    )
  )`;

async function markSentFromQueue(queueId) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'SENT', completed_at = NOW(), locked_until = NULL, error_message = NULL
     WHERE ${QUEUE_JOB_MATCH}
     RETURNING id, customer_id, conversation_id`,
    [queueId]
  );
  return rows[0] || null;
}

async function markFailedFromQueue(queueId, errorMessage) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'FAILED', completed_at = NOW(), locked_until = NULL, error_message = $2
     WHERE ${QUEUE_JOB_MATCH}
     RETURNING id, customer_id, conversation_id`,
    [queueId, errorMessage]
  );
  return rows[0] || null;
}

// Entrega incierta: el conector no confirmo si el mensaje llego. No se
// reintenta automaticamente para no duplicar el envio.
async function markUncertainFromQueue(queueId, errorMessage) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'UNCERTAIN', completed_at = NOW(), locked_until = NULL, error_message = $2
     WHERE ${QUEUE_JOB_MATCH}
     RETURNING id, customer_id, conversation_id`,
    [queueId, errorMessage]
  );
  return rows[0] || null;
}

async function markCancelled(id, reason) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'CANCELLED', completed_at = NOW(), locked_until = NULL, error_message = $2
     WHERE id = $1 AND status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED')
     RETURNING *`,
    [id, reason]
  );
  return rows[0] || null;
}

// Cancela solo la generacion indicada. Es la unica forma segura de descartar
// un trabajo reclamado: si mientras tanto llego un mensaje nuevo, la fila ya
// tiene otra generacion y NO debe cancelarse (representa la respuesta nueva).
async function markCancelledGeneration(id, generation, reason) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = 'CANCELLED', completed_at = NOW(), locked_until = NULL, error_message = $3
     WHERE id = $1 AND generation = $2 AND status = 'PROCESSING'
     RETURNING *`,
    [id, generation, reason]
  );
  return rows[0] || null;
}

async function cancelOpenByConversation(conversationId, reason) {
  const { rowCount } = await pool.query(
    `UPDATE response_jobs
     SET status = 'CANCELLED', completed_at = NOW(), locked_until = NULL, error_message = $2
     WHERE conversation_id = $1
       AND status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED')`,
    [conversationId, reason]
  );
  return rowCount;
}

async function cancelOpenByCustomer(customerId, reason) {
  const { rowCount } = await pool.query(
    `UPDATE response_jobs
     SET status = 'CANCELLED', completed_at = NOW(), locked_until = NULL, error_message = $2
     WHERE customer_id = $1
       AND status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED')`,
    [customerId, reason]
  );
  return rowCount;
}

// Detencion de emergencia: invalida todos los trabajos abiertos de todas las
// conversaciones. Los envios ya encolados se cancelan por separado.
async function cancelAllOpen(reason) {
  const { rowCount } = await pool.query(
    `UPDATE response_jobs
     SET status = 'CANCELLED', completed_at = NOW(), locked_until = NULL, error_message = $1
     WHERE status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED')`,
    [reason]
  );
  return rowCount;
}

async function pauseOpen() {
  const { rowCount } = await pool.query(
    `UPDATE response_jobs SET status = 'PAUSED', locked_until = NULL
     WHERE status IN ('PENDING', 'PROCESSING')`
  );
  return rowCount;
}

async function cancelStalePaused(maxAgeSeconds) {
  const { rowCount } = await pool.query(
    `UPDATE response_jobs
     SET status = 'CANCELLED', completed_at = NOW(), locked_until = NULL,
         error_message = 'Cancelado al reanudar: la conversacion ya no era reciente'
     WHERE status = 'PAUSED'
       AND updated_at < NOW() - make_interval(secs => $1::int)`,
    [Math.max(0, maxAgeSeconds)]
  );
  return rowCount;
}

async function resumePaused(delaySeconds = 1) {
  const { rowCount } = await pool.query(
    `UPDATE response_jobs
     SET status = 'PENDING',
         due_at = NOW() + make_interval(secs => $1::int),
         locked_until = NULL
     WHERE status = 'PAUSED'`,
    [Math.max(0, delaySeconds)]
  );
  return rowCount;
}

// Recupera trabajos que quedaron PROCESSING por un reinicio/timeout.
async function requeueStale(olderThanMinutes = 5) {
  const { rowCount } = await pool.query(
    `UPDATE response_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
         due_at = CASE WHEN attempts >= max_attempts THEN due_at ELSE NOW() END,
         locked_until = NULL,
         error_message = CASE
           WHEN attempts >= max_attempts THEN 'Se agotaron los intentos tras un reinicio'
           ELSE 'Reintentado tras reinicio o timeout'
         END,
         completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE completed_at END
     WHERE status = 'PROCESSING'
       AND locked_until IS NOT NULL
       AND locked_until < NOW() - make_interval(mins => $1::int)`,
    [Math.max(1, olderThanMinutes)]
  );
  return rowCount;
}

// Error de generacion. attempts ya se incremento al reclamar.
async function incrementFailure(id, errorMessage, maxAttempts = 3, retryDelaySeconds = 10) {
  const { rows } = await pool.query(
    `UPDATE response_jobs
     SET status = CASE WHEN attempts >= $2 THEN 'FAILED' ELSE 'PENDING' END,
         due_at = CASE WHEN attempts >= $2 THEN due_at ELSE NOW() + make_interval(secs => $3::int) END,
         locked_until = NULL,
         error_message = $4,
         completed_at = CASE WHEN attempts >= $2 THEN NOW() ELSE completed_at END
     WHERE id = $1 AND status = 'PROCESSING'
     RETURNING *`,
    [id, Math.max(1, maxAttempts), Math.max(1, retryDelaySeconds), errorMessage]
  );
  return rows[0] || null;
}

// Reintento manual solo para fallos confirmados. UNCERTAIN no se reintenta
// porque no se sabe si el mensaje ya llego al destinatario.
async function retryFailed(id) {
  const { rows } = await pool.query(
    `UPDATE response_jobs rj
     SET status = 'PENDING', attempts = 0, due_at = NOW(), locked_until = NULL,
         error_message = NULL, completed_at = NULL, generation = rj.generation + 1
     WHERE rj.id = $1
       AND rj.status = 'FAILED'
       AND NOT EXISTS (
         SELECT 1 FROM response_jobs open
         WHERE open.conversation_id = rj.conversation_id
           AND open.status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED')
       )
     RETURNING rj.*`,
    [id]
  );
  return rows[0] || null;
}

async function list({ status = null, limit = 50, offset = 0 } = {}) {
  if (status) {
    const { rows } = await pool.query(
      `SELECT rj.*, c.name AS customer_name, c.phone AS customer_phone,
              cv.status AS conversation_status, cv.bot_enabled
       FROM response_jobs rj
       JOIN customers c ON c.id = rj.customer_id
       LEFT JOIN conversations cv ON cv.id = rj.conversation_id
       WHERE rj.status = $1
       ORDER BY rj.created_at DESC, rj.id DESC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
    return rows;
  }

  const { rows } = await pool.query(
    `SELECT rj.*, c.name AS customer_name, c.phone AS customer_phone,
            cv.status AS conversation_status, cv.bot_enabled
     FROM response_jobs rj
     JOIN customers c ON c.id = rj.customer_id
     LEFT JOIN conversations cv ON cv.id = rj.conversation_id
     ORDER BY rj.created_at DESC, rj.id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function stats() {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
       COUNT(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
       COUNT(*) FILTER (WHERE status = 'PAUSED')::int AS paused,
       COUNT(*) FILTER (WHERE status = 'SENT' AND completed_at >= CURRENT_DATE)::int AS sent_today,
       COUNT(*) FILTER (WHERE status = 'FAILED' AND completed_at >= CURRENT_DATE)::int AS failed_today,
       COUNT(*) FILTER (WHERE status = 'UNCERTAIN' AND completed_at >= CURRENT_DATE)::int AS uncertain_today,
       COUNT(*) FILTER (WHERE status = 'CANCELLED' AND completed_at >= CURRENT_DATE)::int AS cancelled_today,
       COUNT(*)::int AS total
     FROM response_jobs`
  );
  return rows[0] || {
    pending: 0,
    processing: 0,
    queued: 0,
    paused: 0,
    sent_today: 0,
    failed_today: 0,
    uncertain_today: 0,
    cancelled_today: 0,
    total: 0,
  };
}

module.exports = {
  OPEN_STATUSES,
  schedule,
  findById,
  findOpenByConversation,
  findDue,
  findEarliestDue,
  claim,
  stillCurrent,
  markQueued,
  releaseClaim,
  markSentFromQueue,
  markFailedFromQueue,
  markUncertainFromQueue,
  markCancelled,
  markCancelledGeneration,
  cancelOpenByConversation,
  cancelOpenByCustomer,
  cancelAllOpen,
  pauseOpen,
  cancelStalePaused,
  resumePaused,
  requeueStale,
  incrementFailure,
  retryFailed,
  list,
  stats,
};
