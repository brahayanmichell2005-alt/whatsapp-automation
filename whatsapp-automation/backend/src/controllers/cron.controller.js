// Controller de tareas periodicas. En la nube no hay procesos permanentes, asi
// que el trabajo de fondo (mover mensajes programados a la cola y enviar la
// cola) se ejecuta cuando Supabase pg_cron llama a este endpoint cada minuto.

const env = require('../config/env');
const schedulerService = require('../services/scheduler.service');
const messageWorker = require('../workers/message.worker');

async function tick(req, res, next) {
  try {
    const startedAt = Date.now();

    // 1) Mensajes programados cuya hora ya llego -> cola
    const scheduledMoved = await schedulerService.tick();

    // 2) Cola -> WhatsApp (respeta horario, limites e intervalos)
    const worker = await messageWorker.tick({ budgetMs: env.CRON_BUDGET_MS });

    res.json({ ok: true, scheduledMoved, worker, tookMs: Date.now() - startedAt });
  } catch (err) {
    next(err);
  }
}

module.exports = { tick };
