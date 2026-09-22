// Autenticacion basica del webhook por secreto compartido (Entrega 4).
//
// Si WEBHOOK_SECRET esta definido, Evolution API debe enviarlo en la cabecera
// `x-webhook-token` (o `Authorization: Bearer <secreto>`). Se configura una vez
// con POST /api/instance/webhook, que lo registra como cabecera del webhook
// en Evolution API. Si WEBHOOK_SECRET esta vacio, el webhook queda abierto
// (solo aceptable en desarrollo). El endurecimiento completo llega en la
// Entrega 8.
//
// Se acepta solo por cabecera, nunca por query string: pino-http registra la
// URL de cada request y el secreto quedaria escrito en los logs.

const crypto = require('crypto');
const env = require('../config/env');
const httpError = require('../utils/httpError');

// Compara hashes de igual longitud con timingSafeEqual para evitar ataques
// de temporizacion.
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function webhookAuth(req, res, next) {
  const secret = env.WEBHOOK_SECRET;
  if (!secret) return next();

  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = req.get('x-webhook-token') || bearer;

  if (!provided || !safeEqual(provided, secret)) {
    return next(httpError(401, 'Token de webhook invalido'));
  }
  return next();
}

module.exports = { webhookAuth, safeEqual };
