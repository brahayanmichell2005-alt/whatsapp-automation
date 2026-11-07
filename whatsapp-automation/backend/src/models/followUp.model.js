// Modelo de seguimientos (follow_ups): recordatorios del dueño para retomar
// un chat ("llamarle manana 10am", "cliente tibio hace 3 dias"). El panel los
// muestra; avisar al dueño. Nada se envia automatico al cliente.

const { pool } = require('../config/database');

async function create({ customerId, conversationId = null, remindAt, note = null }) {
  const { rows } = await pool.query(
    `INSERT INTO follow_ups (customer_id, conversation_id, remind_at, note)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [customerId, conversationId, remindAt, note ? String(note).slice(0, 500) : null]
  );
  return rows[0];
}

// Pendientes, los mas urgentes primero. Con datos del cliente para pintarlos.
async function listPending({ onlyDue = false, customerId = null, limit = 100 } = {}) {
  const conds = ['f.done = FALSE'];
  const params = [];
  if (onlyDue) {
    params.push(remindAtWindow());
    conds.push(`f.remind_at <= $${params.length}`);
  }
  if (customerId) {
    params.push(customerId);
    conds.push(`f.customer_id = $${params.length}`);
  }
  params.push(Math.min(limit, 200));
  const { rows } = await pool.query(
    `SELECT f.*, c.name AS customer_name, c.phone AS customer_phone
     FROM follow_ups f
     LEFT JOIN customers c ON c.id = f.customer_id
     WHERE ${conds.join(' AND ')}
     ORDER BY f.remind_at ASC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// Acepta un remind_at levemente futuro (relojes desincronizados): se marca
// vencido si ya llego (+60s de gracia).
function remindAtWindow() {
  return new Date(Date.now() - 60 * 1000).toISOString();
}

async function markDone(id) {
  const { rows } = await pool.query(
    'UPDATE follow_ups SET done = TRUE, done_at = NOW() WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM follow_ups WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { create, listPending, markDone, remove };
