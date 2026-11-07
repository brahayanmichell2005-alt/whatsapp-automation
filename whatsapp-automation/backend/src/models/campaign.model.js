// Modelo de campanas masivas. Una campana resuelve su audiencia entre los
// clientes reales y encola un mensaje por cliente en message_queue (con
// campaign_id). El progreso se calcula contando la cola, no se inventa nada.
const { pool } = require('../config/database');

function normalize(row) {
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    status: row.status,
    audience: row.audience || {},
    total: Number(row.total || 0),
    sent: Number(row.sent || 0),
    failed: Number(row.failed || 0),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

async function list(limit = 50) {
  const { rows } = await pool.query(
    'SELECT * FROM campaigns ORDER BY created_at DESC, id DESC LIMIT $1',
    [limit]
  );
  return rows.map(normalize);
}

async function getById(id) {
  const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? normalize(rows[0]) : null;
}

// Progreso real de una campana leyendo la cola de salida.
async function progress(id) {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM message_queue WHERE campaign_id = $1 GROUP BY status`,
    [id]
  );
  const byStatus = { PENDING: 0, PROCESSING: 0, SENT: 0, FAILED: 0, PAUSED: 0 };
  let total = 0;
  rows.forEach((r) => {
    byStatus[r.status] = r.n;
    total += r.n;
  });
  return { total, ...byStatus };
}

async function create({ name, message, audience, total }) {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (name, message, status, audience, total)
     VALUES ($1, $2, 'SENDING', $3, $4) RETURNING *`,
    [name, message, JSON.stringify(audience || {}), total || 0]
  );
  return normalize(rows[0]);
}

// Refresca contadores sent/failed desde la cola; marca COMPLETED si termino.
async function refreshProgress(id) {
  const p = await progress(id);
  const done = p.SENT + p.FAILED;
  const status = p.total > 0 && done >= p.total ? 'COMPLETED' : 'SENDING';
  const { rows } = await pool.query(
    `UPDATE campaigns
       SET sent = $2, failed = $3,
           status = CASE WHEN $4 = 'COMPLETED' AND completed_at IS NULL THEN 'COMPLETED' ELSE status END,
           completed_at = CASE WHEN $4 = 'COMPLETED' AND completed_at IS NULL THEN NOW() ELSE completed_at END
     WHERE id = $1
     RETURNING *`,
    [id, p.SENT, p.FAILED, status]
  );
  const campaign = rows[0] ? normalize(rows[0]) : null;
  return campaign ? { ...campaign, live: p } : null;
}

// Encola un mensaje de la campana para un cliente (usado por el controller).
async function enqueueForCampaign({ customerId, phone, message, campaignId }) {
  const { rows } = await pool.query(
    `INSERT INTO message_queue (customer_id, phone, message, status, campaign_id)
     VALUES ($1, $2, $3, 'PENDING', $4)
     RETURNING *`,
    [customerId, phone, message, campaignId]
  );
  return rows[0];
}

async function remove(id) {
  // Cancela pendientes de la campana para no enviar despues de borrarla.
  await pool.query(
    "DELETE FROM message_queue WHERE campaign_id = $1 AND status = 'PENDING'",
    [id]
  );
  const { rowCount } = await pool.query('DELETE FROM campaigns WHERE id = $1', [id]);
  return rowCount > 0;
}

async function countAll() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM campaigns');
  return rows[0].n;
}

module.exports = { list, getById, progress, create, refreshProgress, enqueueForCampaign, remove, countAll, normalize };
