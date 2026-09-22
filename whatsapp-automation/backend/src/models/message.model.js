// Modelo de acceso a datos para la tabla `messages`.

const { pool } = require('../config/database');

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function findByExternalId(externalMessageId) {
  if (!externalMessageId) return null;
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE external_message_id = $1 LIMIT 1',
    [externalMessageId]
  );
  return rows[0] || null;
}

async function create({
  conversationId,
  customerId,
  direction,
  messageType = 'TEXT',
  content = null,
  externalMessageId = null,
  status = 'PENDING',
}) {
  const { rows } = await pool.query(
    `INSERT INTO messages
      (conversation_id, customer_id, direction, message_type, content, external_message_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [conversationId, customerId, direction, messageType, content, externalMessageId, status]
  );
  return rows[0];
}

async function updateStatus(id, status) {
  const sentAtClause = status === 'SENT' ? ', sent_at = NOW()' : '';
  const { rows } = await pool.query(
    `UPDATE messages SET status = $1${sentAtClause} WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return rows[0] || null;
}

async function listByConversation(conversationId, { limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3',
    [conversationId, limit, offset]
  );
  return rows;
}

async function list({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return rows;
}

module.exports = {
  findById,
  findByExternalId,
  create,
  updateStatus,
  listByConversation,
  list,
};
