// Configuracion individual de tiempos de respuesta por cliente.
// Si no existe fila, el servicio usa los valores globales. No se crean filas
// vacias para todos los clientes: solo cuando el usuario guarda una config.

const { pool } = require('../config/database');

const ALLOWED = [
  'enabled',
  'min_delay_seconds',
  'max_delay_seconds',
  'random_variation',
  'priority',
  'paused',
];

async function findByCustomer(customerId) {
  const { rows } = await pool.query(
    'SELECT * FROM customer_response_settings WHERE customer_id = $1 LIMIT 1',
    [customerId]
  );
  return rows[0] || null;
}

async function upsert(customerId, fields, { actorId = null } = {}) {
  const keys = Object.keys(fields || {}).filter((key) => ALLOWED.includes(key));
  if (keys.length === 0) return findByCustomer(customerId);

  const columns = ['customer_id', ...keys, 'updated_by'];
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const params = [customerId, ...keys.map((key) => fields[key]), actorId];
  const updates = keys.map((key) => `${key} = EXCLUDED.${key}`).join(', ');

  const { rows } = await pool.query(
    `INSERT INTO customer_response_settings (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (customer_id) DO UPDATE
       SET ${updates}, updated_by = EXCLUDED.updated_by
     RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function remove(customerId) {
  const { rowCount } = await pool.query(
    'DELETE FROM customer_response_settings WHERE customer_id = $1',
    [customerId]
  );
  return rowCount > 0;
}

async function touchLastReply(customerId) {
  await pool.query(
    `UPDATE customer_response_settings
     SET last_auto_reply_at = NOW()
     WHERE customer_id = $1`,
    [customerId]
  );
}

async function list() {
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone
     FROM customer_response_settings s
     JOIN customers c ON c.id = s.customer_id
     ORDER BY s.updated_at DESC, s.customer_id DESC`
  );
  return rows;
}

module.exports = {
  findByCustomer,
  upsert,
  remove,
  touchLastReply,
  list,
};
