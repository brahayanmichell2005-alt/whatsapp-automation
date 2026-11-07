// Utilidades compartidas por las verificaciones (backend/checks/*.check.js).
//
// Objetivo: poder comprobar el codigo del backend SIN instalar dependencias y
// SIN base de datos. Se interceptan los paquetes externos (pg, pino, axios...)
// con dobles minimos y se ejecuta el codigo REAL del proyecto.
//
// Ejecutar:  npm run check     (usa el ejecutor de pruebas incluido en Node)

const Module = require('node:module');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');

// ---------------------------------------------------------------- pg falso
class FakePool {
  constructor(options) {
    this.options = options;
    fakePg.instances.push(this);
  }
  on() {}
  async query(text, params) {
    fakePg.calls.push({ text, params });
    return fakePg.handler(text, params);
  }
  async end() {}
}

const fakePg = {
  Pool: FakePool,
  types: {
    setTypeParser(oid, fn) {
      fakePg.typeParsers[oid] = fn;
    },
  },
  instances: [],
  typeParsers: {},
  calls: [],
  // Respuesta por defecto de cualquier consulta: una fila generica.
  handler: async () => ({ rows: [{ id: 1, total: 2, hits: 1, value: 'v', key: 'k' }], rowCount: 1 }),
  reset() {
    fakePg.instances.length = 0;
    fakePg.calls.length = 0;
    fakePg.typeParsers = {};
    fakePg.handler = async () => ({ rows: [{ id: 1, total: 2, hits: 1, value: 'v', key: 'k' }], rowCount: 1 });
  },
};

// ------------------------------------------------------- otros paquetes falsos
const noop = () => {};
const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => fakeLogger };
const fakePino = () => fakeLogger;

const fakeAxiosClient = {
  get: async () => ({ data: {} }),
  post: async () => ({ data: {} }),
  delete: async () => ({ data: {} }),
};

const stubs = {
  pg: fakePg,
  dotenv: { config: noop },
  pino: fakePino,
  axios: { create: () => fakeAxiosClient },
  bcryptjs: {
    hash: async (plain) => `hash:${plain}`,
    compare: async (plain, hash) => hash === `hash:${plain}`,
  },
  jsonwebtoken: { sign: () => 'token', verify: () => ({}) },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

// ------------------------------------------------------------------ helpers
// Olvida todos los modulos de src/ para que la siguiente carga lea el entorno nuevo.
function freshSrc() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) delete require.cache[key];
  }
}

// Define variables de entorno (undefined = borrar) y recarga src/.
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  freshSrc();
}

const src = (rel) => path.join(SRC, rel);
const load = (rel) => require(src(rel));

// Reemplaza un modulo de src/ (ruta relativa a src/, con .js) por un doble.
function inject(rel, exports) {
  const file = require.resolve(src(rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}

module.exports = { fakePg, fakeLogger, freshSrc, setEnv, src, load, inject, SRC };
