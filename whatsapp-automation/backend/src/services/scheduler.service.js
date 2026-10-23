// Servicio que revisa los mensajes programados cuya hora ya llego y los mueve
// a la cola de envio (Seccion 17, ultima linea).
//  - En la nube (Vercel): lo ejecuta POST /api/cron/tick en cada llamada del
//    cron (tick()), porque no existen procesos con setInterval permanente.
//  - En local: server.js llama a start() y se repite con setInterval.

const scheduledModel = require('../models/scheduledMessage.model');
const queueModel = require('../models/messageQueue.model');
const logModel = require('../models/automationLog.model');
const workerLock = require('../models/workerLock.model');
const logger = require('../utils/logger');

const CHECK_INTERVAL_MS = parseInt(process.env.SCHEDULER_INTERVAL_MS, 10) || 30000;
const LOCK_NAME = 'scheduled_messages_tick';
const LOCK_TTL_SECONDS = 25;
let intervalHandle = null;

// Devuelve cuantos mensajes programados movio a la cola.
async function tick() {
  let moved = 0;
  let locked = false;
  try {
    // Evita que dos ejecuciones (cron + scheduler local) muevan el mismo
    // mensaje programado a la cola dos veces.
    locked = await workerLock.acquire(LOCK_NAME, LOCK_TTL_SECONDS);
    if (!locked) return 0;

    const due = await scheduledModel.findDue(20);
    for (const item of due) {
      // eslint-disable-next-line no-await-in-loop
      await scheduledModel.markQueued(item.id);
      // eslint-disable-next-line no-await-in-loop
      await queueModel.enqueue({
        customerId: item.customer_id,
        phone: item.phone,
        message: item.message,
        scheduledMessageId: item.id,
      });
      // El estado SENT/FAILED lo pone el worker cuando realmente lo envia,
      // para no mostrar como enviado algo que sigue en la cola.
      // eslint-disable-next-line no-await-in-loop
      await logModel.record({
        eventType: 'scheduled_message_queued',
        level: 'INFO',
        message: `Mensaje programado ${item.id} movido a la cola de envio`,
        metadata: { customerId: item.customer_id, scheduledMessageId: item.id },
      });
      moved += 1;
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Error revisando mensajes programados');
  } finally {
    if (locked) {
      try {
        await workerLock.release(LOCK_NAME);
      } catch (err) {
        logger.error({ err: err.message }, 'No se pudo liberar el candado del scheduler');
      }
    }
  }
  return moved;
}

function start() {
  if (intervalHandle) return;
  logger.info(`Scheduler de mensajes programados iniciado (cada ${CHECK_INTERVAL_MS}ms)`);
  intervalHandle = setInterval(tick, CHECK_INTERVAL_MS);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, tick };
