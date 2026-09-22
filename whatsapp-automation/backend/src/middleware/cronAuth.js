// Protege /api/cron/* con un secreto compartido (CRON_SECRET).
//
// Quien llama (Supabase pg_cron, o Vercel Cron si tienes plan Pro) debe enviar:
//   Authorization: Bearer <CRON_SECRET>
// Vercel Cron agrega esa cabecera solo, si la variable CRON_SECRET existe.
//
// Falla cerrado: si CRON_SECRET no esta definido, el endpoint responde 503 y
// nunca queda abierto por descuido.

const env = require('../config/env');
const httpError = require('../utils/httpError');
const { safeEqual } = require('./webhookAuth');

function cronAuth(req, res, next) {
  if (!env.CRON_SECRET) {
    return next(httpError(503, 'CRON_SECRET no esta configurado en el servidor'));
  }

  const header = req.get('authorization') || '';
  const provided = header.replace(/^Bearer\s+/i, '');

  if (!provided || !safeEqual(provided, env.CRON_SECRET)) {
    return next(httpError(401, 'Secreto de cron invalido'));
  }
  return next();
}

module.exports = { cronAuth };
