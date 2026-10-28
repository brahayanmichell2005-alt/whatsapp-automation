// Protege las rutas administrativas. Espera: Authorization: Bearer <token>
const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

// Registra el motivo en BD y ESPERA antes de responder (en serverless la funcion
// se congela al enviar la respuesta).
function reject(res, message, error, level = 'ERROR') {
  return logModel
    .record({ eventType: 'auth_debug', level, message })
    .catch((e) => logger.error({ err: e.message }, 'No se pudo registrar auth_debug'))
    .finally(() => res.status(401).json({ error }));
}

function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    // Un 401 sin token es normal (sesion vencida, panel cerrado o un bot):
    // se registra como advertencia para no ensuciar el contador de errores.
    // originalUrl conserva la ruta completa aunque el middleware viva dentro
    // de un router montado (req.path ahi seria solo "/").
    return reject(
      res,
      `401 sin token en ${req.method} ${req.originalUrl || req.url}`,
      'Autenticacion requerida',
      'WARN'
    );
  }
  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch (err) {
    // Un token vencido es normal (la sesion dura 8 h): no se registra como error.
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token invalido o expirado' });
    const d = jwt.decode(token) || {};
    return reject(res, `401 token invalido en ${req.method} ${req.originalUrl || req.url}: ${err.name} - ${err.message}. exp=${d.exp} iat=${d.iat}`, 'Token invalido o expirado');
  }
}

module.exports = { requireAuth };
