// Modelo de acceso a datos para la tabla `messages`.

const { pool } = require('../config/database');

// Columnas de lectura SIEMPRE excluyen media_data (bytea): los listados del
// panel no deben cargar binarios. El archivo se lee solo en getMediaData().
const READ_COLS = `id, conversation_id, customer_id, direction, message_type, content,
  external_message_id, status, created_at, sent_at, media_url, media_key,
  media_mime, media_kind, media_meta`;

async function findById(id) {
  const { rows } = await pool.query(`SELECT ${READ_COLS} FROM messages WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}

// Bytes del archivo guardado en llegada (para el endpoint /media). Devuelve
// null si el mensaje no existe.
async function getMediaData(id) {
  const { rows } = await pool.query(
    'SELECT media_data, media_mime, media_kind, media_meta, media_url, media_key FROM messages WHERE id = $1 LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function findByExternalId(externalMessageId) {
  if (!externalMessageId) return null;
  const { rows } = await pool.query(
    `SELECT ${READ_COLS} FROM messages WHERE external_message_id = $1 LIMIT 1`,
    [externalMessageId]
  );
  return rows[0] || null;
}

// Limite de tamano para guardar el archivo descifrado (16 MB). Audios,
// imagenes y stickers de WhatsApp caben de sobra; un video muy grande se
// queda con el fallback del CDN de WhatsApp.
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

async function create({
  conversationId,
  customerId,
  direction,
  messageType = 'TEXT',
  content = null,
  externalMessageId = null,
  status = 'PENDING',
  media = null,
  mediaData = null,
  mediaMeta = null,
}) {
  // STICKER viola el CHECK de la BD (solo acepta tipos conocidos): se guarda
  // como OTHER y media_kind conserva el tipo real para la UI.
  const dbMessageType = media && media.kind === 'STICKER' ? 'OTHER' : messageType;
  const bytes =
    Buffer.isBuffer(mediaData) && mediaData.length > 0 && mediaData.length <= MAX_MEDIA_BYTES
      ? mediaData
      : null;
  const { rows } = await pool.query(
    `INSERT INTO messages
      (conversation_id, customer_id, direction, message_type, content, external_message_id, status,
       media_url, media_key, media_mime, media_kind, media_data, media_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${READ_COLS}`,
    [
      conversationId,
      customerId,
      direction,
      dbMessageType,
      content,
      externalMessageId,
      status,
      media ? media.url : null,
      media ? media.mediaKey : null,
      media ? media.mimetype : null,
      media ? media.kind : null,
      bytes,
      mediaMeta || null,
    ]
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

// Borrado fisico desde el panel (vista de chat en vivo). Devuelve true si
// existia y se borro, false si ya no estaba.
async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM messages WHERE id = $1', [id]);
  return rowCount > 0;
}

async function listByConversation(conversationId, { limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${READ_COLS} FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3`,
    [conversationId, limit, offset]
  );
  return rows;
}

// Mensajes NUEVOS de una conversacion con id > sinceId (para el chat en
// vivo: actualizacion incremental sin duplicados ni recargar el historial).
async function listSince(conversationId, sinceId, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${READ_COLS} FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
    [conversationId, sinceId, limit]
  );
  return rows;
}

// Ultimos N mensajes de la conversacion, en orden cronologico (contexto para la IA).
async function listRecentByConversation(conversationId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT ${READ_COLS} FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) t ORDER BY created_at ASC, id ASC`,
    [conversationId, limit]
  );
  return rows;
}

async function list({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${READ_COLS} FROM messages ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

// Total de mensajes de una conversacion (para decidir cuando resumir memoria).
async function countByConversation(conversationId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM messages WHERE conversation_id = $1',
    [conversationId]
  );
  return (rows[0] && rows[0].total) || 0;
}

// Auto-cache de multimedia: guarda en la BD los bytes descifrados del CDN la
// primera vez que el panel los sirve. Silencioso: si falla, el endpoint sigue
// sirviendo por CDN como siempre. Solo cachea dentro del limite de 16 MB.
async function cacheMediaData(id, buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_MEDIA_BYTES) return false;
  try {
    const { rowCount } = await pool.query(
      `UPDATE messages SET media_data = $1, media_mime = COALESCE(media_mime, $2)
       WHERE id = $3 AND media_data IS NULL`,
      [buffer, mime || null, id]
    );
    return rowCount > 0;
  } catch (err) {
    return false;
  }
}

module.exports = {
  listRecentByConversation,
  findById,
  getMediaData,
  cacheMediaData,
  findByExternalId,
  create,
  updateStatus,
  remove,
  listByConversation,
  listSince,
  countByConversation,
  list,
};

