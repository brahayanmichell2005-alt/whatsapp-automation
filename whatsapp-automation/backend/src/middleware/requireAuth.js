// Middleware que protege las rutas administrativas.
// Espera: Authorization: Bearer <token>

const authService = require('../services/auth.service');
const logger = require('../utils/logger');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    logger.warn({
      path: req.originalUrl,
      method: req.method,
      reason: 'AUTH_HEADER_MISSING_OR_INVALID'
    }, 'Fallo de autenticacion');

    return res.status(401).json({
      error: 'Autenticacion requerida'
    });
  }

  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch (err) {
    logger.error({
      path: req.originalUrl,
      method: req.method,
      reason: err.message,
      tokenPresent: true
    }, 'Fallo al verificar token');

    return res.status(401).json({
      error: 'Token invalido o expirado'
    });
  }
}

module.exports = { requireAuth };