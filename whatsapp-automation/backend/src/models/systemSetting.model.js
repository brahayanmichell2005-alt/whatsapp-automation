// Modelo de acceso a datos para la tabla `system_settings`.
// Guarda configuracion global mutable en runtime (ej. pause_queue,
// estado de automatizacion ACTIVE/PAUSED/STOPPED).

const { pool } = require('../config/database');

async function get(key) {
  const { rows } = await pool.query(
    'SELECT "value" FROM system_settings WHERE "key" = $1 LIMIT 1',
    [key]
  );
  return rows[0]?.value ?? null;
}

async function set(key, value) {
  await pool.query(
    `INSERT INTO system_settings ("key", "value") VALUES ($1, $2)
     ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
    [key, value]
  );
  return get(key);
}

async function getAll() {
  const { rows } = await pool.query('SELECT "key", "value" FROM system_settings');
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

module.exports = { get, set, getAll };
