// Middleware que protege las rutas administrativas.
// Espera: Authorization: Bearer <token>

const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
<<<<<<< HEAD
const logModel = require('../models/automationLog.model');
=======
>>>>>>> origin/main
const logger = require('../utils/logger');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
<<<<<<< HEAD
    return logModel
      .record({
        eventType: 'auth_debug',
        level: 'ERROR',
        message: `401 sin token en ${req.method} ${req.path}: header="${header.slice(0, 20)}"`,
      })
      .catch((e) => logger.error({ err: e.message }, 'No se pudo registrar auth_debug'))
      .finally(() => res.status(401).json({ error: 'Autenticacion requerida' }));
=======
    logger.warn({
      path: req.originalUrl,
      method: req.method,
      reason: 'AUTH_HEADER_MISSING_OR_INVALID'
    }, 'Fallo de autenticacion');

    return res.status(401).json({
      error: 'Autenticacion requerida'
    });
>>>>>>> origin/main
  }

  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch (err) {
<<<<<<< HEAD
    const decoded = jwt.decode(token) || {};
    return logModel
      .record({
        eventType: 'auth_debug',
        level: 'ERROR',
        message: `401 token invalido en ${req.method} ${req.path}: ${err.name} - ${err.message}. exp=${decoded.exp} iat=${decoded.iat} len=${token.length}`,
      })
      .catch((e) => logger.error({ err: e.message }, 'No se pudo registrar auth_debug'))
      .finally(() => res.status(401).json({ error: 'Token invalido o expirado' }));
=======
    logger.error({
      path: req.originalUrl,
      method: req.method,
      reason: err.message,
      tokenPresent: true
    }, 'Fallo al verificar token');

    return res.status(401).json({
      error: 'Token invalido o expirado'
    });
>>>>>>> origin/main
  }
}

module.exports = { requireAuth };
