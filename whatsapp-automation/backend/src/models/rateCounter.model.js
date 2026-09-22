// Contadores con expiracion en PostgreSQL (reemplazan a los INCR/EXPIRE de Redis).
// Se usan para los limites de envio por minuto/hora/dia y para el semaforo de
// concurrencia del worker. Ver tabla `rate_counters` en database/schema.sql.

const { pool } = require('../config/database');

// Suma 1 al contador de una "ventana" (la clave ya incluye el minuto/hora/dia,
// asi que cada ventana es una fila distinta). Atomico, seguro ante concurrencia.
async function increment(counterKey, ttlSeconds) {
  const { rows } = await pool.query(
    `INSERT INTO rate_counters (counter_key, hits, expires_at)
     VALUES ($1, 1, NOW() + make_interval(secs => $2::int))
     ON CONFLICT (counter_key) DO UPDATE SET hits = rate_counters.hits + 1
     RETURNING hits`,
    [counterKey, ttlSeconds]
  );
  return rows[0].hits;
}

// Igual que increment, pero si la fila ya expiro el contador reinicia en 1 y se
// renueva el plazo (equivale al EXPIRE de Redis: si el proceso muere sin liberar
// el cupo, se autolimpia).
async function acquire(counterKey, ttlSeconds) {
  const { rows } = await pool.query(
    `INSERT INTO rate_counters (counter_key, hits, expires_at)
     VALUES ($1, 1, NOW() + make_interval(secs => $2::int))
     ON CONFLICT (counter_key) DO UPDATE SET
       hits = CASE WHEN rate_counters.expires_at < NOW() THEN 1 ELSE rate_counters.hits + 1 END,
       expires_at = NOW() + make_interval(secs => $2::int)
     RETURNING hits`,
    [counterKey, ttlSeconds]
  );
  return rows[0].hits;
}

async function release(counterKey) {
  await pool.query(
    'UPDATE rate_counters SET hits = GREATEST(hits - 1, 0) WHERE counter_key = $1',
    [counterKey]
  );
}

// Borra ventanas viejas (llamado por el worker en cada ciclo).
async function purgeExpired() {
  const result = await pool.query(
    "DELETE FROM rate_counters WHERE expires_at < NOW() - INTERVAL '1 day'"
  );
  return result.rowCount;
}

module.exports = { increment, acquire, release, purgeExpired };
