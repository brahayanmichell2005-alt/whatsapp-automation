// Punto de entrada para DESARROLLO LOCAL (npm run dev / npm start).
// En Vercel NO se usa este archivo: la app se expone desde api/index.js y las
// tareas de fondo las dispara POST /api/cron/tick (ver database/cron.sql).
//
// En local, el scheduler de mensajes programados corre con setInterval y el
// worker de envio se ejecuta aparte con `npm run worker`.

const env = require('./config/env');
const app = require('./app');
const logger = require('./utils/logger');
const database = require('./config/database');
const scheduler = require('./services/scheduler.service');
const authService = require('./services/auth.service');

async function start() {
  const dbOk = await database.checkConnection();

  if (!dbOk) {
    logger.warn('El backend arranca sin conexion confirmada a la base de datos. Revisa DATABASE_URL.');
  }

  if (dbOk) {
    try {
      await authService.ensureAdminUser();
    } catch (err) {
      logger.error({ err: err.message }, 'No se pudo crear/verificar el usuario administrador inicial');
    }
  }

  app.listen(env.PORT, () => {
    logger.info(`Backend escuchando en el puerto ${env.PORT} (${env.NODE_ENV})`);
  });

  scheduler.start();
}

start().catch((err) => {
  logger.error({ err }, 'Fallo critico al iniciar el backend');
  process.exit(1);
});
