// Modelo de acceso a datos para la tabla `reservations`: el registro real
// de las reservas/citas que captura el bot (flujo de botFlow.service.js).
// La tabla se crea de forma perezosa con CREATE TABLE IF NOT EXISTS, igual
// que otras tablas/columnas nuevas del proyecto: no requiere migracion
// manual y no rompe el despliegue si aun no existe.

const { pool } = require('../config/database');
const env = require('../config/env');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      phone TEXT,
      start_at TIMESTAMPTZ NOT NULL,
      date_text TEXT,
      time_text TEXT,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      cancelled_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS reservations_start_at_idx ON reservations (start_at)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS reservations_slot_unique_idx
      ON reservations (customer_id, start_at) WHERE status = 'CONFIRMED'
  `);
  tableReady = true;
}

// ---------------------------------------------------------------------
// Fecha y hora pedidas -> instante real (TIMESTAMPTZ) en la zona horaria
// del negocio. `date` = { year, month, day } (calendario local) y
// `time` = { hour, minute } de 24h tal como los guarda el flujo.
// ---------------------------------------------------------------------
function tzOffsetMilliseconds(date, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(date);
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    const asUtc = Date.UTC(
      get('year'), get('month') - 1, get('day'),
      get('hour'), get('minute'), get('second')
    );
    return asUtc - date.getTime();
  } catch (err) {
    // Zona invalida: se asume UTC para no salvar la reserva si falla.
    return 0;
  }
}

function toStartAtIso(date, time, timeZone = env.TIMEZONE || 'America/Lima') {
  if (!date || !time) return null;
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const offset = tzOffsetMilliseconds(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - offset).toISOString();
}

// ---------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------

// Confirma (o re-confirma) la reserva de un cliente en un horario.
function confirm({ customerId, phone, startAt, dateText, timeText }) {
  return create({ customerId, phone, startAt, dateText, timeText, status: 'CONFIRMED' });
}

async function create({ customerId, phone = null, startAt, dateText = null, timeText = null, status = 'CONFIRMED' }) {
  await ensureTable();
  const { rows } = await pool.query(
    `INSERT INTO reservations (customer_id, phone, start_at, date_text, time_text, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (customer_id, start_at) WHERE status = 'CONFIRMED'
     DO UPDATE SET phone = COALESCE($2, reservations.phone)
     RETURNING *`,
    [customerId, phone, startAt, dateText, timeText, status]
  );
  return rows[0] || null;
}

async function cancel(id) {
  await ensureTable();
  const { rows } = await pool.query(
    `UPDATE reservations SET status = 'CANCELLED', cancelled_at = NOW()
     WHERE id = $1 AND status = 'CONFIRMED'
     RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------

// Disponibilidad REAL del slot: ya hay otra reserva confirmada a esa hora?
// `excludePhone` evita contar la propia reserva del cliente (re-confirmar).
// El slot se considera ocupado si otra reserva empieza en el mismo minuto.
async function isTaken(startAt, excludePhone = null) {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT 1 FROM reservations
     WHERE status = 'CONFIRMED'
       AND start_at = $1
       AND ($2::text IS NULL OR phone IS DISTINCT FROM $2)
     LIMIT 1`,
    [startAt, excludePhone]
  );
  return rows.length > 0;
}

async function findById(id) {
  await ensureTable();
  const { rows } = await pool.query('SELECT * FROM reservations WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listByCustomer(customerId, { limit = 50, offset = 0 } = {}) {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT * FROM reservations WHERE customer_id = $1
     ORDER BY start_at DESC LIMIT $2 OFFSET $3`,
    [customerId, limit, offset]
  );
  return rows;
}

async function list({ limit = 50, offset = 0 } = {}) {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT * FROM reservations ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = {
  ensureTable,
  toStartAtIso,
  confirm,
  create,
  cancel,
  isTaken,
  findById,
  list,
  listByCustomer,
};
