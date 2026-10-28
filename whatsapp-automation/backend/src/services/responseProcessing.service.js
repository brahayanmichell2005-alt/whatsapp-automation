// Procesador persistente de la cola de respuestas.
//
// - Toma trabajos vencidos de PostgreSQL (nunca temporizadores en memoria).
// - Reclama cada trabajo con un UPDATE atomico y respeta la concurrencia
//   global configurada.
// - Genera la respuesta con el historial completo y la encola para envio.
// - Antes de encolar comprueba que no haya llegado un mensaje nuevo ni una
//   intervencion humana; si cambio algo, no envia texto viejo.
// - Tras un reinicio, requeueStale() devuelve a PENDING los PROCESSING.

const env = require('../config/env');
const logger = require('../utils/logger');
const workerLock = require('../models/workerLock.model');
const responseJobModel = require('../models/responseJob.model');
const queueModel = require('../models/messageQueue.model');
const conversationModel = require('../models/conversation.model');
const customerModel = require('../models/customer.model');
const prefsModel = require('../models/communicationPreference.model');
const logModel = require('../models/automationLog.model');
const anomalyDetection = require('../services/anomalyDetection.service');
const responseControl = require('./responseControl.service');
const responseReply = require('./responseReply.service');

const LOCK_NAME = 'response_worker_tick';
const STALE_PROCESSING_MINUTES = 5;
const POLL_INTERVAL_MS = 5000;
let stopping = false;
let intervalHandle = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isConversationBotEnabled(conversation) {
  if (!conversation) return false;
  if (conversation.bot_enabled === false) return false;
  if (conversation.status === 'HUMAN' || conversation.status === 'CLOSED') return false;
  return true;
}

async function cancelFor(job, reason) {
  const cancelled = await responseJobModel.markCancelledGeneration(job.id, job.generation, reason);
  if (!cancelled) {
    // La fila ya pertenece a una generacion mas nueva: no se toca.
    return { outcome: 'stale', jobId: job.id, reason };
  }
  return { outcome: 'cancelled', reason, jobId: job.id };
}

async function processJob(job) {
  const latest = await responseJobModel.findById(job.id);
  if (!latest || latest.status !== 'PROCESSING' || latest.generation !== job.generation) {
    return { outcome: 'stale', jobId: job.id };
  }

  try {
    const global = await responseControl.getGlobalConfig();
    if (!global.enabled || global.status !== 'ACTIVE') {
      await responseJobModel.releaseClaim(job.id, job.generation, 'Procesamiento pausado');
      return { outcome: 'paused', jobId: job.id };
    }

    const conversation = await conversationModel.findById(job.conversation_id);
    if (!(await isConversationBotEnabled(conversation))) {
      return cancelFor(job, 'Conversacion en atencion humana o cerrada');
    }

    const customer = await customerModel.findById(job.customer_id);
    if (!customer || (customer.status && customer.status !== 'ACTIVE')) {
      return cancelFor(job, 'Cliente bloqueado, archivado o inexistente');
    }

    const prefs = await prefsModel.findByCustomer(customer.id);
    if (prefs?.opted_out) {
      return cancelFor(job, 'Cliente en opt-out');
    }

    const customerSettings = await responseControl.getEffectiveCustomerSettings(customer.id);
    if (!customerSettings.effective.enabled) {
      return cancelFor(job, 'Automatizacion desactivada para el cliente');
    }
    if (customerSettings.effective.paused) {
      return cancelFor(job, 'Automatizacion pausada para el cliente');
    }

    if (!(await responseJobModel.stillCurrent(job.id, job.generation))) {
      return { outcome: 'stale', jobId: job.id };
    }

    const reply = await responseReply.buildReply({
      customer,
      conversation,
      expectedInboundId: job.latest_inbound_message_id,
    });
    if (reply.cancelled) {
      return cancelFor(job, reply.reason || 'Respuesta ya no relevante');
    }

    // Mensaje nuevo o intervencion humana durante la generacion: no enviar.
    if (!(await responseJobModel.stillCurrent(job.id, job.generation))) {
      return { outcome: 'stale', jobId: job.id };
    }
    const conversationNow = await conversationModel.findById(job.conversation_id);
    if (!(await isConversationBotEnabled(conversationNow))) {
      return cancelFor(job, 'Conversacion cambio a atencion humana durante la generacion');
    }

    const idempotencyKey = `respjob:${job.id}:gen:${job.generation}`;
    const queueItem = await queueModel.enqueue({
      customerId: customer.id,
      phone: customer.phone,
      message: reply.text,
      idempotencyKey,
      responseJobId: job.id,
      responseGeneration: job.generation,
    });
    if (!queueItem) throw new Error('No se pudo crear el mensaje en la cola de envio');

    const queued = await responseJobModel.markQueued(
      job.id,
      job.generation,
      queueItem.id,
      reply.text
    );
    if (!queued) {
      // Un mensaje nuevo gano la carrera: el worker descartara la cola vieja.
      return { outcome: 'stale', jobId: job.id, queueId: queueItem.id };
    }

    await logModel.record({
      eventType: 'response_generated',
      level: 'INFO',
      message: `Respuesta generada para ${customer.phone} y encolada para envio`,
      metadata: {
        jobId: job.id,
        conversationId: conversation.id,
        queueId: queueItem.id,
        source: reply.source,
        classification: reply.classification || null,
        generation: job.generation,
      },
    });

    // Envio inmediato cuando el runtime lo permite (en Vercel el cron
    // tambien recoge lo que quede pendiente).
    try {
      const messageWorker = require('../workers/message.worker');
      await messageWorker.tick({ budgetMs: Math.min(20000, env.RESPONSE_BUDGET_MS) });
    } catch (err) {
      logger.error({ err: err.message, jobId: job.id }, 'No se pudo disparar el worker de envio');
    }

    // La memoria se actualiza despues del envio; si falla no afecta al mensaje.
    await responseReply.maybeSummarizeMemory({
      customer,
      conversation,
      history: reply.history,
    });

    return { outcome: 'queued', jobId: job.id, queueId: queueItem.id };
  } catch (err) {
    logger.error({ err: err.message, jobId: job.id }, 'Error generando respuesta automatica');
    const updated = await responseJobModel.incrementFailure(
      job.id,
      err.message,
      job.max_attempts || env.RESPONSE_MAX_ATTEMPTS,
      10
    );
    await logModel.record({
      eventType: 'response_generation_error',
      level: 'ERROR',
      message: `Error generando respuesta para el trabajo ${job.id}: ${err.message}`,
      metadata: { jobId: job.id, attempts: updated?.attempts || job.attempts },
    });
    const anomaly = await anomalyDetection.checkAfterFailure('response_generation_error');
    if (anomaly) {
      try {
        await responseControl.pauseGlobal(null, 'Pausa automatica por errores repetidos');
      } catch (pauseErr) {
        logger.error({ err: pauseErr.message }, 'No se pudo sincronizar la pausa automatica de respuestas');
      }
    }
    return {
      outcome: updated && updated.status === 'FAILED' ? 'failed' : 'retry',
      jobId: job.id,
      error: err.message,
    };
  }
}

async function tick({ budgetMs = null, waitMs = 0 } = {}) {
  const budget = budgetMs === null ? env.RESPONSE_BUDGET_MS : Math.max(0, budgetMs);
  const wait = Math.max(0, waitMs || 0);
  const startedAt = Date.now();
  const deadline = startedAt + budget;
  const waitDeadline = startedAt + Math.min(wait, budget);
  const lockTtlSeconds = Math.ceil((budget + wait) / 1000) + 20;
  const summary = {
    locked: false,
    paused: false,
    processed: 0,
    queued: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
    stale: 0,
    requeued: 0,
    tookMs: 0,
  };

  let locked = false;
  try {
    locked = await workerLock.acquire(LOCK_NAME, lockTtlSeconds);
    if (!locked) {
      summary.locked = true;
      summary.tookMs = Date.now() - startedAt;
      return summary;
    }

    summary.requeued = await responseJobModel.requeueStale(STALE_PROCESSING_MINUTES);

    while (!stopping && Date.now() < deadline) {
      const global = await responseControl.getGlobalConfig();
      if (!global.enabled || global.status !== 'ACTIVE') {
        summary.paused = true;
        break;
      }

      const due = await responseJobModel.findDue(global.maxConcurrentResponses);
      if (due.length === 0) {
        if (Date.now() >= waitDeadline) break;
        const earliest = await responseJobModel.findEarliestDue();
        if (!earliest) break;
        const untilDue = new Date(earliest.due_at).getTime() - Date.now();
        if (untilDue > waitDeadline - Date.now() || Date.now() + untilDue + 3000 > deadline) break;
        if (untilDue <= 0) continue;
        await sleep(Math.min(untilDue, 1000));
        continue;
      }

      const claimed = [];
      for (const item of due) {
        // Reclamo atomico por fila: aunque otra ejecucion intente lo mismo,
        // solo una obtiene el trabajo.
        const job = await responseJobModel.claim(item.id, lockTtlSeconds);
        if (job) claimed.push(job);
      }
      if (claimed.length === 0) break;

      const outcomes = await Promise.all(claimed.map((job) => processJob(job)));
      for (const result of outcomes) {
        summary.processed += 1;
        if (result.outcome === 'queued') summary.queued += 1;
        else if (result.outcome === 'failed') summary.failed += 1;
        else if (result.outcome === 'retry') summary.retried += 1;
        else if (result.outcome === 'cancelled') summary.cancelled += 1;
        else if (result.outcome === 'stale') summary.stale += 1;
      }

      // Envia lo que haya quedado en message_queue (incluye respuestas
      // generadas por otros procesos y mensajes manuales/programados).
      try {
        const messageWorker = require('../workers/message.worker');
        await messageWorker.tick({ budgetMs: Math.min(15000, Math.max(0, deadline - Date.now())) });
      } catch (err) {
        logger.error({ err: err.message }, 'No se pudo ejecutar el worker de envio al procesar respuestas');
      }

      if (summary.processed === 0) break;
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Error en el ciclo de respuestas automaticas');
    summary.error = err.message;
  } finally {
    if (locked) {
      try {
        await workerLock.release(LOCK_NAME);
      } catch (err) {
        logger.error({ err: err.message }, 'No se pudo liberar el candado de respuestas');
      }
    }
  }

  summary.tookMs = Date.now() - startedAt;
  return summary;
}

function start() {
  if (intervalHandle) return;
  logger.info(`Procesador de respuestas iniciado (cada ${POLL_INTERVAL_MS}ms)`);
  intervalHandle = setInterval(() => {
    tick({ budgetMs: 15000 }).catch((err) => logger.error({ err: err.message }, 'Fallo el procesador de respuestas'));
  }, POLL_INTERVAL_MS);
}

function stop() {
  stopping = true;
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

if (require.main === module) {
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  start();
}

module.exports = { tick, processJob, start, stop };
