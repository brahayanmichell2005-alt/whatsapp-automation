// Modelo de acceso a datos para la tabla `conversations`.

const { pool } = require('../config/database');

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

// Devuelve la conversacion abierta mas reciente de un cliente, si existe.
async function findOpenByCustomer(customerId) {
  const { rows } = await pool.query(
    `SELECT * FROM conversations
     WHERE customer_id = $1 AND status IN ('OPEN', 'PENDING', 'HUMAN')
     ORDER BY started_at DESC LIMIT 1`,
    [customerId]
  );
  return rows[0] || null;
}

async function create(customerId) {
  const { rows } = await pool.query(
    `INSERT INTO conversations (customer_id, status) VALUES ($1, 'OPEN') RETURNING *`,
    [customerId]
  );
  return rows[0];
}

// Usado por el webhook: reutiliza la conversacion abierta del cliente o crea
// una nueva si no tiene ninguna activa.
async function findOrCreateOpenByCustomer(customerId) {
  const existing = await findOpenByCustomer(customerId);
  if (existing) return existing;
  return create(customerId);
}

async function touchLastMessage(id) {
  await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [id]);
}

async function updateStatus(id, status, { assignedTo = undefined } = {}) {
  const sets = ['status = $1'];
  const params = [status];

  if (assignedTo !== undefined) {
    params.push(assignedTo);
    sets.push(`assigned_to = $${params.length}`);
  }
  if (status === 'CLOSED') {
    sets.push('closed_at = NOW()');
  }

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE conversations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] || null;
}

// NULLS LAST: en MySQL las conversaciones sin mensajes quedaban al final del
// orden descendente; en PostgreSQL quedarian primero si no se indica.
async function list({ status = null, limit = 50, offset = 0 } = {}) {
  if (status) {
    const { rows } = await pool.query(
      `SELECT * FROM conversations WHERE status = $1
       ORDER BY last_message_at DESC NULLS LAST, id DESC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM conversations
     ORDER BY last_message_at DESC NULLS LAST, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = {
  findById,
  findOpenByCustomer,
  create,
  findOrCreateOpenByCustomer,
  touchLastMessage,
  updateStatus,
  list,
};
