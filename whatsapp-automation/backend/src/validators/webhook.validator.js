// Validacion basica de la estructura del webhook (Seccion 6, pasos 2-3,
// y Seccion 28 - "Validacion de webhook"). La verificacion de firma/secreto
// se agrega en la Entrega 8 junto con el resto de seguridad; por ahora se
// valida que el payload tenga la forma minima esperada y, si esta
// configurada, que corresponda a nuestra instancia.

const env = require('../config/env');

function validateWebhookPayload(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'El cuerpo de la peticion esta vacio o no es JSON valido' };
  }

  if (!body.event || typeof body.event !== 'string') {
    return { valid: false, reason: 'Falta el campo "event" en el payload' };
  }

  if (env.EVOLUTION_INSTANCE && body.instance && body.instance !== env.EVOLUTION_INSTANCE) {
    return {
      valid: false,
      reason: `El evento pertenece a otra instancia ("${body.instance}"), se esperaba "${env.EVOLUTION_INSTANCE}"`,
    };
  }

  return { valid: true };
}

module.exports = { validateWebhookPayload };
