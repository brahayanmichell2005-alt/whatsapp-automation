// Servicio de control de respuestas automaticas:
//  - configuracion global y por cliente,
//  - programacion persistente de trabajos,
//  - pausa/reanudacion/detencion de emergencia,
//  - atencion humana,
//  - alertas para el panel.
//
// La generacion y el envio viven en responseProcessing.service.js y
// message.worker.js. Aqui no se envia nada directamente.

const env = require('../config/env');
const logger = require('../utils/logger');
const httpError = require('../utils/httpError');
const responseSettingsModel = require('../models/responseSettings.model');
const customerSettingModel = require('../models/customerResponseSetting.model');
const responseJobModel = require('../models/responseJob.model');
const queueModel = require('../models/messageQueue.model');
const conversationModel = require('../models/conversation.model');
const customerModel = require('../models/customer.model');
const settingsModel = require('../models/systemSetting.model');
const logModel = require('../models/automationLog.model');
const {
  validateGlobalResponseSettings,
  validateCustomerResponseSettings,
} = require('../validators/response.validator');

function mapGlobal(row) {
  return {
    enabled: Boolean(row.enabled),
    minDelaySeconds: row.min_delay_seconds,
    maxDelaySeconds: row.max_delay_seconds,
    groupingWindowSeconds: row.grouping_window_seconds,
    maxConcurrentResponses: row.max_concurrent_responses,
    status: row.status,
    alertThreshold: row.alert_threshold,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
}

// Los validadores trabajan en camelCase (API/panel) y los modelos en
// snake_case (columnas de PostgreSQL). Sin esta conversion los tiempos se
// validaban pero NO se guardaban.
const GLOBAL_COLUMNS = {
  enabled: 'enabled',
  minDelaySeconds: 'min_delay_seconds',
  maxDelaySeconds: 'max_delay_seconds',
  groupingWindowSeconds: 'grouping_window_seconds',
  maxConcurrentResponses: 'max_concurrent_responses',
  alertThreshold: 'alert_threshold',
};

const CUSTOMER_COLUMNS = {
  enabled: 'enabled',
  minDelaySeconds: 'min_delay_seconds',
  maxDelaySeconds: 'max_delay_seconds',
  randomVariation: 'random_variation',
  priority: 'priority',
  paused: 'paused',
};

function toColumns(values, mapping) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    const column = mapping[key] || key;
    out[column] = value;
  }
  return out;
}

function mapCustomer(row) {
  if (!row) return null;
  return {
    customerId: row.customer_id,
    enabled: Boolean(row.enabled),
    minDelaySeconds: row.min_delay_seconds,
    maxDelaySeconds: row.max_delay_seconds,
    randomVariation: Boolean(row.random_variation),
    priority: row.priority,
    paused: Boolean(row.paused),
    lastAutoReplyAt: row.last_auto_reply_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getGlobalConfig() {
  const row = await responseSettingsModel.ensureGlobal();
  return mapGlobal(row);
}

async function getEffectiveCustomerSettings(customerId) {
  const [globalRow, ownRow] = await Promise.all([
    getGlobalConfig(),
    customerSettingModel.findByCustomer(customerId),
  ]);
  const own = mapCustomer(ownRow);
  const effective = {
    enabled: own ? own.enabled : true,
    minDelaySeconds: own ? own.minDelaySeconds : globalRow.minDelaySeconds,
    maxDelaySeconds: own ? own.maxDelaySeconds : globalRow.maxDelaySeconds,
    randomVariation: own ? own.randomVariation : true,
    priority: own ? own.priority : 0,
    paused: own ? own.paused : false,
  };
  return { global: globalRow, own, configured: Boolean(own), effective };
}

// Ventana de agrupacion + espera configurada. Si randomVariation es false se
// usa el minimo: el resultado es predecible y editable desde el panel.
function computeDelaySeconds(settings, { random = Math.random } = {}) {
  const min = Math.max(0, Number(settings.minDelaySeconds) || 0);
  const max = Math.max(min, Number(settings.maxDelaySeconds) || min);
  const grouping = Math.max(0, Number(settings.groupingWindowSeconds) || 0);
  const randomVariation = settings.randomVariation !== false;
  const base = randomVariation
    ? min + Math.floor(random() * (max - min + 1))
    : min;
  return base + grouping;
}

async function syncSystemSettings(status) {
  const active = status === 'ACTIVE';
  await settingsModel.set('automation_status', active ? 'ACTIVE' : status === 'STOPPED' ? 'STOPPED' : 'PAUSED');
  await settingsModel.set('pause_queue', active ? 'false' : 'true');
}

async function recordConfigChange({
  scope,
  action,
  actor,
  customerId = null,
  conversationId = null,
  previous = null,
  next = null,
  reason = null,
}) {
  try {
    await responseSettingsModel.recordHistory({
      scope,
      action,
      actorId: actor?.id || null,
      customerId,
      conversationId,
      previous,
      next,
      reason,
    });
  } catch (err) {
    logger.error({ err: err.message, scope, action }, 'No se pudo guardar el historial de configuracion');
  }
}

async function updateGlobalSettings(values, actor = null) {
  const validation = validateGlobalResponseSettings(values, { partial: true });
  if (!validation.valid) throw httpError(400, validation.errors.join('. '));

  const previous = await getGlobalConfig();
  const fields = toColumns(validation.values, GLOBAL_COLUMNS);

  // Apagar el interruptor maestro pausa inmediatamente (no borra trabajos;
  // se conservan para reanudarlos de forma controlada).
  if (fields.enabled === false) fields.status = 'PAUSED';

  const updatedRow = await responseSettingsModel.updateGlobal(fields, {
    actorId: actor?.id || null,
  });
  const updated = mapGlobal(updatedRow);

  if (updated.enabled && updated.status === 'ACTIVE') {
    await syncSystemSettings('ACTIVE');
  } else {
    await syncSystemSettings(updated.status === 'STOPPED' ? 'STOPPED' : 'PAUSED');
    await responseJobModel.pauseOpen();
    await queueModel.pauseAllPending();
  }

  await recordConfigChange({
    scope: 'GLOBAL',
    action: 'UPDATE_SETTINGS',
    actor,
    previous,
    next: updated,
  });
  await logModel.record({
    eventType: 'response_settings_updated',
    level: 'INFO',
    message: 'Configuracion global de respuestas actualizada',
    metadata: { previous, next: updated, actor: actor?.email || null },
  });
  return updated;
}

async function applyGlobalStatus(status, actor = null, reason = null) {
  const normalized = String(status || '').toUpperCase();
  if (!['ACTIVE', 'PAUSED', 'STOPPED'].includes(normalized)) {
    throw httpError(400, 'status debe ser ACTIVE, PAUSED o STOPPED');
  }

  const previous = await getGlobalConfig();
  const fields = { status: normalized };
  if (normalized === 'ACTIVE') fields.enabled = true;
  const row = await responseSettingsModel.updateGlobal(fields, { actorId: actor?.id || null });
  const updated = mapGlobal(row);

  if (normalized === 'ACTIVE') {
    await syncSystemSettings('ACTIVE');
    // Al reanudar no se reviven trabajos demasiado viejos.
    await responseJobModel.cancelStalePaused(env.RESPONSE_MAX_AGE_SECONDS);
    await responseJobModel.resumePaused(1);
    await queueModel.resumeAllPaused();
  } else if (normalized === 'PAUSED') {
    await syncSystemSettings('PAUSED');
    await responseJobModel.pauseOpen();
    await queueModel.pauseAllPending();
  } else {
    await syncSystemSettings('STOPPED');
    await responseJobModel.cancelAllOpen(reason || 'Detencion de emergencia');
    await queueModel.cancelAllOpen();
  }

  await recordConfigChange({
    scope: 'GLOBAL',
    action: normalized === 'ACTIVE' ? 'RESUME' : normalized === 'PAUSED' ? 'PAUSE' : 'EMERGENCY_STOP',
    actor,
    previous,
    next: updated,
    reason,
  });
  await logModel.record({
    eventType: normalized === 'STOPPED' ? 'response_emergency_stop' : 'response_status_change',
    level: normalized === 'STOPPED' ? 'WARN' : 'INFO',
    message:
      normalized === 'ACTIVE'
        ? 'Cola de respuestas reanudada manualmente'
        : normalized === 'PAUSED'
          ? 'Cola de respuestas pausada manualmente'
          : 'Detencion de emergencia: respuestas automaticas canceladas',
    metadata: { actor: actor?.email || null, reason: reason || null },
  });
  return updated;
}

async function pauseGlobal(actor, reason) {
  return applyGlobalStatus('PAUSED', actor, reason);
}

async function resumeGlobal(actor) {
  return applyGlobalStatus('ACTIVE', actor);
}

async function stopGlobal(actor, reason) {
  return applyGlobalStatus('STOPPED', actor, reason);
}

async function activateGlobal(actor) {
  return applyGlobalStatus('ACTIVE', actor);
}

async function updateCustomerSettings(customerId, values, actor = null) {
  const customer = await customerModel.findById(customerId);
  if (!customer) throw httpError(404, 'Cliente no encontrado');

  const previous = await getEffectiveCustomerSettings(customerId);
  const merged = {
    enabled: values.enabled !== undefined ? values.enabled : previous.effective.enabled,
    minDelaySeconds:
      values.minDelaySeconds !== undefined
        ? values.minDelaySeconds
        : previous.effective.minDelaySeconds,
    maxDelaySeconds:
      values.maxDelaySeconds !== undefined
        ? values.maxDelaySeconds
        : previous.effective.maxDelaySeconds,
    randomVariation:
      values.randomVariation !== undefined
        ? values.randomVariation
        : previous.effective.randomVariation,
    priority: values.priority !== undefined ? values.priority : previous.effective.priority,
    paused: values.paused !== undefined ? values.paused : previous.effective.paused,
  };

  const validation = validateCustomerResponseSettings(merged);
  if (!validation.valid) throw httpError(400, validation.errors.join('. '));

  const row = await customerSettingModel.upsert(
    customerId,
    toColumns(validation.values, CUSTOMER_COLUMNS),
    { actorId: actor?.id || null }
  );

  let cancelled = { jobs: 0, sends: 0 };
  if (!validation.values.enabled || validation.values.paused) {
    cancelled.jobs = await responseJobModel.cancelOpenByCustomer(
      customerId,
      !validation.values.enabled ? 'Automatizacion desactivada para el cliente' : 'Automatizacion pausada para el cliente'
    );
    const openConversation = await conversationModel.findOpenByCustomer(customerId);
    if (openConversation) {
      cancelled.sends = await queueModel.cancelPendingByConversation(openConversation.id);
    }
  }

  const next = await getEffectiveCustomerSettings(customerId);
  await recordConfigChange({
    scope: 'CUSTOMER',
    action: 'UPDATE_SETTINGS',
    actor,
    customerId,
    previous: previous.effective,
    next: next.effective,
  });
  await logModel.record({
    eventType: 'customer_response_settings_updated',
    level: 'INFO',
    message: `Tiempo de respuesta actualizado para ${customer.phone}`,
    metadata: { customerId, previous: previous.effective, next: next.effective, cancelled },
  });
  return { ...next, customer, cancelled };
}

async function setCustomerAutomation(customerId, { enabled, paused }, actor = null, reason = null) {
  const values = {};
  if (enabled !== undefined) values.enabled = enabled;
  if (paused !== undefined) values.paused = paused;
  if (Object.keys(values).length === 0) throw httpError(400, 'Indica enabled o paused');
  const result = await updateCustomerSettings(customerId, values, actor);
  await recordConfigChange({
    scope: 'CUSTOMER',
    action: paused === true ? 'PAUSE_CUSTOMER' : enabled === false ? 'DISABLE_CUSTOMER' : 'RESUME_CUSTOMER',
    actor,
    customerId,
    next: result.effective,
    reason,
  });
  return result;
}

async function resetCustomerSettings(customerId, actor = null) {
  const customer = await customerModel.findById(customerId);
  if (!customer) throw httpError(404, 'Cliente no encontrado');
  const previous = await getEffectiveCustomerSettings(customerId);
  const removed = await customerSettingModel.remove(customerId);
  const next = await getEffectiveCustomerSettings(customerId);
  await recordConfigChange({
    scope: 'CUSTOMER',
    action: 'RESET_TO_DEFAULTS',
    actor,
    customerId,
    previous: previous.effective,
    next: next.effective,
  });
  await logModel.record({
    eventType: 'customer_response_settings_reset',
    level: 'INFO',
    message: `Configuracion de respuesta restablecida a valores globales para ${customer.phone}`,
    metadata: { customerId, removed },
  });
  return { ...next, customer, removed };
}

async function takeOverConversation({ conversationId, actor = null, reason = null }) {
  const conversation = await conversationModel.findById(conversationId);
  if (!conversation) throw httpError(404, 'Conversacion no encontrada');

  const updated = await conversationModel.takeOver(conversationId, {
    userId: actor?.id || null,
    reason: reason || 'Atencion humana desde el panel',
  });
  const cancelledJobs = await responseJobModel.cancelOpenByConversation(
    conversationId,
    'Intervencion humana: respuesta automatica invalidada'
  );
  const cancelledSends = await queueModel.cancelPendingByConversation(conversationId);

  await recordConfigChange({
    scope: 'CONVERSATION',
    action: 'HUMAN_TAKEOVER',
    actor,
    conversationId,
    customerId: conversation.customer_id,
    previous: { status: conversation.status, bot_enabled: conversation.bot_enabled },
    next: { status: 'HUMAN', bot_enabled: false, cancelledJobs, cancelledSends },
    reason,
  });
  await logModel.record({
    eventType: 'human_takeover',
    level: 'INFO',
    message: `Atencion humana activada en la conversacion ${conversationId}`,
    metadata: {
      conversationId,
      customerId: conversation.customer_id,
      actor: actor?.email || null,
      reason: reason || null,
      cancelledJobs,
      cancelledSends,
    },
  });
  return { conversation: updated, cancelledJobs, cancelledSends };
}

async function releaseConversation({ conversationId, actor = null }) {
  const conversation = await conversationModel.findById(conversationId);
  if (!conversation) throw httpError(404, 'Conversacion no encontrada');
  const updated = await conversationModel.releaseBot(conversationId);
  await recordConfigChange({
    scope: 'CONVERSATION',
    action: 'BOT_RELEASED',
    actor,
    conversationId,
    customerId: conversation.customer_id,
    previous: { status: conversation.status, bot_enabled: conversation.bot_enabled },
    next: { status: 'OPEN', bot_enabled: true },
  });
  await logModel.record({
    eventType: 'bot_released',
    level: 'INFO',
    message: `Bot reactivado manualmente en la conversacion ${conversationId}`,
    metadata: { conversationId, actor: actor?.email || null },
  });
  return updated;
}

async function scheduleResponse({ customer, conversation, message }) {
  const global = await getGlobalConfig();
  if (!global.enabled || global.status !== 'ACTIVE') {
    return { scheduled: false, reason: `global_${global.status.toLowerCase()}` };
  }

  if (!conversation || conversation.bot_enabled === false || conversation.status === 'HUMAN') {
    return { scheduled: false, reason: 'human_takeover' };
  }
  if (conversation.status === 'CLOSED') {
    return { scheduled: false, reason: 'conversation_closed' };
  }
  if (customer.status && customer.status !== 'ACTIVE') {
    return { scheduled: false, reason: `customer_${String(customer.status).toLowerCase()}` };
  }

  const { effective } = await getEffectiveCustomerSettings(customer.id);
  if (!effective.enabled) return { scheduled: false, reason: 'customer_disabled' };
  if (effective.paused) return { scheduled: false, reason: 'customer_paused' };

  const delaySeconds = computeDelaySeconds({
    ...effective,
    groupingWindowSeconds: global.groupingWindowSeconds,
  });
  const dueAt = new Date(Date.now() + delaySeconds * 1000);
  const idempotencyKey = `resp:conv:${conversation.id}:msg:${message.id}`;

  const job = await responseJobModel.schedule({
    customerId: customer.id,
    conversationId: conversation.id,
    latestInboundMessageId: message.id,
    idempotencyKey,
    priority: effective.priority,
    dueAt,
    maxAttempts: Math.max(1, env.RESPONSE_MAX_ATTEMPTS),
  });

  await logModel.record({
    eventType: 'auto_reply_scheduled',
    level: 'INFO',
    message: `Respuesta automatica programada para ${customer.phone} en ${delaySeconds}s`,
    metadata: {
      customerId: customer.id,
      conversationId: conversation.id,
      messageId: message.id,
      jobId: job?.id || null,
      delaySeconds,
      minDelaySeconds: effective.minDelaySeconds,
      maxDelaySeconds: effective.maxDelaySeconds,
      groupingWindowSeconds: global.groupingWindowSeconds,
      priority: effective.priority,
      dueAt: dueAt.toISOString(),
    },
  });

  return { scheduled: true, job, dueAt, delaySeconds, effective };
}

async function getCustomerState(customerId) {
  const customer = await customerModel.findById(customerId);
  if (!customer) return null;
  const settings = await getEffectiveCustomerSettings(customerId);
  const conversation = await conversationModel.findOpenByCustomer(customerId);
  const openJob = conversation ? await responseJobModel.findOpenByConversation(conversation.id) : null;
  const lastAutoReplyAt =
    (settings.own && settings.own.lastAutoReplyAt) || customer.last_message_at || null;
  return {
    customer,
    ...settings,
    conversation: conversation
      ? {
          id: conversation.id,
          status: conversation.status,
          botEnabled: conversation.bot_enabled !== false,
          humanTakenOverAt: conversation.human_taken_over_at || null,
          humanTakenOverBy: conversation.human_taken_over_by || null,
          humanTakeoverReason: conversation.human_takeover_reason || null,
        }
      : null,
    openJob,
    lastAutoReplyAt,
  };
}

function buildAlerts({ settings, stats, connection }) {
  const alerts = [];
  if (connection && connection.status && connection.status !== 'CONNECTED') {
    alerts.push({
      level: 'error',
      code: 'WHATSAPP_NOT_CONNECTED',
      message: `WhatsApp no esta conectado (${connection.status}); los envios quedan pendientes.`,
    });
  }
  if (settings && !settings.enabled) {
    alerts.push({
      level: 'warn',
      code: 'GLOBAL_DISABLED',
      message: 'Las respuestas automaticas estan desactivadas globalmente.',
    });
  } else if (settings && settings.status === 'PAUSED') {
    alerts.push({
      level: 'warn',
      code: 'GLOBAL_PAUSED',
      message: 'La cola de respuestas esta pausada; los trabajos no se procesan.',
    });
  } else if (settings && settings.status === 'STOPPED') {
    alerts.push({
      level: 'error',
      code: 'GLOBAL_STOPPED',
      message: 'Detencion de emergencia activa: no se envian respuestas automaticas.',
    });
  }
  if (stats && settings && stats.failed_today >= settings.alertThreshold) {
    alerts.push({
      level: 'error',
      code: 'REPEATED_ERRORS',
      message: `${stats.failed_today} respuestas fallaron hoy (umbral: ${settings.alertThreshold}).`,
    });
  }
  if (stats && stats.uncertain_today > 0) {
    alerts.push({
      level: 'warn',
      code: 'UNCERTAIN_DELIVERIES',
      message: `${stats.uncertain_today} envio(s) quedaron en estado incierto; revisa antes de reenviar.`,
    });
  }
  if (stats && stats.pending + stats.paused >= 50) {
    alerts.push({
      level: 'warn',
      code: 'QUEUE_BACKLOG',
      message: `Hay ${stats.pending + stats.paused} respuestas esperando en la cola.`,
    });
  }
  return alerts;
}

async function getStatus({ connection = null } = {}) {
  const [settings, stats] = await Promise.all([getGlobalConfig(), responseJobModel.stats()]);
  return {
    settings,
    stats,
    alerts: buildAlerts({ settings, stats, connection }),
    limits: {
      minDelaySeconds: { min: 0, max: 600 },
      maxDelaySeconds: { min: 0, max: 900 },
      groupingWindowSeconds: { min: 0, max: 120 },
      maxConcurrentResponses: { min: 1, max: 10 },
    },
  };
}

async function retryJob(jobId, actor = null) {
  const job = await responseJobModel.retryFailed(jobId);
  if (!job) {
    throw httpError(409, 'El trabajo no existe, no fallo de forma confirmada o ya hay otro trabajo abierto en esa conversacion');
  }
  await logModel.record({
    eventType: 'response_job_retry',
    level: 'INFO',
    message: `Trabajo de respuesta ${jobId} reencolado manualmente`,
    metadata: { jobId, actor: actor?.email || null },
  });
  return job;
}

module.exports = {
  getGlobalConfig,
  getEffectiveCustomerSettings,
  computeDelaySeconds,
  updateGlobalSettings,
  applyGlobalStatus,
  pauseGlobal,
  resumeGlobal,
  stopGlobal,
  activateGlobal,
  updateCustomerSettings,
  setCustomerAutomation,
  resetCustomerSettings,
  takeOverConversation,
  releaseConversation,
  scheduleResponse,
  getCustomerState,
  getStatus,
  buildAlerts,
  retryJob,
};
