// Modelo de acceso a datos para la tabla `automation_logs`.
// Usado por todo el sistema (webhook, worker, deteccion de anomalias, panel)
// para dejar rastro estructurado de eventos.

const { pool } = require('../config/database');

async function record({ eventType, level = 'INFO', message, metadata = null }) {
  await pool.query(
    'INSERT INTO automation_logs (event_type, level, message, metadata) VALUES ($1, $2, $3, $4::jsonb)',
    [eventType, level, message, metadata ? JSON.stringify(metadata) : null]
  );
}

async function list({ level = null, eventType = null, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  if (level) {
    params.push(level);
    conditions.push(`level = $${params.length}`);
  }
  if (eventType) {
    params.push(eventType);
    conditions.push(`event_type = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT * FROM automation_logs ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

// Cuenta errores recientes por tipo de evento, usado por la deteccion de
// comportamiento anormal para decidir si pausar la cola.
async function countRecentErrors(eventType, sinceMinutes = 10) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM automation_logs
     WHERE event_type = $1 AND level = 'ERROR'
       AND created_at >= NOW() - make_interval(mins => $2::int)`,
    [eventType, sinceMinutes]
  );
  return rows[0]?.total || 0;
}

module.exports = { record, list, countRecentErrors };
