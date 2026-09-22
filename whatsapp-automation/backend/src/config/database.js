// Conexion a Supabase (PostgreSQL) con node-postgres.
//
// Notas para serverless (Vercel):
//  - El pool se crea la primera vez que se hace una consulta (no al importar),
//    y se reutiliza mientras la instancia de la funcion siga "caliente".
//  - Usa la cadena "Transaction pooler" de Supabase (puerto 6543). node-postgres
//    no usa sentencias preparadas con nombre, asi que es compatible.
//  - Se exporta `pool` con la misma forma que usaban los modelos:
//    pool.query(sql, params) -> { rows, rowCount }.

const { Pool, types } = require('pg');
const env = require('./env');
const logger = require('../utils/logger');

// BIGINT (OID 20), p. ej. COUNT(*), llega como string por defecto: lo pasamos a numero.
types.setTypeParser(20, (value) => parseInt(value, 10));

let realPool = null;

// El driver deja que `sslmode` del URL pise nuestra configuracion ssl y, con
// el certificado de Supabase, eso produce "self-signed certificate in chain".
// Quitamos esos parametros y manejamos SSL explicitamente.
function cleanConnectionString(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('pgbouncer');
    return u.toString();
  } catch (err) {
    return url;
  }
}

function getPool() {
  if (realPool) return realPool;

  if (!env.DATABASE_URL) {
    throw new Error(
      'Falta DATABASE_URL. Copia la cadena "Transaction pooler" desde Supabase (Connect) y defínela como variable de entorno.'
    );
  }

  realPool = new Pool({
    connectionString: cleanConnectionString(env.DATABASE_URL),
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  });

  realPool.on('error', (err) => {
    logger.error({ err: err.message }, 'Error inesperado en una conexion inactiva de PostgreSQL');
  });

  return realPool;
}

const pool = {
  // async: cualquier error (p. ej. falta DATABASE_URL) llega como promesa rechazada.
  query: async (text, params) => getPool().query(text, params),
  end: async () => {
    if (realPool) {
      const p = realPool;
      realPool = null;
      await p.end();
    }
  },
};

async function checkConnection() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'No se pudo conectar a Supabase (PostgreSQL)');
    return false;
  }
}

module.exports = { pool, checkConnection };
