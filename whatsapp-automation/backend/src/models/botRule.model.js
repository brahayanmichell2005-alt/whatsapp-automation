// Modelo de reglas de chatbot: palabras clave -> respuesta automatica.
// El intake las evalua ANTES de la IA; si una regla coincide, responde ella.
const { pool } = require('../config/database');

function normalize(row) {
  return {
    id: row.id,
    triggerType: row.trigger_type,
    keyword: row.keyword,
    reply: row.reply,
    active: row.active,
    priority: Number(row.priority || 100),
    timesTriggered: Number(row.times_triggered || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function list() {
  const { rows } = await pool.query(
    'SELECT * FROM bot_rules ORDER BY priority ASC, id ASC LIMIT 200'
  );
  return rows.map(normalize);
}

async function listActive() {
  const { rows } = await pool.query(
    'SELECT * FROM bot_rules WHERE active = TRUE ORDER BY priority ASC, id ASC LIMIT 100'
  );
  return rows.map(normalize);
}

async function getById(id) {
  const { rows } = await pool.query('SELECT * FROM bot_rules WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? normalize(rows[0]) : null;
}

// Busca la primera regla activa que coincide con el texto (por prioridad).
// CONTAINS: el texto contiene la palabra clave. EXACT: coincide exacta.
async function match(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const rules = await listActive();
  const lower = clean.toLowerCase();
  for (const rule of rules) {
    const kw = String(rule.keyword || '').trim().toLowerCase();
    if (!kw) continue;
    if (rule.triggerType === 'EXACT' ? lower === kw : lower.includes(kw)) {
      return rule;
    }
  }
  return null;
}

async function create({ triggerType, keyword, reply, active, priority }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_rules (trigger_type, keyword, reply, active, priority)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      triggerType === 'EXACT' ? 'EXACT' : 'CONTAINS',
      String(keyword || '').trim(),
      String(reply || '').trim(),
      active !== false,
      Number.isInteger(priority) ? priority : 100,
    ]
  );
  return normalize(rows[0]);
}

async function update(id, data) {
  const { rows } = await pool.query(
    `UPDATE bot_rules SET
       trigger_type = $2, keyword = $3, reply = $4,
       active = $5, priority = $6, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      data.triggerType === 'EXACT' ? 'EXACT' : 'CONTAINS',
      String(data.keyword || '').trim(),
      String(data.reply || '').trim(),
      data.active !== false,
      Number.isInteger(data.priority) ? data.priority : 100,
    ]
  );
  return rows[0] ? normalize(rows[0]) : null;
}

async function setActive(id, active) {
  const { rows } = await pool.query(
    'UPDATE bot_rules SET active = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id, !!active]
  );
  return rows[0] ? normalize(rows[0]) : null;
}

async function incrementTrigger(id) {
  await pool.query(
    'UPDATE bot_rules SET times_triggered = times_triggered + 1 WHERE id = $1',
    [id]
  );
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM bot_rules WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { list, listActive, getById, match, create, update, setActive, incrementTrigger, remove, normalize };
