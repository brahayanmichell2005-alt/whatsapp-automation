// Rate limiting y control de concurrencia (Seccion 13), ahora sobre
// PostgreSQL/Supabase en vez de Redis: contadores por minuto/hora/dia con
// expiracion, un semaforo simple para MAX_CONCURRENT_SENDS y el registro del
// ultimo envio para espaciar mensajes entre ejecuciones del worker.

const rateCounterModel = require('../models/rateCounter.model');
const settingsModel = require('../models/systemSetting.model');
const env = require('../config/env');

async function incrementWithLimit(key, limit, ttlSeconds) {
  const current = await rateCounterModel.increment(key, ttlSeconds);
  return { count: current, allowed: limit <= 0 || current <= limit };
}

// Comprueba (y consume) el cupo de envio por minuto/hora/dia. Devuelve
// { allowed, reason } — si allowed=false, el worker debe esperar/reintentar.
// Las claves usan el ISO de la fecha UTC (con separadores) para que ventanas
// distintas nunca compartan clave.
async function checkSendLimits() {
  const iso = new Date().toISOString(); // 2026-09-19T14:05:31.000Z
  const minuteKey = `rl:minute:${iso.slice(0, 16)}`;
  const hourKey = `rl:hour:${iso.slice(0, 13)}`;
  const dayKey = `rl:day:${iso.slice(0, 10)}`;

  const minute = await incrementWithLimit(minuteKey, env.MAX_MESSAGES_PER_MINUTE, 120);
  if (!minute.allowed) return { allowed: false, reason: 'MAX_MESSAGES_PER_MINUTE' };

  const hour = await incrementWithLimit(hourKey, env.MAX_MESSAGES_PER_HOUR, 7200);
  if (!hour.allowed) return { allowed: false, reason: 'MAX_MESSAGES_PER_HOUR' };

  const day = await incrementWithLimit(dayKey, env.MAX_MESSAGES_PER_DAY, 172800);
  if (!day.allowed) return { allowed: false, reason: 'MAX_MESSAGES_PER_DAY' };

  return { allowed: true };
}

const CONCURRENCY_KEY = 'rl:concurrent_sends';

async function acquireConcurrencySlot() {
  const current = await rateCounterModel.acquire(CONCURRENCY_KEY, 60); // se autolimpia si el proceso muere
  if (current > env.MAX_CONCURRENT_SENDS) {
    await rateCounterModel.release(CONCURRENCY_KEY);
    return false;
  }
  return true;
}

async function releaseConcurrencySlot() {
  await rateCounterModel.release(CONCURRENCY_KEY);
}

// ---------------------------------------------------------------------
// Espaciado entre envios (control de carga, nunca evasion - Seccion 12).
// Como cada ejecucion del worker es una llamada independiente, el momento
// del ultimo envio se guarda en la base para respetar el intervalo aunque
// el envio anterior haya ocurrido en otra ejecucion.
// ---------------------------------------------------------------------
const LAST_SEND_KEY = 'worker_last_send_at';

// Milisegundos que aun faltan para cumplir `targetDelayMs` desde el ultimo envio.
async function getRemainingDelayMs(targetDelayMs) {
  const raw = await settingsModel.get(LAST_SEND_KEY);
  const last = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(last)) return targetDelayMs;
  const elapsed = Date.now() - last;
  return Math.max(0, targetDelayMs - Math.max(0, elapsed));
}

async function recordSend() {
  await settingsModel.set(LAST_SEND_KEY, String(Date.now()));
}

module.exports = {
  checkSendLimits,
  acquireConcurrencySlot,
  releaseConcurrencySlot,
  getRemainingDelayMs,
  recordSend,
};
