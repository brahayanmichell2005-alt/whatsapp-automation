// Modelo de acceso a datos para la tabla `scheduled_messages`.
// El scheduler que las revisa esta en services/scheduler.service.js.

const { pool } = require('../config/database');

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM scheduled_messages WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function create({ customerId, phone, message, scheduledAt }) {
  const { rows } = await pool.query(
    `INSERT INTO scheduled_messages (customer_id, phone, message, scheduled_at, status)
     VALUES ($1, $2, $3, $4, 'SCHEDULED')
     RETURNING *`,
    [customerId, phone, message, scheduledAt]
  );
  return rows[0];
}

// Mensajes cuya hora ya llego y siguen en estado SCHEDULED (los recoge el scheduler).
async function findDue(limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_messages
     WHERE status = 'SCHEDULED' AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC, id ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function markQueued(id) {
  await pool.query("UPDATE scheduled_messages SET status = 'QUEUED' WHERE id = $1", [id]);
}

async function markSent(id) {
  await pool.query("UPDATE scheduled_messages SET status = 'SENT', sent_at = NOW() WHERE id = $1", [id]);
}

async function markFailed(id, errorMessage) {
  await pool.query(
    "UPDATE scheduled_messages SET status = 'FAILED', error_message = $1 WHERE id = $2",
    [errorMessage, id]
  );
}

async function cancel(id) {
  const { rows } = await pool.query(
    "UPDATE scheduled_messages SET status = 'CANCELLED' WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

async function update(id, { message, scheduledAt }) {
  const { rows } = await pool.query(
    `UPDATE scheduled_messages
     SET message = COALESCE($1::text, message),
         scheduled_at = COALESCE($2::timestamptz, scheduled_at)
     WHERE id = $3
     RETURNING *`,
    [message ?? null, scheduledAt ?? null, id]
  );
  return rows[0] || null;
}

async function list({ status = null, limit = 50, offset = 0 } = {}) {
  if (status) {
    const { rows } = await pool.query(
      'SELECT * FROM scheduled_messages WHERE status = $1 ORDER BY scheduled_at ASC, id ASC LIMIT $2 OFFSET $3',
      [status, limit, offset]
    );
    return rows;
  }
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_messages ORDER BY scheduled_at ASC, id ASC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return rows;
}

module.exports = {
  findById,
  create,
  findDue,
  markQueued,
  markSent,
  markFailed,
  cancel,
  update,
  list,
};
