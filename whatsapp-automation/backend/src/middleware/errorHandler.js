// Middleware de manejo de errores centralizado. Debe registrarse
// como el ULTIMO middleware en app.js.

const env = require('../config/env');
const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error({ err, path: req.path, method: req.method }, 'Error no controlado');

  const status = err.status || 500;
  const message =
    env.NODE_ENV === 'production' && status === 500
      ? 'Error interno del servidor'
      : err.message;

  res.status(status).json({ error: message });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFoundHandler };
