// Worker de envio (Seccion 11). Busca mensajes pendientes en `message_queue` y
// los envia via Evolution API respetando automatizacion, horario,
// consentimiento, limites, conexion e intervalos, con reintentos controlados.
//
// Se puede ejecutar de dos formas:
//  1) En la nube (Vercel): NO hay procesos permanentes. Una llamada a
//     POST /api/cron/tick (la dispara Supabase pg_cron cada minuto) ejecuta
//     tick({ budgetMs }): procesa lo que quepa en ese tiempo y termina.
//  2) En local: `npm run worker` mantiene un bucle infinito (loop()).
//
// Flujo (Seccion 11):
//   Buscar mensaje pendiente -> automatizacion -> horario -> consentimiento
//   -> limites -> conexion -> esperar intervalo -> enviar -> registrar resultado

const env = require('../config/env');
const logger = require('../utils/logger');
const queueModel = require('../models/messageQueue.model');
const responseJobModel = require('../models/responseJob.model');
const customerModel = require('../models/customer.model');
const messageModel = require('../models/message.model');
const conversationModel = require('../models/conversation.model');
const scheduledModel = require('../models/scheduledMessage.model');
const prefsModel = require('../models/communicationPreference.model');
const logModel = require('../models/automationLog.model');
const settingsModel = require('../models/systemSetting.model');
const rateCounterModel = require('../models/rateCounter.model');
const workerLock = require('../models/workerLock.model');
const evolutionService = require('../services/evolution.service');
const rateLimiter = require('../services/rateLimiter.service');
const anomalyDetection = require('../services/anomalyDetection.service');
const businessHours = require('../utils/businessHours');

const POLL_INTERVAL_MS = 5000;
const LOCK_NAME = 'message_worker_tick';
// Margen antes del limite de tiempo para que la llamada a Evolution API y el
// registro del resultado terminen dentro de la ejecucion.
const SEND_SAFETY_MS = 8000;
const STALE_PROCESSING_MINUTES = 5;
let stopping = false;

function randomDelayMs() {
  const min = env.MIN_DELAY_SECONDS * 1000;
  const max = env.MAX_DELAY_SECONDS * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decide si un error de envio deja el mensaje en estado incierto. Un
// timeout, un 5xx o un corte de red no permiten saber si WhatsApp recibio el
// mensaje; en ese caso NO se reintenta para no duplicarlo. Un 4xx (numero
// invalido, rechazo explicito) o un error de configuracion si es un fallo
// confirmado y puede reintentarse.
const NETWORK_CODES = [
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
];

function classifySendError(err) {
  const code = String((err && err.code) || '');
  const upstream = Number(err && err.upstreamStatus) || null;

  // El hosting responde 404 "Application not found": el mensaje nunca llego.
  if (code === 'EVOLUTION_UPSTREAM_DOWN') {
    return { uncertain: false, reason: 'evolution_no_disponible' };
  }
  if (err && err.uncertain === true) return { uncertain: true, reason: 'marcado_incierto' };
  if (NETWORK_CODES.includes(code)) return { uncertain: true, reason: `red_${code}` };
  if (upstream && upstream >= 500) return { uncertain: true, reason: `http_${upstream}` };
  if (upstream === 408) return { uncertain: true, reason: 'http_408' };
  // 502 sin estado del upstream = no hubo respuesta HTTP del conector.
  if (err && err.status === 502 && !upstream) return { uncertain: true, reason: 'sin_respuesta' };
  if (err && err.status === 504) return { uncertain: true, reason: 'timeout' };
  return { uncertain: false, reason: 'fallo_confirmado' };
}

// Mantiene sincronizado el trabajo logico con el resultado del envio. Un
// fallo aqui no debe convertir un envio exitoso en error.
async function syncJob(action, ...args) {
  try {
    return await responseJobModel[action](...args);
  } catch (err) {
    logger.error({ err: err.message, action }, 'No se pudo actualizar el trabajo de respuesta tras el envio');
    return null;
  }
}

async function isAutomationActive() {
  const status = await settingsModel.get('automation_status');
  const pauseFlag = await settingsModel.get('pause_queue');
  return status !== 'PAUSED' && status !== 'STOPPED' && pauseFlag !== 'true';
}

// Procesa un mensaje de la cola. Devuelve que paso, para que tick() decida si
// seguir con el siguiente:
//   'sent'     -> enviado                          (hubo avance)
//   'failed'   -> descartado definitivamente       (hubo avance)
//   'retry'    -> fallo, quedo PENDING para reintentar
//   'skipped'  -> no toca enviar ahora (pausa, horario, limite, WhatsApp desconectado)
//   'deferred' -> no alcanza el tiempo de esta ejecucion; se envia en la siguiente
async function processOne(item, { deadline = null } = {}) {
  // 1. Automatizacion activa
  if (!(await isAutomationActive())) {
    logger.info('Automatizacion pausada/detenida: se deja el mensaje pendiente');
    return 'skipped';
  }

  // 2. Horario de atencion
  if (!businessHours.isWithinBusinessHours()) {
    logger.info({ id: item.id }, 'Fuera de horario de atencion: mensaje queda pendiente');
    return 'skipped';
  }

  // 3. Consentimiento
  const prefs = await prefsModel.findByCustomer(item.customer_id);
  if (prefs?.opted_out) {
    await queueModel.markFailed(item.id, 'Cliente en opt-out, cancelado');
    await logModel.record({
      eventType: 'queue_send',
      level: 'WARN',
      message: `Mensaje ${item.id} cancelado: cliente ${item.phone} esta en opt-out`,
    });
    return 'failed';
  }

  // 3.5. El trabajo de respuesta sigue vigente. Si llego un mensaje nuevo o
  // una persona tomo la conversacion, este envio ya no debe salir aunque el
  // texto ya estuviera generado y encolado.
  if (
    item.response_job_id
    && !(await queueModel.isQueueItemCurrent(item.id, item.response_job_id, item.response_generation))
  ) {
    await queueModel.markCancelled(item.id, 'Respuesta invalidada antes del envio');
    await logModel.record({
      eventType: 'queue_send_stale_cancelled',
      level: 'WARN',
      message: `Mensaje ${item.id} cancelado: la respuesta ya no era la vigente`,
      metadata: { responseJobId: item.response_job_id },
    });
    return 'failed';
  }

  // 4. Intervalo permitido (control de carga, nunca evasion - Seccion 12).
  //    Se calcula ANTES de consumir cupos: si no cabe en el tiempo restante de
  //    esta ejecucion, el mensaje espera a la siguiente sin gastar limites.
  const waitMs = await rateLimiter.getRemainingDelayMs(randomDelayMs());
  if (deadline && Date.now() + waitMs + SEND_SAFETY_MS > deadline) {
    logger.info({ id: item.id, waitMs }, 'No alcanza el tiempo de esta ejecucion: se envia en la siguiente');
    return 'deferred';
  }

  // 5. Limites (minuto/hora/dia)
  const limitCheck = await rateLimiter.checkSendLimits();
  if (!limitCheck.allowed) {
    logger.warn({ id: item.id, reason: limitCheck.reason }, 'Limite de envio alcanzado, se reintentara mas tarde');
    await logModel.record({
      eventType: 'rate_limit_hit',
      level: 'WARN',
      message: `Limite alcanzado (${limitCheck.reason}) al intentar enviar el mensaje ${item.id}`,
    });
    return 'skipped';
  }

  // 6. Concurrencia
  const gotSlot = await rateLimiter.acquireConcurrencySlot();
  if (!gotSlot) {
    logger.info({ id: item.id }, 'Sin cupo de concurrencia disponible, se reintentara');
    return 'skipped';
  }

  let sent = false;
  const scheduledId = item.scheduled_message_id || null;

  try {
    // 7. Conexion de WhatsApp
    const connection = await evolutionService.checkConnection();
    if (connection.status !== 'CONNECTED') {
      logger.warn({ id: item.id, connection }, 'WhatsApp no esta conectado, mensaje queda pendiente');
      return 'skipped';
    }

    await queueModel.markProcessing(item.id);

    if (waitMs > 0) await sleep(waitMs);

    // La espera pudo durar varios segundos: se vuelve a comprobar la vigencia
    // justo antes de enviar para no responder con texto viejo.
    if (
      item.response_job_id
      && !(await queueModel.isQueueItemCurrent(item.id, item.response_job_id, item.response_generation))
    ) {
      await queueModel.markCancelled(item.id, 'Respuesta invalidada durante la espera');
      await logModel.record({
        eventType: 'queue_send_stale_cancelled',
        level: 'WARN',
        message: `Mensaje ${item.id} cancelado tras la espera: habia un mensaje mas reciente o atencion humana`,
        metadata: { responseJobId: item.response_job_id },
      });
      return 'failed';
    }

    // 8. Envio. Los chats @lid no tienen un telefono real: se usa el JID
    // completo guardado en el cliente; el resto sigue enviando por telefono.
    const customer = await customerModel.findById(item.customer_id);
    const recipient = (customer && customer.remote_jid) || item.phone;
    const result = await evolutionService.sendTextMessage(recipient, item.message);
    sent = true;

    // 9. Registrar resultado. Si falla el registro NO se devuelve el mensaje a
    // PENDING: ya salio a WhatsApp y reintentarlo duplicaria el envio.
    try {
      await queueModel.markSent(item.id);
      // El trabajo logico pasa a SENT. Es idempotente y solo afecta a la
      // fila QUEUED de este envio.
      if (item.response_job_id) await syncJob('markSentFromQueue', item.id);
      await rateLimiter.recordSend();

      const conversation = await conversationModel.findOrCreateOpenByCustomer(item.customer_id);
      await messageModel.create({
        conversationId: conversation.id,
        customerId: item.customer_id,
        direction: 'OUTBOUND',
        messageType: 'TEXT',
        content: item.message,
        externalMessageId: result.externalMessageId,
        status: 'SENT',
      });
      await conversationModel.touchLastMessage(conversation.id);
      if (scheduledId) await scheduledModel.markSent(scheduledId);

      await logModel.record({
        eventType: 'queue_send',
        level: 'INFO',
        message: `Mensaje ${item.id} enviado a ${item.phone}`,
      });
    } catch (bookErr) {
      logger.error(
        { err: bookErr.message, id: item.id },
        'Mensaje enviado, pero fallo el registro en la base de datos (no se reenviara)'
      );
      // Reintento best-effort de markSent: si el fallo fue transitorio evita
      // que el mensaje quede PROCESSING y se reenvie tras el requeue.
      try {
        await queueModel.markSent(item.id);
      } catch (markErr) {
        logger.error({ err: markErr.message, id: item.id }, 'No se pudo marcar como SENT tras el envio');
      }
      try {
        await logModel.record({
          eventType: 'queue_send_bookkeeping_error',
          level: 'ERROR',
          message: `Mensaje ${item.id} enviado, pero no se pudo registrar: ${bookErr.message}`,
        });
      } catch (logErr) {
        logger.error({ err: logErr.message }, 'Tampoco se pudo registrar el error de bookkeeping');
      }
    }
    return 'sent';
  } catch (err) {
    logger.error({ err: err.message, id: item.id }, 'Error enviando mensaje de la cola');

    // El mensaje alcanzo a salir antes de fallar: nunca se reintenta.
    if (sent) {
      try {
        await queueModel.markSent(item.id);
      } catch (markErr) {
        logger.error({ err: markErr.message, id: item.id }, 'No se pudo marcar como SENT');
      }
      if (item.response_job_id) await syncJob('markSentFromQueue', item.id);
      if (scheduledId) {
        try {
          await scheduledModel.markSent(scheduledId);
        } catch (markErr) {
          logger.error({ err: markErr.message }, 'No se pudo marcar el programado como SENT');
        }
      }
      return 'sent';
    }

    // Entrega incierta (timeout, 5xx o corte de red): no se sabe si WhatsApp
    // recibio el mensaje. Se registra y NO se reintenta automaticamente.
    const classification = classifySendError(err);
    if (classification.uncertain) {
      try {
        await queueModel.markUncertain(item.id, err.message);
      } catch (markErr) {
        logger.error({ err: markErr.message, id: item.id }, 'No se pudo marcar como UNCERTAIN');
      }
      if (item.response_job_id) await syncJob('markUncertainFromQueue', item.id, err.message);
      await logModel.record({
        eventType: 'queue_send_uncertain',
        level: 'ERROR',
        message: `Entrega incierta del mensaje ${item.id}: ${err.message}`,
        metadata: { reason: classification.reason, responseJobId: item.response_job_id || null },
      });
      await anomalyDetection.checkAfterFailure('queue_send_error');
      return 'failed';
    }

    let outcome = 'retry';
    if (item.attempts + 1 >= env.MAX_RETRIES) {
      await queueModel.markFailed(item.id, err.message);
      if (item.response_job_id) await syncJob('markFailedFromQueue', item.id, err.message);
      if (scheduledId) {
        try {
          await scheduledModel.markFailed(scheduledId, err.message);
        } catch (markErr) {
          logger.error({ err: markErr.message }, 'No se pudo marcar el programado como FAILED');
        }
      }
      outcome = 'failed';
    } else {
      await queueModel.incrementAttempt(item.id, err.message);
    }

    await logModel.record({
      eventType: 'queue_send_error',
      level: 'ERROR',
      message: `Error enviando mensaje ${item.id}: ${err.message}`,
      metadata: { attempts: item.attempts + 1 },
    });

    await anomalyDetection.checkAfterFailure('queue_send_error');
    return outcome;
  } finally {
    // Un fallo liberando el cupo no debe convertir un envio exitoso en error.
    try {
      await rateLimiter.releaseConcurrencySlot();
    } catch (releaseErr) {
      logger.error({ err: releaseErr.message, id: item.id }, 'No se pudo liberar el cupo de concurrencia');
    }
  }
}

// Una ejecucion del worker.
//  - Con `budgetMs` (modo nube): procesa mensajes mientras quede tiempo y termina.
//  - Sin `budgetMs` (modo local): una sola pasada por el lote actual.
// El candado en la base garantiza que dos ejecuciones no se pisen.
async function tick({ budgetMs = null } = {}) {
  const deadline = budgetMs ? Date.now() + budgetMs : null;
  const lockTtlSeconds = Math.ceil((budgetMs || 30000) / 1000) + 15;

  let locked = false;
  const summary = { locked: false, processed: 0, sent: 0, failed: 0, requeued: 0 };

  try {
    locked = await workerLock.acquire(LOCK_NAME, lockTtlSeconds);
    if (!locked) {
      summary.locked = true; // otra ejecucion sigue trabajando
      return summary;
    }

    summary.requeued = await queueModel.requeueStale(STALE_PROCESSING_MINUTES);
    await rateCounterModel.purgeExpired();

    let keepGoing = true;
    while (keepGoing && !stopping) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await queueModel.findNextBatch(env.MAX_CONCURRENT_SENDS || 5);
      if (batch.length === 0) break;

      let progressed = false;
      for (const item of batch) {
        if (stopping) break;
        // eslint-disable-next-line no-await-in-loop
        const outcome = await processOne(item, { deadline });
        summary.processed += 1;
        if (outcome === 'sent') {
          summary.sent += 1;
          progressed = true;
        }
        if (outcome === 'failed') {
          summary.failed += 1;
          progressed = true;
        }

        // 'retry' es un fallo de ESE mensaje: se sigue con el resto del lote
        // para que un numero invalido no bloquee a los mensajes siguientes.
        // 'skipped' / 'deferred' son condiciones globales: no insistir ahora
        // (aunque ya se haya enviado algo antes en este mismo lote).
        if (outcome === 'skipped' || outcome === 'deferred') {
          progressed = false;
          break;
        }
      }

      // Solo se vuelve a consultar la cola si hubo avance real.
      keepGoing = progressed;
      if (!deadline) keepGoing = false; // modo local: una pasada por ciclo
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Error en el ciclo del worker');
    summary.error = err.message;
  } finally {
    if (locked) {
      try {
        await workerLock.release(LOCK_NAME);
      } catch (err) {
        logger.error({ err: err.message }, 'No se pudo liberar el candado del worker');
      }
    }
  }
  return summary;
}

// Solo modo local (npm run worker).
async function loop() {
  logger.info('Worker de envio iniciado');
  while (!stopping) {
    // eslint-disable-next-line no-await-in-loop
    await tick();
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_INTERVAL_MS);
  }
  logger.info('Worker de envio detenido');
}

function shutdown() {
  stopping = true;
}

if (require.main === module) {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  loop();
}

module.exports = { processOne, tick, loop, shutdown, classifySendError };
