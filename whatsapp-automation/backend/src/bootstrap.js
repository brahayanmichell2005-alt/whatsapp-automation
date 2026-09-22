// Inicializacion perezosa para entornos serverless.
// En un servidor tradicional, server.js crea el usuario administrador al
// arrancar. En Vercel no hay "arranque": se ejecuta una vez por instancia,
// en la primera peticion, y el resultado se recuerda mientras siga caliente.

const authService = require('./services/auth.service');
const logger = require('./utils/logger');

let bootstrapPromise = null;

function ensureBootstrapped() {
  if (!bootstrapPromise) {
    bootstrapPromise = authService.ensureAdminUser().catch((err) => {
      // No se recuerda el fallo: se reintenta en la siguiente peticion
      // (por ejemplo si la base de datos aun no estaba lista).
      bootstrapPromise = null;
      logger.error({ err: err.message }, 'No se pudo crear/verificar el usuario administrador inicial');
    });
  }
  return bootstrapPromise;
}

module.exports = { ensureBootstrapped };
