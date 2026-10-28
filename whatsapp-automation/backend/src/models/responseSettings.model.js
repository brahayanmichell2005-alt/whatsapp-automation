// Configuracion global y bitacora de la cola de respuestas.
// La fila unica (id = 1) evita depender de system_settings para valores
// tipados: enabled, tiempos, ventana de agrupacion y concurrencia global.

const { pool } = require('../config/database');

const DEFAULTS = {
  enabled: true,
  min_delay_seconds: 5,
  max_delay_seconds: 15,
  grouping_window_seconds: 4,
  max_concurrent_responses: 2,
  status: 'ACTIVE',
  alert_threshold: 5,
};

const ALLOWED = [
  'enabled',
  'min_delay_seconds',
  'max_delay_seconds',
  'grouping_window_seconds',
  'max_concurrent_responses',
  'status',
  'alert_threshold',
];

async function ensureGlobal() {
  const { rows } = await pool.query('SELECT * FROM response_settings WHERE id = 1 LIMIT 1');
  if (rows[0]) return rows[0];

  const inserted = await pool.query(
    `INSERT INTO response_settings
      (id, enabled, min_delay_seconds, max_delay_seconds, grouping_window_seconds,
       max_concurrent_responses, status, alert_threshold)
     VALUES (1, $1, $2, $3, $4, $5, 'ACTIVE', $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      DEFAULTS.enabled,
      DEFAULTS.min_delay_seconds,
      DEFAULTS.max_delay_seconds,
      DEFAULTS.grouping_window_seconds,
      DEFAULTS.max_concurrent_responses,
      DEFAULTS.alert_threshold,
    ]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const { rows: reread } = await pool.query('SELECT * FROM response_settings WHERE id = 1 LIMIT 1');
  return reread[0] || { id: 1, ...DEFAULTS };
}

async function updateGlobal(fields, { actorId = null } = {}) {
  const keys = Object.keys(fields || {}).filter((key) => ALLOWED.includes(key));
  if (keys.length === 0) return ensureGlobal();

  const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
  const params = keys.map((key) => fields[key]);
  params.push(actorId);
  const { rows } = await pool.query(
    `UPDATE response_settings
     SET ${setClause}, updated_by = $${params.length}
     WHERE id = 1
     RETURNING *`,
    params
  );
  return rows[0] || ensureGlobal();
}

async function recordHistory({
  scope,
  action,
  actorId = null,
  customerId = null,
  conversationId = null,
  previous = null,
  next = null,
  reason = null,
}) {
  await pool.query(
    `INSERT INTO response_settings_history
      (scope, action, actor_id, customer_id, conversation_id, previous_value, next_value, reason)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      scope,
      action,
      actorId,
      customerId,
      conversationId,
      previous ? JSON.stringify(previous) : null,
      next ? JSON.stringify(next) : null,
      reason,
    ]
  );
}

async function listHistory({ limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT h.*, u.name AS actor_name, u.email AS actor_email
     FROM response_settings_history h
     LEFT JOIN users u ON u.id = h.actor_id
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = {
  DEFAULTS,
  ensureGlobal,
  updateGlobal,
  recordHistory,
  listHistory,
};
