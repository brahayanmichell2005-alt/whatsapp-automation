// Control de horario de atencion (Seccion 14). Usa la zona horaria
// configurada en TIMEZONE para decidir si "ahora" cae dentro de la
// ventana [START_TIME, END_TIME).

const env = require('../config/env');

function getCurrentTimeInTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const hour = parts.find((p) => p.type === 'hour').value;
  const minute = parts.find((p) => p.type === 'minute').value;
  return `${hour}:${minute}`;
}

function isWithinBusinessHours(now = new Date()) {
  const current = getCurrentTimeInTimezone(env.TIMEZONE);
  // Comparacion lexicografica funciona porque el formato es HH:MM de 24h.
  return current >= env.START_TIME && current < env.END_TIME;
}

module.exports = { isWithinBusinessHours, getCurrentTimeInTimezone };
