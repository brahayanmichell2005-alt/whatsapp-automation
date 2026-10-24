// Modelo de acceso a datos para la tabla `customers`.
// El CRUD completo via API REST se expone en customer.routes.js;
// aqui solo van las funciones de acceso a datos.

const { pool } = require('../config/database');

async function findByPhone(phone) {
  const { rows } = await pool.query('SELECT * FROM customers WHERE phone = $1 LIMIT 1', [phone]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function create({ phone, name = null, email = null, remoteJid = null }) {
  const { rows } = await pool.query(
    'INSERT INTO customers (phone, name, email, remote_jid) VALUES ($1, $2, $3, $4) RETURNING *',
    [phone, name, email, remoteJid]
  );
  return rows[0];
}

// Busca por telefono; si no existe, lo crea. Usado por el webhook para
// "identificar o crear cliente". Si dos webhooks llegan a la vez para el mismo
// telefono nuevo, ON CONFLICT evita el error de duplicado y se relee el cliente.
// `remoteJid` solo se usa para chats @lid sin telefono alternativo: es el unico
// identificador al que Evolution API puede enviar la respuesta.
async function findOrCreateByPhone(phone, name = null, remoteJid = null) {
  const existing = await findByPhone(phone);
  if (existing) {
    if (remoteJid && existing.remote_jid !== remoteJid) {
      const { rows } = await pool.query(
        'UPDATE customers SET remote_jid = $1 WHERE id = $2 RETURNING *',
        [remoteJid, existing.id]
      );
      return rows[0] || existing;
    }
    return existing;
  }

  const { rows } = await pool.query(
    `INSERT INTO customers (phone, name, remote_jid) VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO NOTHING
     RETURNING *`,
    [phone, name, remoteJid]
  );
  const created = rows[0] || (await findByPhone(phone));
  if (created && remoteJid && created.remote_jid !== remoteJid) {
    const { rows: updated } = await pool.query(
      'UPDATE customers SET remote_jid = $1 WHERE id = $2 RETURNING *',
      [remoteJid, created.id]
    );
    return updated[0] || created;
  }
  return created;
}

async function updateClassification(id, { interestType, interestLevel }) {
  const { rows } = await pool.query(
    'UPDATE customers SET interest_type = $1, interest_level = $2 WHERE id = $3 RETURNING *',
    [interestType, interestLevel, id]
  );
  return rows[0] || null;
}

async function touchLastMessage(id) {
  await pool.query('UPDATE customers SET last_message_at = NOW() WHERE id = $1', [id]);
}

async function list({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM customers ORDER BY updated_at DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return rows;
}

async function update(id, fields) {
  const allowed = ['name', 'email', 'status', 'interest_type', 'interest_level'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return findById(id);

  // Los nombres de columna salen de la lista blanca `allowed`, nunca del usuario.
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map((k) => fields[k]);
  const { rows } = await pool.query(
    `UPDATE customers SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
    [...values, id]
  );
  return rows[0] || null;
}

async function remove(id) {
  await pool.query('DELETE FROM customers WHERE id = $1', [id]);
}

module.exports = {
  findByPhone,
  findById,
  create,
  findOrCreateByPhone,
  updateClassification,
  touchLastMessage,
  list,
  update,
  remove,
};
