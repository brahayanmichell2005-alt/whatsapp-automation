// Logger central del sistema (Seccion 30 - Logs).
// Todos los modulos deben loguear a traves de aqui, nunca con console.log,
// para mantener logs estructurados y consistentes.

const pino = require('pino');
const env = require('../config/env');

// pino-pretty (colores) solo en desarrollo: en Vercel los logs deben ser JSON.
const isDev = env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      }
    : undefined,
});

module.exports = logger;
