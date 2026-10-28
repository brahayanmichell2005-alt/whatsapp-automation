// Controller de tareas periodicas. En la nube no hay procesos permanentes, asi
// que el trabajo de fondo se ejecuta cuando Supabase pg_cron llama a este
// endpoint cada minuto:
//   1) mover mensajes programados cuya hora llego a la cola,
//   2) procesar la cola persistente de respuestas automaticas (tiempos por
//      cliente, agrupacion y concurrencia),
//   3) enviar lo que quede en message_queue.
// El procesador de respuestas tambien dispara el envio, pero se vuelve a
// ejecutar el worker para recoger mensajes manuales o programados.

const env = require('../config/env');
const schedulerService = require('../services/scheduler.service');
const responseProcessing = require('../services/responseProcessing.service');
const messageWorker = require('../workers/message.worker');
const assistantService = require('../services/assistant.service');

async function tick(req, res, next) {
  try {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1000, env.CRON_BUDGET_MS || 50000);

    // 1) Mensajes programados cuya hora ya llego -> cola
    const scheduledMoved = await schedulerService.tick();

    // 2) Respuestas automaticas pendientes (respeta tiempos y agrupacion)
    let responses = null;
    try {
      responses = await responseProcessing.tick({
        budgetMs: Math.max(1000, Math.min(env.RESPONSE_BUDGET_MS, deadline - Date.now() - 5000)),
      });
    } catch (err) {
      responses = { error: err.message };
    }

    // 3) Cola -> WhatsApp (respeta horario, limites e intervalos)
    const remaining = Math.max(1000, deadline - Date.now());
    const worker = await messageWorker.tick({ budgetMs: remaining });

    // 4) Resumen diario del asistente (una vez al dia, a la hora configurada).
    //    Si falla no afecta al envio de la cola: se registra y sigue.
    let daily = null;
    try {
      daily = await assistantService.dailyTick();
    } catch (err) {
      daily = { error: err.message };
    }

    res.json({ ok: true, scheduledMoved, responses, worker, daily, tookMs: Date.now() - startedAt });
  } catch (err) {
    next(err);
  }
}

module.exports = { tick };
