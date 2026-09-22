// Verifica el comportamiento del worker, los limites de envio, la proteccion
// del endpoint de cron y el arranque perezoso, con modelos falsos en memoria.
//
// Ejecutar:  npm run check

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setEnv, load, inject } = require('./_harness');

const BASE_ENV = {
  NODE_ENV: 'test',
  TIMEZONE: 'UTC',
  START_TIME: '00:00',
  END_TIME: '24:00', // siempre dentro de horario
  MIN_DELAY_SECONDS: 0,
  MAX_DELAY_SECONDS: 0,
  MAX_RETRIES: 3,
  MAX_CONCURRENT_SENDS: 3,
  MAX_MESSAGES_PER_MINUTE: 20,
  MAX_MESSAGES_PER_HOUR: 200,
  MAX_MESSAGES_PER_DAY: 1000,
  ANOMALY_ERROR_THRESHOLD: 5,
};

// Mundo en memoria: guarda estado y registra cada llamada.
function makeWorld(extra = {}) {
  const w = {
    calls: [],
    settings: { automation_status: 'ACTIVE', pause_queue: 'false' },
    queue: [],
    optedOut: false,
    connection: { status: 'CONNECTED' },
    lockFree: true,
    counters: {},
    recentErrors: 0,
    send: async () => ({ externalMessageId: 'ext-1' }),
    batchCalls: 0,
    ...extra,
  };
  const rec = (name) => w.calls.push(name);
  const count = (name) => w.calls.filter((c) => c === name).length;
  w.count = count;

  inject('models/messageQueue.model.js', {
    findNextBatch: async () => {
      w.batchCalls += 1;
      return w.queue.filter((i) => i.status === 'PENDING').slice(0, 3);
    },
    markProcessing: async (id) => { rec('markProcessing'); w.queue.find((i) => i.id === id).status = 'PROCESSING'; },
    markSent: async (id) => { rec('markSent'); w.queue.find((i) => i.id === id).status = 'SENT'; },
    markFailed: async (id) => { rec('markFailed'); w.queue.find((i) => i.id === id).status = 'FAILED'; },
    incrementAttempt: async (id) => { rec('incrementAttempt'); const it = w.queue.find((i) => i.id === id); it.status = 'PENDING'; it.attempts += 1; },
    requeueStale: async () => {
      rec('requeueStale');
      if (w.requeueError) throw new Error(w.requeueError);
      return 0;
    },
  });
  inject('models/message.model.js', { create: async () => { rec('messageCreate'); return { id: 1 }; } });
  inject('models/conversation.model.js', {
    findOrCreateOpenByCustomer: async () => ({ id: 10 }),
    touchLastMessage: async () => rec('touchLastMessage'),
  });
  inject('models/communicationPreference.model.js', { findByCustomer: async () => ({ opted_out: w.optedOut }) });
  inject('models/automationLog.model.js', {
    record: async ({ eventType }) => rec(`log:${eventType}`),
    countRecentErrors: async () => w.recentErrors,
  });
  inject('models/systemSetting.model.js', {
    get: async (k) => (k in w.settings ? w.settings[k] : null),
    set: async (k, v) => { w.settings[k] = v; return v; },
  });
  inject('models/rateCounter.model.js', {
    increment: async (key) => { w.counters[key] = (w.counters[key] || 0) + 1; rec('increment'); return w.counters[key]; },
    acquire: async (key) => { w.counters[key] = (w.counters[key] || 0) + 1; rec('slotAcquire'); return w.counters[key]; },
    release: async (key) => { w.counters[key] = Math.max(0, (w.counters[key] || 0) - 1); rec('slotRelease'); },
    purgeExpired: async () => rec('purge'),
  });
  inject('models/workerLock.model.js', {
    acquire: async () => { rec('lockAcquire'); return w.lockFree; },
    release: async () => rec('lockRelease'),
  });
  inject('services/evolution.service.js', {
    checkConnection: async () => w.connection,
    sendTextMessage: async (...a) => { rec('send'); return w.send(...a); },
  });
  return w;
}

const item = (id, attempts = 0) => ({ id, customer_id: 1, phone: '51999000111', message: `msg ${id}`, status: 'PENDING', attempts });

function fresh(envOverrides = {}, worldExtra = {}) {
  setEnv({ ...BASE_ENV, ...envOverrides });
  const world = makeWorld(worldExtra);
  return { world, worker: load('workers/message.worker.js') };
}

describe('Worker de envio', () => {
  test('envia todo lo pendiente, recupera atascados, purga y libera el candado', async () => {
    const { world, worker } = fresh();
    world.queue = [item(1), item(2), item(3), item(4)];
    const r = await worker.tick({ budgetMs: 45000 });

    assert.equal(r.sent, 4);
    assert.equal(world.count('send'), 4);
    assert.equal(world.count('requeueStale'), 1);
    assert.equal(world.count('purge'), 1);
    assert.equal(world.count('lockRelease'), 1);
    assert.equal(world.queue.every((i) => i.status === 'SENT'), true);
    assert.ok(world.settings.worker_last_send_at, 'debe registrar el ultimo envio');
    assert.equal(world.count('slotAcquire'), world.count('slotRelease'), 'todo cupo tomado se libera');
  });

  test('si otra ejecucion tiene el candado, no procesa nada', async () => {
    const { world, worker } = fresh({}, { lockFree: false });
    world.queue = [item(1)];
    const r = await worker.tick({ budgetMs: 45000 });

    assert.equal(r.locked, true);
    assert.equal(world.batchCalls, 0);
    assert.equal(world.count('send'), 0);
    assert.equal(world.count('lockRelease'), 0, 'no libera un candado que no tomo');
  });

  test('automatizacion pausada: no envia y NO entra en bucle', async () => {
    const { world, worker } = fresh();
    world.settings.automation_status = 'PAUSED';
    world.queue = [item(1), item(2)];
    await worker.tick({ budgetMs: 45000 });

    assert.equal(world.count('send'), 0);
    assert.equal(world.batchCalls, 1, 'una sola consulta a la cola, sin bucle caliente');
    assert.equal(world.queue.every((i) => i.status === 'PENDING'), true);
    assert.equal(world.count('lockRelease'), 1);
  });

  test('pause_queue=true tambien detiene los envios', async () => {
    const { world, worker } = fresh();
    world.settings.pause_queue = 'true';
    world.queue = [item(1)];
    await worker.tick({ budgetMs: 45000 });
    assert.equal(world.count('send'), 0);
  });

  test('fuera de horario: el mensaje queda pendiente', async () => {
    const { world, worker } = fresh({ START_TIME: '00:00', END_TIME: '00:00' });
    world.queue = [item(1)];
    await worker.tick({ budgetMs: 45000 });
    assert.equal(world.count('send'), 0);
    assert.equal(world.queue[0].status, 'PENDING');
  });

  test('cliente en opt-out: se descarta y se sigue con el siguiente', async () => {
    const { world, worker } = fresh();
    world.optedOut = true;
    world.queue = [item(1), item(2)];
    const r = await worker.tick({ budgetMs: 45000 });
    assert.equal(r.failed, 2);
    assert.equal(world.count('send'), 0);
    assert.equal(world.count('log:queue_send'), 2);
  });

  test('WhatsApp desconectado: no marca PROCESSING y libera el cupo de concurrencia', async () => {
    const { world, worker } = fresh();
    world.connection = { status: 'DISCONNECTED' };
    world.queue = [item(1)];
    await worker.tick({ budgetMs: 45000 });
    assert.equal(world.count('markProcessing'), 0);
    assert.equal(world.count('slotAcquire'), 1);
    assert.equal(world.count('slotRelease'), 1);
    assert.equal(world.queue[0].status, 'PENDING');
  });

  test('limite por minuto alcanzado: no envia y deja bitacora', async () => {
    const { world, worker } = fresh({ MAX_MESSAGES_PER_MINUTE: 1 });
    world.queue = [item(1), item(2)];
    const r = await worker.tick({ budgetMs: 45000 });
    assert.equal(r.sent, 1, 'solo cabe 1 por minuto');
    assert.equal(world.count('log:rate_limit_hit'), 1);
    assert.equal(world.queue[1].status, 'PENDING');
  });

  test('error de envio con intentos disponibles: reintenta y evalua anomalias', async () => {
    const { world, worker } = fresh({}, { send: async () => { throw new Error('boom'); } });
    world.queue = [item(1, 0)];
    const r = await worker.tick({ budgetMs: 45000 });
    assert.equal(r.sent, 0);
    assert.equal(world.count('incrementAttempt'), 1);
    assert.equal(world.count('markFailed'), 0);
    assert.equal(world.count('log:queue_send_error'), 1);
    assert.equal(world.batchCalls, 1, 'tras un error no insiste en la misma pasada');
    assert.equal(world.count('slotRelease'), 1);
  });

  test('error en el ultimo intento: se marca FAILED', async () => {
    const { world, worker } = fresh({ MAX_RETRIES: 3 }, { send: async () => { throw new Error('boom'); } });
    world.queue = [item(1, 2)];
    await worker.tick({ budgetMs: 45000 });
    assert.equal(world.count('markFailed'), 1);
    assert.equal(world.count('incrementAttempt'), 0);
  });

  test('muchos errores recientes: pausa la cola automaticamente', async () => {
    const { world, worker } = fresh({ ANOMALY_ERROR_THRESHOLD: 5 }, { recentErrors: 5, send: async () => { throw new Error('boom'); } });
    world.queue = [item(1)];
    await worker.tick({ budgetMs: 45000 });
    assert.equal(world.settings.pause_queue, 'true');
    assert.equal(world.settings.automation_status, 'PAUSED');
    assert.equal(world.count('log:anomaly_detected'), 1);
  });

  test('sin tiempo suficiente en esta ejecucion: DIFIERE sin gastar limites ni marcar PROCESSING', async () => {
    const { world, worker } = fresh({ MIN_DELAY_SECONDS: 30, MAX_DELAY_SECONDS: 30 });
    world.settings.worker_last_send_at = String(Date.now()); // acaba de enviarse uno
    world.queue = [item(1), item(2)];
    const r = await worker.tick({ budgetMs: 10000 });

    assert.equal(r.sent, 0);
    assert.equal(world.count('send'), 0);
    assert.equal(world.count('markProcessing'), 0);
    assert.equal(world.count('increment'), 0, 'no consume cupos de minuto/hora/dia');
    assert.equal(world.batchCalls, 1);
    assert.equal(world.queue.every((i) => i.status === 'PENDING'), true);
  });

  test('si el ultimo envio fue hace mas que el intervalo, envia de inmediato', async () => {
    const { world, worker } = fresh({ MIN_DELAY_SECONDS: 30, MAX_DELAY_SECONDS: 30 });
    world.settings.worker_last_send_at = String(Date.now() - 60000);
    world.queue = [item(1)];
    const r = await worker.tick({ budgetMs: 10000 });
    assert.equal(r.sent, 1);
  });

  test('modo local (sin presupuesto): una sola pasada por ciclo', async () => {
    const { world, worker } = fresh();
    world.queue = [item(1), item(2), item(3), item(4)];
    const r = await worker.tick();
    assert.equal(r.sent, 3, 'procesa el lote (3) y espera al siguiente ciclo');
    assert.equal(world.batchCalls, 1);
  });

  test('un fallo inesperado no rompe el tick y libera el candado', async () => {
    const { world, worker } = fresh({}, { requeueError: 'db caida' });
    world.queue = [item(1)];
    const r = await worker.tick({ budgetMs: 45000 });
    assert.equal(r.error, 'db caida');
    assert.equal(world.count('send'), 0);
    assert.equal(world.count('lockRelease'), 1, 'el candado se libera aunque algo falle');
  });
});

describe('Limites de envio (rateLimiter.service)', () => {
  test('las claves de ventana usan fecha ISO con separadores', async () => {
    setEnv(BASE_ENV);
    const world = makeWorld();
    await load('services/rateLimiter.service.js').checkSendLimits();
    const keys = Object.keys(world.counters);
    assert.ok(keys.some((k) => /^rl:minute:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(k)), keys.join());
    assert.ok(keys.some((k) => /^rl:hour:\d{4}-\d{2}-\d{2}T\d{2}$/.test(k)));
    assert.ok(keys.some((k) => /^rl:day:\d{4}-\d{2}-\d{2}$/.test(k)));
  });

  test('un limite en 0 significa "sin limite"', async () => {
    setEnv({ ...BASE_ENV, MAX_MESSAGES_PER_MINUTE: 0, MAX_MESSAGES_PER_HOUR: 0, MAX_MESSAGES_PER_DAY: 0 });
    makeWorld();
    const rl = load('services/rateLimiter.service.js');
    for (let i = 0; i < 5; i += 1) assert.equal((await rl.checkSendLimits()).allowed, true);
  });

  test('reporta que limite se alcanzo', async () => {
    setEnv({ ...BASE_ENV, MAX_MESSAGES_PER_HOUR: 2 });
    makeWorld();
    const rl = load('services/rateLimiter.service.js');
    assert.equal((await rl.checkSendLimits()).allowed, true);
    assert.equal((await rl.checkSendLimits()).allowed, true);
    assert.deepEqual(await rl.checkSendLimits(), { allowed: false, reason: 'MAX_MESSAGES_PER_HOUR' });
  });

  test('semaforo de concurrencia: respeta el maximo y devuelve el cupo si no cabe', async () => {
    setEnv({ ...BASE_ENV, MAX_CONCURRENT_SENDS: 2 });
    const world = makeWorld();
    const rl = load('services/rateLimiter.service.js');
    assert.equal(await rl.acquireConcurrencySlot(), true);
    assert.equal(await rl.acquireConcurrencySlot(), true);
    assert.equal(await rl.acquireConcurrencySlot(), false);
    assert.equal(world.counters['rl:concurrent_sends'], 2, 'el intento rechazado devolvio su cupo');
  });

  test('espaciado: descuenta el tiempo transcurrido desde el ultimo envio', async () => {
    setEnv(BASE_ENV);
    const world = makeWorld();
    const rl = load('services/rateLimiter.service.js');
    assert.equal(await rl.getRemainingDelayMs(20000), 20000, 'sin envios previos espera el intervalo completo');
    world.settings.worker_last_send_at = String(Date.now() - 12000);
    const left = await rl.getRemainingDelayMs(20000);
    assert.ok(left > 7000 && left <= 8000, `esperaba ~8000, obtuvo ${left}`);
    world.settings.worker_last_send_at = String(Date.now() - 60000);
    assert.equal(await rl.getRemainingDelayMs(20000), 0);
    world.settings.worker_last_send_at = 'basura';
    assert.equal(await rl.getRemainingDelayMs(20000), 20000);
  });
});

describe('Proteccion de /api/cron (cronAuth)', () => {
  function run(headers) {
    const { cronAuth } = load('middleware/cronAuth.js');
    let result;
    cronAuth({ get: (h) => headers[h.toLowerCase()] }, {}, (err) => { result = err || 'next'; });
    return result;
  }

  test('sin CRON_SECRET configurado -> 503 (falla cerrado)', () => {
    setEnv({ ...BASE_ENV, CRON_SECRET: undefined });
    assert.equal(run({ authorization: 'Bearer lo-que-sea' }).status, 503);
  });

  test('sin cabecera -> 401', () => {
    setEnv({ ...BASE_ENV, CRON_SECRET: 's3creto-largo-123' });
    assert.equal(run({}).status, 401);
  });

  test('secreto incorrecto -> 401', () => {
    setEnv({ ...BASE_ENV, CRON_SECRET: 's3creto-largo-123' });
    assert.equal(run({ authorization: 'Bearer otro' }).status, 401);
    assert.equal(run({ authorization: 's3creto-largo-12' }).status, 401);
  });

  test('secreto correcto -> continua', () => {
    setEnv({ ...BASE_ENV, CRON_SECRET: 's3creto-largo-123' });
    assert.equal(run({ authorization: 'Bearer s3creto-largo-123' }), 'next');
  });
});

describe('Controlador de cron', () => {
  test('ejecuta scheduler y luego el worker con el presupuesto configurado', async () => {
    setEnv({ ...BASE_ENV, CRON_BUDGET_MS: 30000 });
    const order = [];
    inject('services/scheduler.service.js', { tick: async () => { order.push('scheduler'); return 2; } });
    inject('workers/message.worker.js', { tick: async ({ budgetMs }) => { order.push(`worker:${budgetMs}`); return { sent: 1 }; } });
    let body;
    await load('controllers/cron.controller.js').tick({}, { json: (b) => { body = b; } }, (e) => { throw e; });
    assert.deepEqual(order, ['scheduler', 'worker:30000']);
    assert.equal(body.ok, true);
    assert.equal(body.scheduledMoved, 2);
    assert.deepEqual(body.worker, { sent: 1 });
  });

  test('si algo falla, delega el error al errorHandler', async () => {
    setEnv(BASE_ENV);
    inject('services/scheduler.service.js', { tick: async () => { throw new Error('x'); } });
    inject('workers/message.worker.js', { tick: async () => ({}) });
    let received;
    await load('controllers/cron.controller.js').tick({}, { json: () => {} }, (e) => { received = e; });
    assert.equal(received.message, 'x');
  });
});

describe('Arranque perezoso (bootstrap)', () => {
  test('crea el admin una sola vez por instancia', async () => {
    setEnv(BASE_ENV);
    let calls = 0;
    inject('services/auth.service.js', { ensureAdminUser: async () => { calls += 1; return {}; } });
    const { ensureBootstrapped } = load('bootstrap.js');
    await ensureBootstrapped();
    await ensureBootstrapped();
    await ensureBootstrapped();
    assert.equal(calls, 1);
  });

  test('si falla (p. ej. base de datos no lista) no rompe la peticion y se reintenta', async () => {
    setEnv(BASE_ENV);
    let calls = 0;
    inject('services/auth.service.js', {
      ensureAdminUser: async () => {
        calls += 1;
        if (calls === 1) throw new Error('db no lista');
        return {};
      },
    });
    const { ensureBootstrapped } = load('bootstrap.js');
    await ensureBootstrapped(); // no lanza
    await ensureBootstrapped(); // reintenta
    await ensureBootstrapped(); // ya recordado
    assert.equal(calls, 2);
  });
});
