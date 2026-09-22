// Modelo de acceso a datos para la tabla `communication_preferences`.
// Comandos "QUIERO RECIBIR MENSAJES" / "DEJAR DE RECIBIR MENSAJES".

const { pool } = require('../config/database');

async function findByCustomer(customerId) {
  const { rows } = await pool.query(
    'SELECT * FROM communication_preferences WHERE customer_id = $1 LIMIT 1',
    [customerId]
  );
  return rows[0] || null;
}

// Crea el registro con valores por defecto (opted_in = true) si el cliente
// todavia no tiene preferencias guardadas. Seguro ante llamadas simultaneas.
async function ensureForCustomer(customerId) {
  const existing = await findByCustomer(customerId);
  if (existing) return existing;
  await pool.query(
    `INSERT INTO communication_preferences (customer_id, opted_in, opted_out)
     VALUES ($1, TRUE, FALSE)
     ON CONFLICT (customer_id) DO NOTHING`,
    [customerId]
  );
  return findByCustomer(customerId);
}

async function optIn(customerId) {
  await ensureForCustomer(customerId);
  await pool.query(
    'UPDATE communication_preferences SET opted_in = TRUE, opted_out = FALSE WHERE customer_id = $1',
    [customerId]
  );
  return findByCustomer(customerId);
}

async function optOut(customerId) {
  await ensureForCustomer(customerId);
  await pool.query(
    'UPDATE communication_preferences SET opted_in = FALSE, opted_out = TRUE WHERE customer_id = $1',
    [customerId]
  );
  return findByCustomer(customerId);
}

module.exports = { findByCustomer, ensureForCustomer, optIn, optOut };
