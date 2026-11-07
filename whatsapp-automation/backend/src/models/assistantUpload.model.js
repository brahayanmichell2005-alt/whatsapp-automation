// Subidas de archivos grandes para el chat del asistente del panel.
// Vercel limita cada request a ~4.5 MB: el navegador parte el archivo en
// chunks (~3 MB) y este modelo los guarda hasta que llegan todos. Al estar
// completo, todo queda en UNA fila (chunk_index 0) lista para el analisis.
// Las filas son efimeras: se borran al usarlas o a las 2 horas.

const { pool } = require('../config/database');

const MAX_ASSEMBLED_BYTES = 15 * 1024 * 1024; // tope que soporta Gemini inline
const STALE_HOURS = 2;

async function purgeStale() {
  await pool.query(`DELETE FROM assistant_uploads WHERE created_at < NOW() - INTERVAL '${STALE_HOURS} hours'`);
}

async function upsertChunk({ uploadId, index, total, name, mimetype, data }) {
  await pool.query(
    `INSERT INTO assistant_uploads (upload_id, chunk_index, total_chunks, name, mimetype, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (upload_id, chunk_index) DO UPDATE
       SET total_chunks = EXCLUDED.total_chunks, name = EXCLUDED.name,
           mimetype = EXCLUDED.mimetype, data = EXCLUDED.data, created_at = NOW()`,
    [uploadId, index, total, name || null, mimetype || null, data]
  );
}

async function countChunks(uploadId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n, MIN(total_chunks)::int AS total FROM assistant_uploads WHERE upload_id = $1',
    [uploadId]
  );
  return { received: rows[0].n, total: rows[0].total };
}

// Cuando estan todas las partes: une los bytes en una sola fila y borra los
// chunks. Devuelve { ok } o { error }.
async function assembleIfComplete(uploadId) {
  const { received, total } = await countChunks(uploadId);
  if (total === null || received < total) return { complete: false, received };
  if (total > 1) {
    const { rows } = await pool.query(
      'SELECT data FROM assistant_uploads WHERE upload_id = $1 ORDER BY chunk_index ASC',
      [uploadId]
    );
    const buf = Buffer.concat(rows.map((r) => Buffer.from(r.data)));
    const meta = await pool.query(
      'SELECT name, mimetype FROM assistant_uploads WHERE upload_id = $1 ORDER BY chunk_index ASC LIMIT 1',
      [uploadId]
    );
    if (buf.length > MAX_ASSEMBLED_BYTES) {
      await removeUpload(uploadId);
      return { error: `El archivo pesa ${(buf.length / (1024 * 1024)).toFixed(1)} MB y el maximo es 15 MB` };
    }
    await removeUpload(uploadId);
    await upsertChunk({
      uploadId,
      index: 0,
      total: 1,
      name: meta.rows[0] && meta.rows[0].name,
      mimetype: meta.rows[0] && meta.rows[0].mimetype,
      data: buf,
    });
  }
  return { complete: true };
}

// Devuelve el archivo ensamblado { name, mimetype, data } o null.
async function getAttachment(uploadId) {
  const { rows } = await pool.query(
    'SELECT name, mimetype, data FROM assistant_uploads WHERE upload_id = $1 AND chunk_index = 0 LIMIT 1',
    [uploadId]
  );
  return rows[0] || null;
}

async function removeUpload(uploadId) {
  await pool.query('DELETE FROM assistant_uploads WHERE upload_id = $1', [uploadId]);
}

module.exports = {
  MAX_ASSEMBLED_BYTES,
  purgeStale,
  upsertChunk,
  countChunks,
  assembleIfComplete,
  getAttachment,
  removeUpload,
};
