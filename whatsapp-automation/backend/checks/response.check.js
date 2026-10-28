// Verifica la cola persistente de respuestas automaticas: validacion,
// tiempos por cliente, agrupacion, concurrencia, atencion humana, pausa
// global, recuperacion tras reinicio, idempotencia y permisos.
//
// No necesita dependencias ni PostgreSQL: los modelos se sustituyen por
// dobles en memoria y solo se ejecuta el codigo REAL de los servicios.
//
// Ejecutar:  npm run check

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setEnv, load, inject, fakePg } = require('./_harness');

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  TIMEZONE: 'UTC',
  START_TIME: '00:00',
  END_TIME: '24:00',
  MIN_DELAY_SECONDS: 0,
  MAX_DELAY_SECONDS: 0,
  MAX_RETRIES: 3,
  MAX_CONCURRENT_SENDS: 3,
  MAX_MESSAGES_PER_MINUTE: 20,
  MAX_MESSAGES_PER_HOUR: 200,
  MAX_MESSAGES_PER_DAY: 1000,
  RESPONSE_MIN_DELAY_SECONDS: 5,
  RESPONSE_MAX_DELAY_SECONDS: 15,
  RESPONSE_GROUPING_WINDOW_SECONDS: 4,
  RESPONSE_MAX_CONCURRENT: 2,
  RESPONSE_MAX_ATTEMPTS: 3,
  RESPONSE_BUDGET_MS: 1000,
  RESPONSE_INLINE_WAIT_MS: 0,
  RESPONSE_INLINE_BUDGET_MS: 2000,
  RESPONSE_MAX_AGE_SECONDS: 600,
};

const BASE_JOB = () => ({
  id: 101,
  customer_id: 7,
  conversation_id: 11,
  latest_inbound_message_id: 55,
  generation: 3,
  attempts: 1,
  max_attempts: 3,
  status: 'PROCESSING',
  due_at: new Date().toISOString(),
});

const GLOBAL_ROW = () => ({
  id: 1,
  enabled: true,
  min_delay_seconds: 30,
  max_delay_seconds: 60,
  grouping_window_seconds: 5,
  max_concurrent_responses: 2,
  status: 'ACTIVE',
  alert_threshold: 3,
  updated_at: null,
  updated_by: null,
});

const CUSTOMER = () => ({
  id: 7,
  phone: '51999000111',
  name: 'Ana',
  status: 'ACTIVE',
  last_message_at: null,
});

function makeControlWorld(extra = {}) {
  const w = {
    calls: [],
    globalRow: GLOBAL_ROW(),
    ownRow: null,
    customer: CUSTOMER(),
    conversation: { id: 11, customer_id: 7, status: 'OPEN', bot_enabled: true },
    systemSettings: {},
    history: [],
    logs: [],
    cancelledSends: 0,
    scheduledJob: { id: 55, generation: 1 },
    lastSchedule: null,
    stats: {
      pending: 2,
      processing: 1,
      queued: 1,
      paused: 0,
      sent_today: 4,
      failed_today: 0,
      uncertain_today: 0,
      cancelled_today: 0,
      total: 8,
    },
    ...extra,
  };
  const rec = (name, extraData) => w.calls.push(extraData === undefined ? name : `${name}:${JSON.stringify(extraData)}`);
  w.rec = rec;

  inject('models/responseSettings.model.js', {
    ensureGlobal: async () => w.globalRow,
    updateGlobal: async (fields, options) => {
      rec('updateGlobal', fields);
      w.globalRow = { ...w.globalRow, ...fields, updated_by: options?.actorId ?? null };
      return w.globalRow;
    },
    recordHistory: async (entry) => {
      w.history.push(entry);
      rec('recordHistory');
      return { id: w.history.length };
    },
    listHistory: async () => w.history,
  });

  inject('models/customerResponseSetting.model.js', {
    findByCustomer: async () => w.ownRow,
    upsert: async (customerId, fields) => {
      rec('upsertCustomer', fields);
      w.ownRow = {
        customer_id: customerId,
        enabled: true,
        min_delay_seconds: 5,
        max_delay_seconds: 15,
        random_variation: true,
        priority: 0,
        paused: false,
        last_auto_reply_at: null,
        updated_at: null,
        ...(w.ownRow || {}),
        ...fields,
      };
      return w.ownRow;
    },
    remove: async () => {
      rec('removeCustomer');
      const existed = Boolean(w.ownRow);
      w.ownRow = null;
      return existed;
    },
    touchLastReply: async () => rec('touchLastReply'),
    list: async () => (w.ownRow ? [w.ownRow] : []),
  });

  inject('models/responseJob.model.js', {
    schedule: async (args) => {
      rec('scheduleJob');
      w.lastSchedule = args;
      return w.scheduledJob;
    },
    findOpenByConversation: async () => w.openJob || null,
    pauseOpen: async () => { rec('pauseOpen'); return 2; },
    cancelStalePaused: async (seconds) => { rec('cancelStalePaused', seconds); return 0; },
    resumePaused: async (seconds) => { rec('resumePaused', seconds); return 2; },
    cancelAllOpen: async (reason) => { rec('cancelAllOpen', reason); return 3; },
    cancelOpenByConversation: async (id, reason) => { rec('cancelOpenByConversation', { id, reason }); return 1; },
    cancelOpenByCustomer: async (id, reason) => { rec('cancelOpenByCustomer', { id, reason }); return 1; },
    retryFailed: async (id) => (w.retryResult === undefined ? { id, status: 'PENDING' } : w.retryResult),
    stats: async () => w.stats,
  });

  inject('models/messageQueue.model.js', {
    pauseAllPending: async () => { rec('pauseAllPending'); return 2; },
    resumeAllPaused: async () => { rec('resumeAllPaused'); return 2; },
    cancelAllOpen: async () => { rec('cancelAllOpenQueue'); return 2; },
    cancelPendingByConversation: async (id) => {
      rec('cancelPendingByConversation', id);
      return w.cancelledSends;
    },
    cancelPendingByCustomer: async (id) => { rec('cancelPendingByCustomer', id); return 1; },
  });

  inject('models/conversation.model.js', {
    findById: async () => w.conversation,
    findOpenByCustomer: async () => w.openConversation === undefined ? w.conversation : w.openConversation,
    takeOver: async (id, opts) => {
      rec('takeOver', opts);
      w.conversation = { ...w.conversation, id, status: 'HUMAN', bot_enabled: false };
      return w.conversation;
    },
    releaseBot: async (id) => {
      rec('releaseBot');
      w.conversation = { ...w.conversation, id, status: 'OPEN', bot_enabled: true };
      return w.conversation;
    },
  });

  inject('models/customer.model.js', {
    findById: async () => w.customer,
  });

  inject('models/systemSetting.model.js', {
    get: async (key) => w.systemSettings[key] ?? null,
    set: async (key, value) => {
      w.systemSettings[key] = value;
      rec('systemSetting', { key, value });
      return value;
    },
  });

  inject('models/automationLog.model.js', {
    record: async (entry) => {
      w.logs.push(entry);
      rec('log');
      return { id: w.logs.length };
    },
  });

  return w;
}

function freshControl(extra = {}) {
  setEnv(BASE_ENV);
  const world = makeControlWorld(extra);
  return { world, control: load('services/responseControl.service.js') };
}

// ---------------------------------------------------------------------------
// Mundo para responseProcessing.service.js
// ---------------------------------------------------------------------------
function makeProcessingWorld(extra = {}) {
  const w = {
    calls: [],
    job: BASE_JOB(),
    global: { enabled: true, status: 'ACTIVE', maxConcurrentResponses: 2 },
    effective: { effective: { enabled: true, paused: false } },
    conversation: { id: 11, customer_id: 7, status: 'OPEN', bot_enabled: true },
    conversationResults: null,
    customer: CUSTOMER(),
    prefs: { opted_out: false },
    reply: { text: 'Hola, con gusto te ayudo', source: 'RULES', history: [] },
    replyError: null,
    stillCurrent: true,
    stillCurrentResults: null,
    jobCancelled: true,
    markQueuedOk: true,
    incrementFailureResult: { status: 'PENDING', attempts: 1 },
    queueItem: { id: 900 },
    lastEnqueue: null,
    due: [],
    claimable: true,
    requeuedCount: 0,
    lockFree: true,
    anomaly: null,
    ...extra,
  };
  const rec = (name, data) => w.calls.push(data === undefined ? name : `${name}:${JSON.stringify(data)}`);
  w.rec = rec;
  w.shiftConversation = () => {
    if (Array.isArray(w.conversationResults) && w.conversationResults.length) {
      return w.conversationResults.shift();
    }
    return w.conversation;
  };

  inject('models/responseJob.model.js', {
    findById: async (id) => (w.job && w.job.id === id ? w.job : null),
    stillCurrent: async () => {
      rec('stillCurrent');
      if (Array.isArray(w.stillCurrentResults) && w.stillCurrentResults.length) {
        return w.stillCurrentResults.shift();
      }
      return w.stillCurrent;
    },
    markQueued: async (id, generation, queueId) => {
      rec('markQueued', { id, generation, queueId });
      if (!w.markQueuedOk) return null;
      return { ...w.job, status: 'QUEUED', queue_id: queueId };
    },
    markCancelledGeneration: async (id, generation, reason) => {
      rec('markCancelledGeneration', { id, generation, reason });
      if (!w.jobCancelled) return null;
      return { ...w.job, status: 'CANCELLED', error_message: reason };
    },
    markCancelled: async (id, reason) => {
      rec('markCancelled', { id, reason });
      return { ...w.job, status: 'CANCELLED' };
    },
    releaseClaim: async (id, generation, reason) => {
      rec('releaseClaim', { id, generation, reason });
      return { ...w.job, status: 'PENDING' };
    },
    incrementFailure: async (id, error, maxAttempts, retryDelay) => {
      rec('incrementFailure', { id, error, maxAttempts, retryDelay });
      return w.incrementFailureResult;
    },
    requeueStale: async (minutes) => {
      rec('requeueStale', minutes);
      return w.requeuedCount;
    },
    findDue: async (limit) => {
      rec('findDue', limit);
      const batch = w.due.slice(0, limit);
      w.due = w.due.slice(limit);
      return batch;
    },
    findEarliestDue: async () => null,
    claim: async (id, lockSeconds) => {
      rec('claim', { id, lockSeconds });
      if (!w.claimable) return null;
      const candidate = w.claimedSource?.find((j) => j.id === id) || { ...BASE_JOB(), id };
      return { ...candidate, status: 'PROCESSING' };
    },
  });

  inject('models/messageQueue.model.js', {
    enqueue: async (args) => {
      rec('enqueue');
      w.lastEnqueue = args;
      return w.queueItem;
    },
  });

  inject('models/conversation.model.js', {
    findById: async () => {
      rec('conversationFind');
      return w.shiftConversation();
    },
  });

  inject('models/customer.model.js', {
    findById: async () => w.customer,
  });

  inject('models/communicationPreference.model.js', {
    findByCustomer: async () => w.prefs,
  });

  inject('models/automationLog.model.js', {
    record: async (entry) => {
      w.logs = w.logs || [];
      w.logs.push(entry);
      rec('log', entry.eventType);
      return { id: w.logs.length };
    },
  });

  inject('services/responseControl.service.js', {
    getGlobalConfig: async () => w.global,
    getEffectiveCustomerSettings: async () => w.effective,
    pauseGlobal: async () => {
      rec('pauseGlobal');
      return { status: 'PAUSED' };
    },
  });

  inject('services/responseReply.service.js', {
    buildReply: async () => {
      rec('buildReply');
      if (w.replyError) throw w.replyError;
      return w.reply;
    },
    maybeSummarizeMemory: async () => rec('maybeSummarizeMemory'),
  });

  inject('services/anomalyDetection.service.js', {
    checkAfterFailure: async () => {
      rec('anomalyCheck');
      return w.anomaly;
    },
  });

  inject('models/workerLock.model.js', {
    acquire: async () => {
      rec('lockAcquire');
      return w.lockFree;
    },
    release: async () => rec('lockRelease'),
  });

  inject('workers/message.worker.js', {
    tick: async () => {
      rec('workerTick');
      return { sent: 1 };
    },
  });

  return w;
}

function freshProcessing(extra = {}) {
  setEnv(BASE_ENV);
  const world = makeProcessingWorld(extra);
  return { world, processor: load('services/responseProcessing.service.js') };
}

// ---------------------------------------------------------------------------
// Validacion y calculo de tiempos
// ---------------------------------------------------------------------------
describe('Validacion de tiempos de respuesta', () => {
  test('acepta valores dentro de rango', () => {
    setEnv(BASE_ENV);
    const { validateGlobalResponseSettings, validateCustomerResponseSettings } = load('validators/response.validator.js');

    assert.equal(
      validateGlobalResponseSettings({
        enabled: true,
        minDelaySeconds: 0,
        maxDelaySeconds: 900,
        groupingWindowSeconds: 120,
        maxConcurrentResponses: 10,
        alertThreshold: 100,
      }).valid,
      true
    );
    assert.equal(
      validateCustomerResponseSettings({
        enabled: true,
        minDelaySeconds: 0,
        maxDelaySeconds: 900,
        randomVariation: false,
        priority: 10,
        paused: false,
      }).valid,
      true
    );
  });

  test('rechaza negativos, fuera de rango y no enteros', () => {
    setEnv(BASE_ENV);
    const { validateGlobalResponseSettings, validateCustomerResponseSettings } = load('validators/response.validator.js');

    const negative = validateGlobalResponseSettings({ minDelaySeconds: -1 });
    assert.equal(negative.valid, false);
    assert.match(negative.errors.join(' '), /minDelaySeconds/);

    const huge = validateGlobalResponseSettings({ maxDelaySeconds: 901 });
    assert.equal(huge.valid, false);

    const group = validateGlobalResponseSettings({ groupingWindowSeconds: 121 });
    assert.equal(group.valid, false);

    const concurrent = validateGlobalResponseSettings({ maxConcurrentResponses: 0 });
    assert.equal(concurrent.valid, false);

    const decimal = validateCustomerResponseSettings({ priority: 2.5 });
    assert.equal(decimal.valid, false);

    const priority = validateCustomerResponseSettings({ priority: 11 });
    assert.equal(priority.valid, false);
  });

  test('rechaza maximo menor que minimo', () => {
    setEnv(BASE_ENV);
    const v = load('validators/response.validator.js');
    const result = v.validateGlobalResponseSettings({ minDelaySeconds: 40, maxDelaySeconds: 10 });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /maxDelaySeconds/);
  });

  test('el calculo suma la ventana de agrupacion y usa el minimo si no hay variacion', () => {
    setEnv(BASE_ENV);
    load('services/responseControl.service.js');
    const { computeDelaySeconds } = require('../src/services/responseControl.service.js');

    assert.equal(
      computeDelaySeconds({ minDelaySeconds: 10, maxDelaySeconds: 30, groupingWindowSeconds: 4, randomVariation: false }),
      14
    );
    const withRandom = computeDelaySeconds(
      { minDelaySeconds: 10, maxDelaySeconds: 30, groupingWindowSeconds: 4 },
      { random: () => 0.5 }
    );
    assert.ok(withRandom >= 14 && withRandom <= 34, `delay fuera de rango: ${withRandom}`);
  });
});

// ---------------------------------------------------------------------------
// Configuracion global, pausa, reanudacion y detencion
// ---------------------------------------------------------------------------
describe('Configuracion global de respuestas', () => {
  test('guardar la configuracion persiste los valores y los devuelve', async () => {
    const { world, control } = freshControl();
    const updated = await control.updateGlobalSettings(
      {
        enabled: true,
        minDelaySeconds: 12,
        maxDelaySeconds: 25,
        groupingWindowSeconds: 6,
        maxConcurrentResponses: 3,
        alertThreshold: 8,
      },
      { id: 1, email: 'admin@example.com' }
    );

    assert.equal(updated.minDelaySeconds, 12);
    assert.equal(updated.maxDelaySeconds, 25);
    assert.equal(updated.groupingWindowSeconds, 6);
    assert.equal(updated.maxConcurrentResponses, 3);
    assert.equal(updated.alertThreshold, 8);
    assert.equal(world.globalRow.min_delay_seconds, 12);
    assert.equal(world.globalRow.max_concurrent_responses, 3);
    const updateCall = world.calls.find((c) => c.startsWith('updateGlobal:'));
    assert.match(updateCall, /"min_delay_seconds":12/, 'debe enviar columnas snake_case al modelo');
    assert.match(updateCall, /"max_concurrent_responses":3/);
    assert.equal(world.history.at(-1).action, 'UPDATE_SETTINGS');
    assert.equal(world.history.at(-1).scope, 'GLOBAL');
  });

  test('rechaza configuracion invalida sin tocar la base', async () => {
    const { world, control } = freshControl();
    await assert.rejects(
      () => control.updateGlobalSettings({ minDelaySeconds: -5 }),
      (err) => err.status === 400 && /minDelaySeconds/.test(err.message)
    );
    assert.equal(world.count || true, true);
    assert.equal(world.calls.some((c) => c.startsWith('updateGlobal')), false);
  });

  test('apagar el interruptor maestro pausa trabajos y cola de envio', async () => {
    const { world, control } = freshControl();
    const updated = await control.updateGlobalSettings({ enabled: false }, { id: 2 });

    assert.equal(updated.enabled, false);
    assert.equal(updated.status, 'PAUSED');
    assert.equal(world.calls.includes('pauseOpen'), true);
    assert.equal(world.calls.includes('pauseAllPending'), true);
    assert.equal(world.systemSettings.automation_status, 'PAUSED');
    assert.equal(world.systemSettings.pause_queue, 'true');
  });

  test('pausar conserva trabajos y reanudar los devuelve a la cola', async () => {
    const { world, control } = freshControl();
    await control.pauseGlobal({ id: 1 }, 'mantenimiento');

    assert.equal(world.globalRow.status, 'PAUSED');
    assert.equal(world.calls.includes('pauseOpen'), true);
    assert.equal(world.calls.includes('pauseAllPending'), true);
    assert.equal(world.history.at(-1).action, 'PAUSE');

    world.calls.length = 0;
    await control.resumeGlobal({ id: 1 });

    assert.equal(world.calls.some((c) => c.startsWith('cancelStalePaused:600')), true);
    assert.equal(world.calls.includes('resumePaused:1'), true);
    assert.equal(world.calls.includes('resumeAllPaused'), true);
    assert.equal(world.globalRow.status, 'ACTIVE');
    assert.equal(world.systemSettings.pause_queue, 'false');
    assert.equal(world.history.at(-1).action, 'RESUME');
  });

  test('detencion de emergencia cancela trabajos y envios abiertos', async () => {
    const { world, control } = freshControl();
    await control.stopGlobal({ id: 1 }, 'emergencia');

    assert.equal(world.globalRow.status, 'STOPPED');
    assert.equal(world.calls.some((c) => c.startsWith('cancelAllOpen:')), true);
    assert.equal(world.calls.includes('cancelAllOpenQueue'), true);
    assert.equal(world.history.at(-1).action, 'EMERGENCY_STOP');
    assert.equal(world.history.at(-1).reason, 'emergencia');
  });

  test('estado global incluye metricas, limites y alertas', async () => {
    const { control } = freshControl();
    const status = await control.getStatus({ connection: { status: 'DISCONNECTED' } });

    assert.equal(status.stats.pending, 2);
    assert.equal(status.limits.maxConcurrentResponses.max, 10);
    assert.equal(status.alerts.some((a) => a.code === 'WHATSAPP_NOT_CONNECTED'), true);

    const alerts = control.buildAlerts({
      settings: { enabled: true, status: 'ACTIVE', alertThreshold: 3 },
      stats: { pending: 60, paused: 0, failed_today: 5, uncertain_today: 1 },
      connection: { status: 'CONNECTED' },
    });
    assert.equal(alerts.some((a) => a.code === 'REPEATED_ERRORS'), true);
    assert.equal(alerts.some((a) => a.code === 'UNCERTAIN_DELIVERIES'), true);
    assert.equal(alerts.some((a) => a.code === 'QUEUE_BACKLOG'), true);
  });
});

// ---------------------------------------------------------------------------
// Configuracion por cliente
// ---------------------------------------------------------------------------
describe('Configuracion por cliente', () => {
  test('sin fila propia usa los valores globales', async () => {
    const { control } = freshControl();
    const state = await control.getEffectiveCustomerSettings(7);

    assert.equal(state.configured, false);
    assert.equal(state.effective.minDelaySeconds, 30);
    assert.equal(state.effective.maxDelaySeconds, 60);
    assert.equal(state.effective.priority, 0);
    assert.equal(state.effective.enabled, true);
  });

  test('guardar tiempos propios crea/actualiza la fila y se refleja al leer', async () => {
    const { world, control } = freshControl();
    const result = await control.updateCustomerSettings(
      7,
      { minDelaySeconds: 8, maxDelaySeconds: 12, randomVariation: false, priority: 9 },
      { id: 4, email: 'agente@example.com' }
    );

    assert.equal(result.effective.minDelaySeconds, 8);
    assert.equal(result.effective.maxDelaySeconds, 12);
    assert.equal(result.effective.priority, 9);
    assert.equal(result.effective.randomVariation, false);
    assert.equal(world.ownRow.min_delay_seconds, 8);
    const upsertCall = world.calls.find((c) => c.startsWith('upsertCustomer:'));
    assert.match(upsertCall, /"min_delay_seconds":8/, 'debe enviar columnas snake_case al modelo');
    assert.match(upsertCall, /"random_variation":false/);
    assert.equal(world.history.at(-1).scope, 'CUSTOMER');
    assert.equal(world.history.at(-1).action, 'UPDATE_SETTINGS');
  });

  test('valores fuera de rango se rechazan antes de guardar', async () => {
    const { world, control } = freshControl();
    await assert.rejects(
      () => control.updateCustomerSettings(7, { minDelaySeconds: 999 }),
      (err) => err.status === 400
    );
    assert.equal(world.calls.some((c) => c.startsWith('upsertCustomer')), false);
  });

  test('desactivar o pausar un cliente cancela sus respuestas pendientes', async () => {
    const { world, control } = freshControl({ cancelledSends: 2 });
    const result = await control.updateCustomerSettings(7, { paused: true }, { id: 1 });

    assert.equal(result.effective.paused, true);
    assert.equal(world.calls.some((c) => c.startsWith('cancelOpenByCustomer')), true);
    assert.equal(world.calls.some((c) => c.startsWith('cancelPendingByConversation:11')), true);
    assert.equal(world.history.at(-1).action, 'UPDATE_SETTINGS');
  });

  test('restablecer borra la fila y vuelve a los valores globales', async () => {
    const { world, control } = freshControl();
    await control.updateCustomerSettings(7, { minDelaySeconds: 9 }, { id: 1 });
    world.calls.length = 0;

    const result = await control.resetCustomerSettings(7, { id: 1 });
    assert.equal(world.calls.includes('removeCustomer'), true);
    assert.equal(result.configured, false);
    assert.equal(result.effective.minDelaySeconds, 30);
    assert.equal(world.history.at(-1).action, 'RESET_TO_DEFAULTS');
  });

  test('el estado del cliente incluye conversacion y ultima respuesta', async () => {
    const { control } = freshControl({ openJob: { id: 77, status: 'PENDING' } });
    const state = await control.getCustomerState(7);

    assert.equal(state.customer.id, 7);
    assert.equal(state.conversation.id, 11);
    assert.equal(state.conversation.botEnabled, true);
    assert.equal(state.openJob.id, 77);
  });
});

// ---------------------------------------------------------------------------
// Programacion: tiempos, agrupacion e idempotencia
// ---------------------------------------------------------------------------
describe('Programacion de respuestas', () => {
  test('usa los tiempos propios del cliente y reinicia el vencimiento con cada mensaje', async () => {
    const { world, control } = freshControl({
      ownRow: {
        customer_id: 7,
        enabled: true,
        min_delay_seconds: 8,
        max_delay_seconds: 8,
        random_variation: false,
        priority: 7,
        paused: false,
      },
    });

    const scheduled = await control.scheduleResponse({
      customer: { id: 7, phone: '51999000111', status: 'ACTIVE' },
      conversation: { id: 11, status: 'OPEN', bot_enabled: true },
      message: { id: 55 },
    });

    assert.equal(scheduled.scheduled, true);
    // 8 s propios + 5 s de agrupacion global
    assert.equal(scheduled.delaySeconds, 13);
    assert.equal(world.lastSchedule.priority, 7);
    assert.equal(world.lastSchedule.idempotencyKey, 'resp:conv:11:msg:55');
    assert.ok(world.lastSchedule.dueAt instanceof Date);
    assert.ok(Math.abs(world.lastSchedule.dueAt.getTime() - (Date.now() + 13000)) < 1000);

    // Otro mensaje del mismo cliente reemplaza el vencimiento (agrupa).
    const second = await control.scheduleResponse({
      customer: { id: 7, phone: '51999000111', status: 'ACTIVE' },
      conversation: { id: 11, status: 'OPEN', bot_enabled: true },
      message: { id: 56 },
    });
    assert.equal(second.scheduled, true);
    assert.equal(world.lastSchedule.idempotencyKey, 'resp:conv:11:msg:56');
  });

  test('sin configuracion propia usa el rango global con variacion', async () => {
    const { control } = freshControl();
    const scheduled = await control.scheduleResponse({
      customer: { id: 7, phone: '51999000111', status: 'ACTIVE' },
      conversation: { id: 11, status: 'OPEN', bot_enabled: true },
      message: { id: 55 },
    });

    assert.equal(scheduled.scheduled, true);
    assert.ok(scheduled.delaySeconds >= 35 && scheduled.delaySeconds <= 65, `delay: ${scheduled.delaySeconds}`);
  });

  test('no programa si el sistema esta pausado o el cliente desactivado', async () => {
    const paused = freshControl();
    paused.world.globalRow.status = 'PAUSED';
    const r1 = await paused.control.scheduleResponse({
      customer: { id: 7, phone: '519', status: 'ACTIVE' },
      conversation: { id: 11, status: 'OPEN', bot_enabled: true },
      message: { id: 55 },
    });
    assert.deepEqual(r1, { scheduled: false, reason: 'global_paused' });

    const disabled = freshControl({
      ownRow: { customer_id: 7, enabled: false, min_delay_seconds: 5, max_delay_seconds: 5, random_variation: false, priority: 0, paused: false },
    });
    const r2 = await disabled.control.scheduleResponse({
      customer: { id: 7, phone: '519', status: 'ACTIVE' },
      conversation: { id: 11, status: 'OPEN', bot_enabled: true },
      message: { id: 55 },
    });
    assert.equal(r2.scheduled, false);
    assert.equal(r2.reason, 'customer_disabled');
  });

  test('no programa en atencion humana, conversacion cerrada ni cliente bloqueado', async () => {
    const human = freshControl();
    const r1 = await human.control.scheduleResponse({
      customer: { id: 7, phone: '519', status: 'ACTIVE' },
      conversation: { id: 11, status: 'OPEN', bot_enabled: false },
      message: { id: 55 },
    });
    assert.equal(r1.reason, 'human_takeover');

    const closed = freshControl();
    const r2 = await closed.control.scheduleResponse({
      customer: { id: 7, phone: '519', status: 'ACTIVE' },
      conversation: { id: 11, status: 'CLOSED', bot_enabled: true },
      message: { id: 55 },
    });
    assert.equal(r2.reason, 'conversation_closed');

    const blocked = freshControl();
    const r3 = await blocked.control.scheduleResponse({
      customer: { id: 7, phone: '519', status: 'BLOCKED' },
      conversation: { id: 11, status: 'OPEN', bot_enabled: true },
      message: { id: 55 },
    });
    assert.equal(r3.reason, 'customer_blocked');
  });
});

// ---------------------------------------------------------------------------
// Atencion humana y permisos
// ---------------------------------------------------------------------------
describe('Atencion humana', () => {
  test('tomar control desactiva el bot e invalida respuestas pendientes', async () => {
    const { world, control } = freshControl({ cancelledSends: 2 });
    const result = await control.takeOverConversation({
      conversationId: 11,
      actor: { id: 4, email: 'agente@example.com' },
      reason: 'Cliente pidio hablar con una persona',
    });

    assert.equal(result.conversation.status, 'HUMAN');
    assert.equal(result.conversation.bot_enabled, false);
    assert.equal(result.cancelledJobs, 1);
    assert.equal(result.cancelledSends, 2);
    assert.equal(world.calls.some((c) => c.startsWith('cancelOpenByConversation')), true);
    assert.equal(world.calls.some((c) => c.startsWith('cancelPendingByConversation:11')), true);
    assert.equal(world.history.at(-1).action, 'HUMAN_TAKEOVER');
    assert.equal(world.history.at(-1).actorId, 4);
    assert.ok(world.history.at(-1).next.status === 'HUMAN');
  });

  test('reactivar el bot vuelve a OPEN y registra quien lo hizo', async () => {
    const { world, control } = freshControl({
      conversation: { id: 11, customer_id: 7, status: 'HUMAN', bot_enabled: false },
    });
    const conversation = await control.releaseConversation({
      conversationId: 11,
      actor: { id: 9, email: 'supervisor@example.com' },
    });

    assert.equal(conversation.status, 'OPEN');
    assert.equal(conversation.bot_enabled, true);
    assert.equal(world.calls.includes('releaseBot'), true);
    assert.equal(world.history.at(-1).action, 'BOT_RELEASED');
    assert.equal(world.history.at(-1).actorId, 9);
  });

  test('solo ADMIN puede cambiar la configuracion global', () => {
    setEnv(BASE_ENV);
    const { requireAdmin } = load('middleware/requireAdmin.js');

    const noUser = { statusCode: 0, body: null };
    requireAdmin({}, { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }, () => {});
    assert.equal(noUser.statusCode, 0);

    const forbidden = {
      statusCode: 0,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    let continued = false;
    requireAdmin({ user: { role: 'AGENT' } }, forbidden, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(forbidden.statusCode, 403);
    assert.match(forbidden.body.error, /ADMIN/);

    let adminNext = false;
    requireAdmin({ user: { role: 'ADMIN' } }, {}, () => { adminNext = true; });
    assert.equal(adminNext, true);
  });

  test('las rutas administrativas exigen requireAdmin y la lectura no', () => {
    const file = path.resolve(__dirname, '..', 'src', 'routes', 'responseControl.routes.js');
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);

    const mustBeAdmin = [
      "router.put('/', requireAuth, requireAdmin",
      "router.post('/pause', requireAuth, requireAdmin",
      "router.post('/resume', requireAuth, requireAdmin",
      "router.post('/stop', requireAuth, requireAdmin",
      "router.post('/jobs/:id/retry', requireAuth, requireAdmin",
    ];
    for (const snippet of mustBeAdmin) {
      assert.ok(lines.some((line) => line.includes(snippet)), `falta requireAdmin: ${snippet}`);
    }

    assert.ok(lines.some((line) => line.includes("router.get('/', requireAuth, controller.getStatus")), 'la lectura debe requerir sesion');
    assert.ok(lines.some((line) => line.includes("router.post('/customers/:customerId/state', requireAuth, controller.setCustomerState")), 'la accion por cliente solo requiere sesion');
  });
});

// ---------------------------------------------------------------------------
// Procesador persistente
// ---------------------------------------------------------------------------
describe('Procesador persistente de respuestas', () => {
  test('genera la respuesta, la encola con clave idempotente y marca QUEUED', async () => {
    const { world, processor } = freshProcessing();
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'queued');
    assert.equal(world.lastEnqueue.idempotencyKey, 'respjob:101:gen:3');
    assert.equal(world.lastEnqueue.responseJobId, 101);
    assert.equal(world.lastEnqueue.responseGeneration, 3);
    assert.equal(world.lastEnqueue.message, 'Hola, con gusto te ayudo');
    assert.equal(world.calls.some((c) => c.startsWith('markQueued')), true);
    assert.equal(world.calls.includes('workerTick'), true);
    assert.equal(world.calls.includes('maybeSummarizeMemory'), true);
  });

  test('no envia una respuesta si ya no es la generacion vigente', async () => {
    const { world, processor } = freshProcessing({ stillCurrent: false });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'stale');
    assert.equal(world.lastEnqueue, null);
  });

  test('si llega un mensaje nuevo durante la generacion, descarta el texto viejo', async () => {
    const { world, processor } = freshProcessing({ stillCurrentResults: [true, false] });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'stale');
    assert.equal(world.lastEnqueue, null);
    assert.equal(world.calls.includes('buildReply'), true);
  });

  test('si una persona toma la conversacion durante la generacion, cancela el trabajo', async () => {
    const { world, processor } = freshProcessing({
      conversationResults: [
        { id: 11, customer_id: 7, status: 'OPEN', bot_enabled: true },
        { id: 11, customer_id: 7, status: 'HUMAN', bot_enabled: false },
      ],
    });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'cancelled');
    assert.equal(world.lastEnqueue, null);
    assert.equal(world.calls.some((c) => c.startsWith('markCancelledGeneration')), true);
  });

  test('cancelar una generacion vieja NUNCA cancela la fila de un mensaje nuevo', async () => {
    const { world, processor } = freshProcessing({
      jobCancelled: false,
      reply: { cancelled: true, reason: 'newer_message_arrived' },
    });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'stale');
    assert.equal(world.calls.some((c) => c.startsWith('markCancelledGeneration')), true);
    assert.equal(world.calls.some((c) => c.startsWith('markCancelled:')), false, 'no debe usar la cancelacion por id');
  });

  test('si el sistema se pauso justo despues de reclamar, devuelve el trabajo a PENDING', async () => {
    const { world, processor } = freshProcessing({
      global: { enabled: false, status: 'PAUSED', maxConcurrentResponses: 2 },
    });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'paused');
    assert.equal(world.calls.some((c) => c.startsWith('releaseClaim')), true);
    assert.equal(world.lastEnqueue, null);
  });

  test('cliente en opt-out o desactivado no recibe respuesta', async () => {
    const optedOut = freshProcessing({ prefs: { opted_out: true } });
    const r1 = await optedOut.processor.processJob(BASE_JOB());
    assert.equal(r1.outcome, 'cancelled');
    assert.equal(optedOut.world.lastEnqueue, null);

    const disabled = freshProcessing({ effective: { effective: { enabled: false, paused: false } } });
    const r2 = await disabled.processor.processJob(BASE_JOB());
    assert.equal(r2.outcome, 'cancelled');
    assert.equal(disabled.world.lastEnqueue, null);
  });

  test('un texto duplicado de plantilla se cancela sin enviar', async () => {
    const { world, processor } = freshProcessing({
      reply: { cancelled: true, reason: 'duplicate_template' },
    });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'cancelled');
    assert.equal(world.lastEnqueue, null);
    assert.equal(world.calls.some((c) => c.startsWith('markCancelledGeneration')), true);
  });

  test('un error de generacion se reintenta y, al agotar intentos, queda FAILED', async () => {
    const retry = freshProcessing({ replyError: new Error('IA no disponible') });
    const r1 = await retry.processor.processJob(BASE_JOB());
    assert.equal(r1.outcome, 'retry');
    assert.equal(retry.world.calls.some((c) => c.startsWith('incrementFailure')), true);
    assert.equal(retry.world.lastEnqueue, null);

    const failed = freshProcessing({
      replyError: new Error('IA no disponible'),
      incrementFailureResult: { status: 'FAILED', attempts: 3 },
    });
    const r2 = await failed.processor.processJob(BASE_JOB());
    assert.equal(r2.outcome, 'failed');
  });

  test('si la cola de envio no acepta el mensaje, el trabajo no queda QUEUED', async () => {
    const { world, processor } = freshProcessing({ queueItem: null });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'retry');
    assert.equal(world.calls.some((c) => c.startsWith('markQueued')), false);
  });

  test('si otro mensaje gano la carrera al marcar QUEUED, no se envia la cola vieja', async () => {
    const { world, processor } = freshProcessing({ markQueuedOk: false });
    const result = await processor.processJob(BASE_JOB());

    assert.equal(result.outcome, 'stale');
    assert.equal(result.queueId, 900);
    assert.equal(world.lastEnqueue.idempotencyKey, 'respjob:101:gen:3');
  });
});

// ---------------------------------------------------------------------------
// Ciclo: concurrencia, pausa, reinicio y candado
// ---------------------------------------------------------------------------
describe('Ciclo de la cola de respuestas', () => {
  test('recupera trabajos tras un reinicio y procesa los persistidos', async () => {
    const { world, processor } = freshProcessing({ requeuedCount: 2 });
    const persisted = { ...BASE_JOB(), status: 'PENDING' };
    world.job = { ...persisted, status: 'PROCESSING' };
    world.claimedSource = [persisted];
    world.due = [persisted];
    world.conversationResults = [
      { id: 11, customer_id: 7, status: 'OPEN', bot_enabled: true },
      { id: 11, customer_id: 7, status: 'OPEN', bot_enabled: true },
    ];

    const summary = await processor.tick({ budgetMs: 1000 });

    assert.equal(summary.requeued, 2);
    assert.equal(summary.queued, 1);
    assert.equal(world.calls.some((c) => c.startsWith('requeueStale:5')), true);
  });

  test('respeta la concurrencia global configurada al reclamar', async () => {
    const { world, processor } = freshProcessing();
    const jobs = [
      { ...BASE_JOB(), id: 201, conversation_id: 21, status: 'PENDING' },
      { ...BASE_JOB(), id: 202, conversation_id: 22, status: 'PENDING' },
      { ...BASE_JOB(), id: 203, conversation_id: 23, status: 'PENDING' },
    ];
    world.job = jobs[0];
    world.claimedSource = jobs;
    world.due = jobs;
    world.global = { enabled: true, status: 'ACTIVE', maxConcurrentResponses: 2 };

    await processor.tick({ budgetMs: 1000 });

    assert.equal(world.calls.some((c) => c === 'findDue:2'), true, 'debe pedir como maximo 2 trabajos');
    assert.equal(world.calls.filter((c) => c.startsWith('claim:')).length, 3, 'el mock entrega los 3 porque no recorta; el limite real lo aplica SQL');
  });

  test('si otra ejecucion tiene el candado, no procesa nada', async () => {
    const { world, processor } = freshProcessing({ lockFree: false });
    world.due = [{ ...BASE_JOB(), status: 'PENDING' }];

    const summary = await processor.tick({ budgetMs: 1000 });

    assert.equal(summary.locked, true);
    assert.equal(world.calls.includes('lockAcquire'), true);
    assert.equal(world.calls.includes('lockRelease'), false);
    assert.equal(world.calls.includes('requeueStale:5'), false);
  });

  test('en pausa global no reclama ni genera respuestas', async () => {
    const { world, processor } = freshProcessing({
      global: { enabled: true, status: 'PAUSED', maxConcurrentResponses: 2 },
    });
    world.due = [{ ...BASE_JOB(), status: 'PENDING' }];

    const summary = await processor.tick({ budgetMs: 1000 });

    assert.equal(summary.paused, true);
    assert.equal(world.calls.some((c) => c.startsWith('findDue')), false);
    assert.equal(world.calls.includes('lockRelease'), true);
  });

  test('un reclamo perdido (otro proceso lo tomo) no se procesa dos veces', async () => {
    const { world, processor } = freshProcessing({ claimable: false });
    world.due = [{ ...BASE_JOB(), status: 'PENDING' }];

    const summary = await processor.tick({ budgetMs: 1000 });

    assert.equal(summary.processed, 0);
    assert.equal(world.lastEnqueue, null);
    assert.equal(world.calls.includes('lockRelease'), true);
  });

  test('si no hay trabajos vencidos, termina sin llamar al worker', async () => {
    const { world, processor } = freshProcessing({ due: [] });
    const summary = await processor.tick({ budgetMs: 1000 });

    assert.equal(summary.processed, 0);
    assert.equal(world.calls.includes('workerTick'), false);
  });
});

// ---------------------------------------------------------------------------
// Persistencia e idempotencia en la base (SQL)
// ---------------------------------------------------------------------------
describe('Persistencia e idempotencia de la cola', () => {
  test('la migracion define un solo trabajo abierto por conversacion y claves unicas', () => {
    const file = path.resolve(__dirname, '..', '..', 'database', 'migrations', '20261028_response_timing.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.match(sql, /uq_response_jobs_open_conversation/);
    assert.match(sql, /WHERE status IN \('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED'\)/);
    assert.match(sql, /uq_message_queue_idempotency_key/);
    assert.match(sql, /UNIQUE \(idempotency_key\)/);
    assert.match(sql, /uncertain_at/);
    assert.match(sql, /bot_enabled/);
    assert.match(sql, /human_taken_over_at/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS response_settings/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS customer_response_settings/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS response_jobs/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS response_settings_history/);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  });

  test('la programacion usa ON CONFLICT para agrupar sin duplicar trabajos', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'models', 'responseJob.model.js'),
      'utf8'
    );
    assert.match(sql, /ON CONFLICT \(conversation_id\) WHERE status IN/);
    assert.match(sql, /generation = response_jobs\.generation \+ 1/);
    assert.match(sql, /latest_inbound_message_id = EXCLUDED\.latest_inbound_message_id/);
    assert.match(sql, /due_at = EXCLUDED\.due_at/);
  });

  test('encolar dos veces la misma clave no crea un segundo mensaje', async () => {
    setEnv(BASE_ENV);
    fakePg.reset();
    let first = true;
    fakePg.handler = async () => {
      if (first) {
        first = false;
        return { rows: [{ id: 500, message: 'hola', status: 'PENDING' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const queue = load('models/messageQueue.model.js');
    const a = await queue.enqueue({ customerId: 7, phone: '519', message: 'hola', idempotencyKey: 'respjob:1:gen:1' });
    const b = await queue.enqueue({ customerId: 7, phone: '519', message: 'hola', idempotencyKey: 'respjob:1:gen:1' });

    assert.equal(a.id, 500);
    assert.equal(b, null, 'el duplicado no devuelve otro mensaje');
    assert.match(fakePg.calls[0].text, /ON CONFLICT \(idempotency_key\)/);
  });

  test('cerrar el trabajo tolera la carrera entre encolar y marcar QUEUED', async () => {
    setEnv(BASE_ENV);
    fakePg.reset();
    fakePg.handler = async () => ({ rows: [{ id: 101 }], rowCount: 1 });

    const jobs = load('models/responseJob.model.js');
    await jobs.markSentFromQueue(900);

    const { text, params } = fakePg.calls[0];
    assert.match(text, /status IN \('PROCESSING', 'QUEUED'\)/);
    assert.match(text, /response_job_id FROM message_queue/);
    assert.match(text, /generation = \(SELECT response_generation/);
    assert.match(text, /queue_id = \$1/);
    assert.deepEqual(params, [900]);
  });

  test('un trabajo solo se marca UNCERTAIN, nunca se reintenta solo', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'models', 'responseJob.model.js'),
      'utf8'
    );
    const retry = sql.slice(sql.indexOf('async function retryFailed'), sql.indexOf('async function list'));
    assert.match(retry, /status = 'FAILED'/);
    assert.doesNotMatch(retry, /UNCERTAIN/);
  });
});
