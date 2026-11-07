// Modelo de plantillas de mensajes (message_templates). CRUD simple para el
// gestor de plantillas del panel. Los JSONB (buttons/variables/sample_values)
// se normalizan aqui para que el controller solo trabaje con objetos.
const { pool } = require('../config/database');

function normalize(row) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    category: row.category,
    language: row.language,
    status: row.status,
    headerType: row.header_type,
    headerContent: row.header_content || '',
    body: row.body,
    footer: row.footer || '',
    buttons: row.buttons || [],
    variables: row.variables || [],
    sampleValues: row.sample_values || {},
    usageCount: Number(row.usage_count || 0),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function list() {
  const { rows } = await pool.query(
    'SELECT * FROM message_templates ORDER BY updated_at DESC, id DESC LIMIT 200'
  );
  return rows.map(normalize);
}

async function getById(id) {
  const { rows } = await pool.query('SELECT * FROM message_templates WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? normalize(rows[0]) : null;
}

async function getByName(name) {
  const { rows } = await pool.query('SELECT * FROM message_templates WHERE name = $1 LIMIT 1', [name]);
  return rows[0] ? normalize(rows[0]) : null;
}

async function create(data) {
  const { rows } = await pool.query(
    `INSERT INTO message_templates
       (name, title, category, language, status, header_type, header_content,
        body, footer, buttons, variables, sample_values)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      data.name,
      data.title,
      data.category || 'UTILITY',
      data.language || 'es',
      data.status || 'APPROVED',
      data.headerType || 'NONE',
      data.headerContent || null,
      data.body,
      data.footer || null,
      JSON.stringify(data.buttons || []),
      JSON.stringify(data.variables || []),
      JSON.stringify(data.sampleValues || {}),
    ]
  );
  return normalize(rows[0]);
}

async function update(id, data) {
  const { rows } = await pool.query(
    `UPDATE message_templates SET
       name = $2, title = $3, category = $4, language = $5, status = $6,
       header_type = $7, header_content = $8, body = $9, footer = $10,
       buttons = $11, variables = $12, sample_values = $13, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      data.name,
      data.title,
      data.category || 'UTILITY',
      data.language || 'es',
      data.status || 'APPROVED',
      data.headerType || 'NONE',
      data.headerContent || null,
      data.body,
      data.footer || null,
      JSON.stringify(data.buttons || []),
      JSON.stringify(data.variables || []),
      JSON.stringify(data.sampleValues || {}),
    ]
  );
  return rows[0] ? normalize(rows[0]) : null;
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM message_templates WHERE id = $1', [id]);
  return rowCount > 0;
}

// Al despachar un envio con la plantilla: suma uso y guarda la fecha.
async function incrementUsage(id) {
  await pool.query(
    'UPDATE message_templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1',
    [id]
  );
}

module.exports = { list, getById, getByName, create, update, remove, incrementUsage, normalize };
