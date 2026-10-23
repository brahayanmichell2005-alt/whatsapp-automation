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
// Las claves usan la fecha/hora local de TIMEZONE (con separadores) para que
// ventanas distintas nunca compartan clave.
// Claves de ventana en la zona horaria configurada (TIMEZONE), para que el
// limite diario no se reinicie a las 00:00 UTC sino a la medianoche local
// (America/Lima por defecto). El formato conserva separadores para que sea
// legible en la tabla rate_counters.
function zonedWindowParts(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: env.TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((p) => [p.type, p.value])
    );
    return {
      minute: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
      hour: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`,
      day: `${parts.year}-${parts.month}-${parts.day}`,
    };
  } catch (err) {
    // Zona horaria invalida: se usa UTC para no bloquear los envios.
    const iso = date.toISOString();
    return { minute: iso.slice(0, 16), hour: iso.slice(0, 13), day: iso.slice(0, 10) };
  }
}

async function checkSendLimits() {
  const window = zonedWindowParts();
  const minuteKey = `rl:minute:${window.minute}`;
  const hourKey = `rl:hour:${window.hour}`;
  const dayKey = `rl:day:${window.day}`;

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
  // Toma el cupo solo si hay espacio. Si el contador esta lleno no lo
  // incrementa ni renueva su TTL, para que pueda caducar y recuperarse.
  const current = await rateCounterModel.acquireLimited(
    CONCURRENCY_KEY,
    env.MAX_CONCURRENT_SENDS,
    60
  );
  return current !== null;
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
