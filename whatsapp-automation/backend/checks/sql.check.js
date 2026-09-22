// Verifica, sin base de datos, que TODAS las consultas SQL de los modelos son
// coherentes con PostgreSQL: placeholders $1..$n contiguos y con el mismo
// numero de parametros, sin restos de sintaxis MySQL, INSERT con columnas y
// valores parejos. Ademas prueba la configuracion de conexion a Supabase.
//
// Ejecutar:  npm run check

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { fakePg, setEnv, load } = require('./_harness');

const SUPABASE_URL =
  'postgresql://postgres.abcdefgh:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true';

// ------------------------------------------------------------------ linter SQL
function splitTopLevel(str) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function lintSql(text, params, label) {
  const where = `${label}\n  SQL: ${text.replace(/\s+/g, ' ').trim()}\n  params: ${JSON.stringify(params)}`;

  // 1) placeholders contiguos y == numero de parametros
  const used = [...new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const max = used.length ? used[used.length - 1] : 0;
  assert.deepEqual(used, Array.from({ length: max }, (_, i) => i + 1), `placeholders no contiguos\n  ${where}`);
  assert.equal((params || []).length, max, `cantidad de parametros distinta a la de placeholders\n  ${where}`);

  // 2) nada de sintaxis MySQL
  assert.ok(!text.includes('?'), `usa "?" (MySQL) en vez de $n\n  ${where}`);
  assert.ok(!text.includes('`'), `usa backticks (MySQL)\n  ${where}`);
  assert.ok(
    !/ON DUPLICATE KEY|INSERT IGNORE|AUTO_INCREMENT|INTERVAL\s+\S+\s+MINUTE|VALUES\(\s*`?value/i.test(text),
    `sintaxis exclusiva de MySQL\n  ${where}`
  );

  // 3) INSERT: mismo numero de columnas y valores
  const ins = text.match(/INSERT\s+INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\((.*?)\)\s*(?:ON CONFLICT|RETURNING|$)/is);
  if (ins) {
    const cols = splitTopLevel(ins[1]);
    const vals = splitTopLevel(ins[2]);
    assert.equal(cols.length, vals.length, `INSERT con distinto numero de columnas y valores\n  ${where}`);
  }
}

function lintAllCalls(label) {
  assert.ok(fakePg.calls.length > 0, `${label}: no ejecuto ninguna consulta`);
  fakePg.calls.forEach((c, i) => lintSql(c.text, c.params, `${label} (consulta ${i + 1})`));
}

// ----------------------------------------------------------- casos por modelo
const NOW = new Date('2026-09-19T15:00:00Z');

const CASES = {
  'models/customer.model.js': {
    findByPhone: [['51999000111']],
    findById: [[1]],
    create: [[{ phone: '51999000111', name: 'Ana', email: 'a@a.com' }]],
    findOrCreateByPhone: [['51999000111', 'Ana']],
    updateClassification: [[1, { interestType: 'PRODUCTO', interestLevel: 'ALTO' }]],
    touchLastMessage: [[1]],
    list: [[{ limit: 10, offset: 0 }], [undefined]],
    update: [[1, { name: 'Ana', status: 'BLOCKED', interest_type: 'SERVICIO', evil: 'x' }], [1, {}]],
    remove: [[1]],
  },
  'models/conversation.model.js': {
    findById: [[1]],
    findOpenByCustomer: [[1]],
    create: [[1]],
    findOrCreateOpenByCustomer: [[1]],
    touchLastMessage: [[1]],
    updateStatus: [[1, 'CLOSED'], [1, 'HUMAN', { assignedTo: 3 }], [1, 'OPEN', { assignedTo: null }]],
    list: [[{ status: 'OPEN', limit: 5, offset: 0 }], [{ limit: 5, offset: 0 }]],
  },
  'models/message.model.js': {
    findById: [[1]],
    findByExternalId: [['ABC']],
    create: [[{ conversationId: 1, customerId: 1, direction: 'INBOUND', content: 'hola', externalMessageId: 'X' }]],
    updateStatus: [[1, 'SENT'], [1, 'READ']],
    listByConversation: [[1, { limit: 10, offset: 0 }]],
    list: [[{ limit: 10, offset: 0 }]],
  },
  'models/messageQueue.model.js': {
    findById: [[1]],
    enqueue: [[{ customerId: 1, phone: '519', message: 'hola' }], [{ customerId: 1, phone: '519', message: 'hola', scheduledAt: NOW }]],
    findNextBatch: [[3]],
    markProcessing: [[1]],
    markSent: [[1]],
    markFailed: [[1, 'boom']],
    incrementAttempt: [[1, 'boom']],
    cancelPendingByCustomer: [[1]],
    requeueStale: [[5]],
    pauseAllPending: [[]],
    resumeAllPaused: [[]],
    cancelAllOpen: [[]],
    list: [[{ status: 'PENDING', limit: 5, offset: 0 }], [{ limit: 5, offset: 0 }]],
  },
  'models/scheduledMessage.model.js': {
    findById: [[1]],
    create: [[{ customerId: 1, phone: '519', message: 'hola', scheduledAt: NOW }]],
    findDue: [[20]],
    markQueued: [[1]],
    markSent: [[1]],
    markFailed: [[1, 'boom']],
    cancel: [[1]],
    update: [[1, { message: 'nuevo', scheduledAt: NOW }], [1, {}]],
    list: [[{ status: 'SCHEDULED', limit: 5, offset: 0 }], [{ limit: 5, offset: 0 }]],
  },
  'models/communicationPreference.model.js': {
    findByCustomer: [[1]],
    ensureForCustomer: [[1]],
    optIn: [[1]],
    optOut: [[1]],
  },
  'models/automationLog.model.js': {
    record: [[{ eventType: 'x', level: 'INFO', message: 'm' }], [{ eventType: 'x', message: 'm', metadata: { a: 1 } }]],
    list: [[{ limit: 10, offset: 0 }], [{ level: 'ERROR', eventType: 'x', limit: 10, offset: 5 }], [{ level: 'WARN' }]],
    countRecentErrors: [['queue_send_error', 10]],
  },
  'models/systemSetting.model.js': {
    get: [['automation_status']],
    set: [['pause_queue', 'true']],
    getAll: [[]],
  },
  'models/user.model.js': {
    findByEmail: [['a@a.com']],
    findById: [[1]],
    create: [[{ name: 'Admin', email: 'a@a.com', passwordHash: 'h', role: 'ADMIN' }]],
    list: [[]],
  },
  'models/rateCounter.model.js': {
    increment: [['rl:minute:2026-09-19T15:00', 120]],
    acquire: [['rl:concurrent_sends', 60]],
    release: [['rl:concurrent_sends']],
    purgeExpired: [[]],
  },
  'models/workerLock.model.js': {
    acquire: [['message_worker_tick', 60]],
    release: [['message_worker_tick']],
  },
};

describe('SQL de los modelos (PostgreSQL)', () => {
  beforeEach(() => {
    fakePg.reset();
    setEnv({ DATABASE_URL: SUPABASE_URL, NODE_ENV: 'test' });
  });

  for (const [file, fns] of Object.entries(CASES)) {
    for (const [fnName, argSets] of Object.entries(fns)) {
      argSets.forEach((args, i) => {
        test(`${file} -> ${fnName}() #${i + 1}`, async () => {
          const model = load(file);
          assert.equal(typeof model[fnName], 'function', `${fnName} no existe en ${file}`);
          await model[fnName](...args);
          lintAllCalls(`${file} ${fnName}`);
        });
      });
    }
  }

  test('todas las funciones exportadas por los modelos estan cubiertas', () => {
    for (const [file, fns] of Object.entries(CASES)) {
      const exported = Object.keys(load(file)).sort();
      assert.deepEqual(Object.keys(fns).sort(), exported, `funciones sin caso de prueba en ${file}`);
    }
  });
});

describe('Comportamiento de los modelos', () => {
  beforeEach(() => {
    fakePg.reset();
    setEnv({ DATABASE_URL: SUPABASE_URL, NODE_ENV: 'test' });
  });

  test('create devuelve la fila de RETURNING (ya no existe insertId)', async () => {
    fakePg.handler = async () => ({ rows: [{ id: 42, phone: '519' }], rowCount: 1 });
    const row = await load('models/customer.model.js').create({ phone: '519' });
    assert.equal(row.id, 42);
    assert.match(fakePg.calls[0].text, /RETURNING \*/);
  });

  test('findById devuelve null cuando no hay fila', async () => {
    fakePg.handler = async () => ({ rows: [], rowCount: 0 });
    assert.equal(await load('models/customer.model.js').findById(99), null);
    assert.equal(await load('models/conversation.model.js').findById(99), null);
  });

  test('findOrCreateByPhone: existente -> no inserta', async () => {
    fakePg.handler = async () => ({ rows: [{ id: 7, phone: '519' }], rowCount: 1 });
    const row = await load('models/customer.model.js').findOrCreateByPhone('519', 'Ana');
    assert.equal(row.id, 7);
    assert.equal(fakePg.calls.length, 1);
  });

  test('findOrCreateByPhone: carrera (otro webhook lo creo primero) -> relee sin fallar', async () => {
    const answers = [
      { rows: [], rowCount: 0 }, // SELECT inicial: no existe
      { rows: [], rowCount: 0 }, // INSERT ... ON CONFLICT DO NOTHING: perdio la carrera
      { rows: [{ id: 5, phone: '519' }], rowCount: 1 }, // SELECT final
    ];
    fakePg.handler = async () => answers.shift();
    const row = await load('models/customer.model.js').findOrCreateByPhone('519');
    assert.equal(row.id, 5);
    assert.match(fakePg.calls[1].text, /ON CONFLICT \(phone\) DO NOTHING/);
  });

  test('las listas con fechas anulables usan NULLS LAST (como MySQL)', async () => {
    await load('models/conversation.model.js').list({ limit: 5, offset: 0 });
    await load('models/conversation.model.js').list({ status: 'OPEN', limit: 5, offset: 0 });
    fakePg.calls.forEach((c) => assert.match(c.text, /last_message_at DESC NULLS LAST/));
  });

  test('countRecentErrors devuelve un numero', async () => {
    fakePg.handler = async () => ({ rows: [{ total: 7 }], rowCount: 1 });
    assert.equal(await load('models/automationLog.model.js').countRecentErrors('x', 10), 7);
  });

  test('operaciones masivas de la cola devuelven rowCount', async () => {
    fakePg.handler = async () => ({ rows: [], rowCount: 4 });
    const q = load('models/messageQueue.model.js');
    assert.equal(await q.pauseAllPending(), 4);
    assert.equal(await q.resumeAllPaused(), 4);
    assert.equal(await q.cancelAllOpen(), 4);
    assert.equal(await q.requeueStale(5), 4);
  });

  test('workerLock.acquire: true si toma el candado, false si otro lo tiene', async () => {
    const lock = load('models/workerLock.model.js');
    fakePg.handler = async () => ({ rows: [{ name: 'x' }], rowCount: 1 });
    assert.equal(await lock.acquire('x', 60), true);
    fakePg.handler = async () => ({ rows: [], rowCount: 0 });
    assert.equal(await lock.acquire('x', 60), false);
  });

  test('customer.update solo permite columnas de la lista blanca', async () => {
    await load('models/customer.model.js').update(1, { name: 'Ana', password_hash: 'x', 'id; DROP TABLE users': 1 });
    const { text, params } = fakePg.calls[0];
    assert.match(text, /SET name = \$1 WHERE id = \$2/);
    assert.deepEqual(params, ['Ana', 1]);
  });

  test('scheduledMessage.update sin cambios no rompe (COALESCE con NULL)', async () => {
    await load('models/scheduledMessage.model.js').update(1, {});
    assert.deepEqual(fakePg.calls[0].params, [null, null, 1]);
  });

  test('updateStatus CLOSED agrega closed_at y asigna agente si se indica', async () => {
    await load('models/conversation.model.js').updateStatus(9, 'CLOSED', { assignedTo: 3 });
    const { text, params } = fakePg.calls[0];
    assert.match(text, /status = \$1, assigned_to = \$2, closed_at = NOW\(\) WHERE id = \$3/);
    assert.deepEqual(params, ['CLOSED', 3, 9]);
  });
});

describe('Conexion a Supabase (config/database.js)', () => {
  beforeEach(() => fakePg.reset());

  test('quita sslmode y pgbouncer del URL y fuerza SSL sin verificar cadena', async () => {
    setEnv({ DATABASE_URL: SUPABASE_URL, DB_SSL: undefined, DB_POOL_MAX: undefined, NODE_ENV: 'test' });
    await load('config/database.js').pool.query('SELECT 1');
    const opts = fakePg.instances[0].options;
    assert.ok(!opts.connectionString.includes('sslmode'));
    assert.ok(!opts.connectionString.includes('pgbouncer'));
    assert.ok(opts.connectionString.includes(':6543/postgres'));
    assert.ok(opts.connectionString.includes('p%40ss'), 'la contrasena codificada debe conservarse');
    assert.deepEqual(opts.ssl, { rejectUnauthorized: false });
    assert.equal(opts.max, 3);
  });

  test('Postgres local -> sin SSL', async () => {
    setEnv({ DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/postgres', DB_SSL: undefined, NODE_ENV: 'test' });
    await load('config/database.js').pool.query('SELECT 1');
    assert.equal(fakePg.instances[0].options.ssl, false);
  });

  test('sin DATABASE_URL falla con un mensaje claro, sin crear el pool', async () => {
    setEnv({ DATABASE_URL: undefined, NODE_ENV: 'test' });
    await assert.rejects(() => load('config/database.js').pool.query('SELECT 1'), /DATABASE_URL/);
    assert.equal(fakePg.instances.length, 0);
  });

  test('el pool se crea una sola vez y se reutiliza', async () => {
    setEnv({ DATABASE_URL: SUPABASE_URL, NODE_ENV: 'test' });
    const { pool } = load('config/database.js');
    await pool.query('SELECT 1');
    await pool.query('SELECT 2');
    assert.equal(fakePg.instances.length, 1);
  });

  test('BIGINT (COUNT) se convierte a numero', () => {
    setEnv({ DATABASE_URL: SUPABASE_URL, NODE_ENV: 'test' });
    load('config/database.js');
    assert.equal(fakePg.typeParsers[20]('12'), 12);
  });

  test('checkConnection: true si responde, false si falla', async () => {
    setEnv({ DATABASE_URL: SUPABASE_URL, NODE_ENV: 'test' });
    const db = load('config/database.js');
    assert.equal(await db.checkConnection(), true);
    fakePg.handler = async () => {
      throw new Error('Tenant or user not found');
    };
    assert.equal(await db.checkConnection(), false);
  });
});

describe('Configuracion (config/env.js)', () => {
  test('en produccion exige JWT_SECRET', () => {
    setEnv({ NODE_ENV: 'production', JWT_SECRET: undefined });
    assert.throws(() => load('config/env.js'), /JWT_SECRET/);
  });

  test('en produccion no hay admin por defecto', () => {
    setEnv({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined });
    const env = load('config/env.js');
    assert.equal(env.ADMIN_EMAIL, '');
    assert.equal(env.ADMIN_PASSWORD, '');
  });

  test('en Vercel siempre es produccion, aunque NODE_ENV diga development', () => {
    setEnv({ VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'development', JWT_SECRET: undefined });
    assert.throws(() => load('config/env.js'), /JWT_SECRET/);
    setEnv({ VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(40) });
    assert.equal(load('config/env.js').NODE_ENV, 'production');
    setEnv({ VERCEL: undefined, VERCEL_ENV: undefined });
  });

  test('`vercel dev` local conserva el modo desarrollo', () => {
    setEnv({ VERCEL: '1', VERCEL_ENV: 'development', NODE_ENV: 'development', JWT_SECRET: undefined });
    assert.equal(load('config/env.js').NODE_ENV, 'development');
    setEnv({ VERCEL: undefined, VERCEL_ENV: undefined });
  });

  test('en desarrollo/test conserva los valores por defecto', () => {
    setEnv({ NODE_ENV: 'test', JWT_SECRET: undefined, ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined });
    const env = load('config/env.js');
    assert.equal(env.ADMIN_EMAIL, 'admin@example.com');
    assert.equal(env.CRON_SECRET, '');
  });
});
