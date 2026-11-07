// Estado conversacional transitorio del bot, por cliente (tabla `bot_states`).
// Se usa para los flujos solicitados en PLANTILLAS-CRM-BOT.md:
//  - pedir nombre y apellidos (y recordar que el cliente prefirio no darlos),
//  - reservas/citas: guardar la fecha/hora parcial mientras se completan.
//
// La tabla se crea de forma perezosa con CREATE TABLE IF NOT EXISTS, igual
// que la columna ai_profile de customers: no requiere migracion manual y no
// rompe el despliegue si aun no existe.

const { pool } = require('../config/database');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_states (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      awaiting TEXT,
      context JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  tableReady = true;
}

// Devuelve { awaiting, context } o null si el cliente no esta en ningun flujo.
async function get(customerId) {
  await ensureTable();
  const { rows } = await pool.query(
    'SELECT awaiting, context FROM bot_states WHERE customer_id = $1',
    [customerId]
  );
  return rows[0] ? { awaiting: rows[0].awaiting, context: rows[0].context || {} } : null;
}

async function set(customerId, awaiting, context = {}) {
  await ensureTable();
  await pool.query(
    `INSERT INTO bot_states (customer_id, awaiting, context, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (customer_id)
     DO UPDATE SET awaiting = $2, context = $3::jsonb, updated_at = NOW()`,
    [customerId, awaiting, JSON.stringify(context)]
  );
}

async function clear(customerId) {
  await ensureTable();
  await pool.query('DELETE FROM bot_states WHERE customer_id = $1', [customerId]);
}

// El cliente pidio no compartir su nombre: el bot deja de preguntarlo y
// lo atiende igual. Se guarda aqui (y no en memoria volatil) para que
// sobreviva reinicios y despliegues.
async function markNameDeclined(customerId) {
  await set(customerId, 'NONE', { nameDeclined: true });
}

async function isNameDeclined(customerId) {
  const state = await get(customerId);
  return Boolean(state && state.context && state.context.nameDeclined);
}

async function ensureNameNotDeclined(customerId) {
  // Cuando el nombre queda capturado por otras vias (pushName de WhatsApp,
  // panel), se limpia la marca de rechazo para no dejarla registrada de mas.
  const state = await get(customerId);
  if (state && state.context && state.context.nameDeclined && state.awaiting === 'NONE') {
    await clear(customerId);
  }
}

module.exports = {
  get,
  set,
  clear,
  markNameDeclined,
  isNameDeclined,
  ensureNameNotDeclined,
};
