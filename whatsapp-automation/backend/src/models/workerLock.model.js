// Candado con expiracion en PostgreSQL (reemplaza al SET NX PX de Redis).
// Evita que dos ejecuciones simultaneas del worker procesen la cola a la vez.
// Ver tabla `worker_locks` en database/schema.sql.
//
// Se implementa con una tabla (no con pg_advisory_lock) porque el "Transaction
// pooler" de Supabase no conserva bloqueos de sesion entre consultas.

const { pool } = require('../config/database');

// Devuelve true si obtuvo el candado. Si otro lo tiene vigente, devuelve false.
// Si el candado anterior ya expiro (proceso muerto), lo toma.
async function acquire(name, ttlSeconds) {
  const result = await pool.query(
    `INSERT INTO worker_locks (name, expires_at)
     VALUES ($1, NOW() + make_interval(secs => $2::int))
     ON CONFLICT (name) DO UPDATE SET expires_at = EXCLUDED.expires_at
     WHERE worker_locks.expires_at < NOW()
     RETURNING name`,
    [name, ttlSeconds]
  );
  return result.rowCount === 1;
}

async function release(name) {
  await pool.query(
    "UPDATE worker_locks SET expires_at = NOW() - INTERVAL '1 second' WHERE name = $1",
    [name]
  );
}

module.exports = { acquire, release };
