// Middleware que protege las rutas administrativas.
// Espera: Authorization: Bearer <token>

const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return logModel
      .record({
        eventType: 'auth_debug',
        level: 'ERROR',
        message: `401 sin token en ${req.method} ${req.path}`,
      })
      .catch((e) => logger.error({ err: e.message }, 'No se pudo registrar auth_debug'))
      .finally(() => res.status(401).json({ error: 'Autenticacion requerida' }));
  }

  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch (err) {
    const decoded = jwt.decode(token) || {};
    return logModel
      .record({
        eventType: 'auth_debug',
        level: 'ERROR',
        message: `401 token invalido en ${req.method} ${req.path}: ${err.name} - ${err.message}. exp=${decoded.exp} iat=${decoded.iat}`,
      })
      .catch((e) => logger.error({ err: e.message }, 'No se pudo registrar auth_debug'))
      .finally(() => res.status(401).json({ error: 'Token invalido o expirado' }));
  }
}

module.exports = { requireAuth };