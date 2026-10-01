// Middleware que protege las rutas administrativas (Seccion 26 - "Solicitar
// autenticacion para estas operaciones"). Espera un header
// "Authorization: Bearer <token>".

const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    logModel
      .record({
        eventType: 'auth_debug',
        level: 'ERROR',
        message: `401 sin token en ${req.method} ${req.path}: header="${header.slice(0, 20)}"`,
      })
      .catch((e) => logger.error({ err: e.message }, 'No se pudo registrar auth_debug'));
    return res.status(401).json({ error: 'Autenticacion requerida' });
  }

  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch (err) {
    const decoded = jwt.decode(token) || {};
    logModel
      .record({
        eventType: 'auth_debug',
        level: 'ERROR',
        message: `401 token invalido en ${req.method} ${req.path}: ${err.name} - ${err.message}. exp=${decoded.exp} iat=${decoded.iat} len=${token.length}`,
      })
      .catch((e) => logger.error({ err: e.message }, 'No se pudo registrar auth_debug'));
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }
}

module.exports = { requireAuth };
