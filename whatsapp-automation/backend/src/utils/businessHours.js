// Control de horario de atencion (Seccion 14). Usa la zona horaria
// configurada en TIMEZONE para decidir si "ahora" cae dentro de la
// ventana [START_TIME, END_TIME).

const env = require('../config/env');

function getCurrentTimeInTimezone(timezone, now = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      // h23 garantiza 00:xx a medianoche (hour12:false puede devolver 24:xx).
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = formatter.formatToParts(new Date(now));
    const hour = parts.find((p) => p.type === 'hour').value;
    const minute = parts.find((p) => p.type === 'minute').value;
    return `${hour}:${minute}`;
  } catch (err) {
    // Zona horaria invalida: se usa UTC para no bloquear el worker.
    const d = new Date(now);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
}

const TIME_REGEX = /^\d{2}:\d{2}$/;

function isWithinBusinessHours(now = new Date()) {
  const start = TIME_REGEX.test(env.START_TIME) ? env.START_TIME : '00:00';
  const end = TIME_REGEX.test(env.END_TIME) ? env.END_TIME : '24:00';
  const current = getCurrentTimeInTimezone(env.TIMEZONE, now);
  // Comparacion lexicografica funciona porque el formato es HH:MM de 24h.
  return current >= start && current < end;
}

module.exports = { isWithinBusinessHours, getCurrentTimeInTimezone };
