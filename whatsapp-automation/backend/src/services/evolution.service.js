// Cliente de Evolution API (v2). Contrato que usan el resto de modulos:
//   checkConnection()   -> { status: CONNECTED|CONNECTING|DISCONNECTED|ERROR, ... }  (nunca lanza)
//   getConnectionState()-> respuesta cruda de /instance/connectionState
//   createInstance()    -> crea la instancia (si ya existe, lo tolera)
//   getQrCode(opts)     -> QR o codigo de vinculacion (si opts.number); crea la instancia si falta
//   logoutInstance()    -> cierra la sesion de WhatsApp
//   sendTextMessage()   -> { externalMessageId, raw }
//   mapConnectionStatus(state)

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const { pool } = require('../config/database');

// Eventos que el backend realmente procesa (ver evolutionEventParser).
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

// La URL de Evolution API se puede cambiar sin tocar Vercel: si existe la
// clave evolution_api_url en system_settings, tiene prioridad sobre
// EVOLUTION_API_URL. Asi se puede migrar de host (Railway -> VPS) desde el
// propio backend. La cache evita consultar la DB en cada mensaje.
const URL_CACHE_MS = 30000;
let cachedBaseUrl = null;
let cachedBaseUrlAt = 0;

function instanceName() {
  return String(env.EVOLUTION_INSTANCE || '').trim();
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function getBaseUrl() {
  if (cachedBaseUrl !== null && Date.now() - cachedBaseUrlAt < URL_CACHE_MS) {
    return cachedBaseUrl;
  }

  // Prioridad: EVOLUTION_API_URL de Vercel si existe (fuente controlada);
  // solo si no esta definida se toma el override de system_settings. Asi se
  // evita que una URL vieja guardada en la base de datos deje al backend
  // apuntando a un servidor de Evolution muerto o desvinculado.
  let url = normalizeBaseUrl(env.EVOLUTION_API_URL);
  if (!url) {
    try {
      const { rows } = await pool.query(
        "SELECT \"value\" FROM system_settings WHERE \"key\" = 'evolution_api_url' LIMIT 1"
      );
      url = normalizeBaseUrl(rows[0] && rows[0].value);
    } catch (err) {
      logger.warn({ err: err.message }, 'No se pudo leer evolution_api_url de system_settings');
    }
  }

  cachedBaseUrl = url;
  cachedBaseUrlAt = Date.now();
  return url;
}

function clearUrlCache() {
  cachedBaseUrl = null;
  cachedBaseUrlAt = 0;
}

function isConfigured() {
  return Boolean(env.EVOLUTION_API_KEY && instanceName());
}

function missingConfig() {
  const missing = [];
  if (!env.EVOLUTION_API_KEY) missing.push('EVOLUTION_API_KEY');
  if (!instanceName()) missing.push('EVOLUTION_INSTANCE');
  return missing;
}

// Cliente creado en cada llamada: asi siempre usa la URL resuelta (DB o env) y
// nunca revienta al cargar el modulo si falta alguna variable.
function client(baseURL) {
  return axios.create({
    baseURL,
    timeout: 15000,
    headers: { apikey: env.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
  });
}

function upstreamMessage(err) {
  const data = err && err.response && err.response.data;
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 300);
  if (data && Array.isArray(data.response && data.response.message)) return data.response.message.join(', ').slice(0, 300);
  if (data && typeof data.message === 'string') return data.message.slice(0, 300);
  if (data && data.response && typeof data.response.message === 'string') return data.response.message.slice(0, 300);
  if (data && typeof data.error === 'string') return data.error.slice(0, 300);
  return (err && err.message) || 'error desconocido';
}

function isInstanceMissing(err) {
  if (isHostingFallback(err)) return false;
  const status = err && err.response && err.response.status;
  if (status === 404) return true;
  return status === 400 && /does not exist|no existe|not found/i.test(upstreamMessage(err));
}

// Railway (y otros proxys) responden 404 "Application not found" cuando el
// servicio de Evolution API ya no existe o esta detenido. Eso NO significa que
// falte la instancia: crear una instancia nueva contra ese host tampoco puede
// funcionar. Se detecta para dar un error claro en vez de "fallo crear instancia".
function isHostingFallback(err) {
  const response = err && err.response;
  if (!response || response.status !== 404) return false;
  const headers = response.headers || {};
  const fallbackHeader = headers['x-railway-fallback'];
  return Boolean(fallbackHeader) || /application not found/i.test(upstreamMessage(err));
}

function evolutionHost(baseURL) {
  try {
    return new URL(baseURL || env.EVOLUTION_API_URL).host;
  } catch (err) {
    return 'la URL configurada';
  }
}


// Error seguro para el navegador: NUNCA reenvia 401/403 de Evolution (el panel
// los interpretaria como "sesion expirada" y cerraria la sesion del usuario).
function serviceError(step, err, baseURL) {
  if (isHostingFallback(err)) {
    const out = new Error(
      `Evolution API no esta disponible en ${evolutionHost(baseURL)}: el servicio de hosting responde 404 "Application not found". ` +
        'Restaura o redeploya Evolution API (Railway/Render/VPS) y actualiza EVOLUTION_API_URL si cambia el dominio.'
    );
    out.status = 503;
    out.code = 'EVOLUTION_UPSTREAM_DOWN';
    out.upstreamStatus = 404;
    return out;
  }
  const upstream = err && err.response ? err.response.status : null;
  const timeout = err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT');
  const out = new Error(
    `Evolution API: fallo "${step}"${upstream ? ` (HTTP ${upstream})` : ''}: ${upstreamMessage(err)}`
  );
  out.status = timeout ? 504 : 502;
  out.upstreamStatus = upstream;
  return out;
}

async function requireConfig() {
  const missing = missingConfig();
  if (missing.length) {
    const e = new Error(`Evolution API sin configurar. Faltan variables: ${missing.join(', ')}`);
    e.status = 503;
    throw e;
  }
  const baseURL = await getBaseUrl();
  if (!baseURL) {
    const e = new Error(
      'Evolution API sin URL: define EVOLUTION_API_URL en Vercel o evolution_api_url en system_settings'
    );
    e.status = 503;
    throw e;
  }
  return baseURL;
}

function mapConnectionStatus(state) {
  switch (String(state || '').toLowerCase()) {
    case 'open':
      return 'CONNECTED';
    case 'connecting':
      return 'CONNECTING';
    case 'close':
    case 'closed':
      return 'DISCONNECTED';
    default:
      return 'DISCONNECTED';
  }
}

function extractState(data) {
  const root = (data && (data.data || data.response)) || data || {};
  return (root.instance && (root.instance.state || root.instance.status)) || root.state || root.status || null;
}

async function getConnectionState() {
  const baseURL = await requireConfig();
  try {
    const { data } = await client(baseURL).get(`/instance/connectionState/${encodeURIComponent(instanceName())}`);
    return data;
  } catch (err) {
    if (isHostingFallback(err)) throw serviceError('consultar estado', err, baseURL);
    if (isInstanceMissing(err)) {
      const e = new Error('La instancia de WhatsApp todavia no existe en Evolution API');
      e.status = 404;
      e.instanceMissing = true;
      throw e;
    }
    throw serviceError('consultar estado', err, baseURL);
  }
}

// Estado para el panel. Nunca lanza: una instancia que aun no existe es
// "DESCONECTADO" (hay que vincularla), no un error interno.
async function checkConnection() {
  if (!isConfigured()) {
    return { status: 'ERROR', reason: `Faltan variables: ${missingConfig().join(', ')}` };
  }
  try {
    const data = await getConnectionState();
    const state = extractState(data);
    return { status: mapConnectionStatus(state), state, instance: instanceName() };
  } catch (err) {
    if (err.instanceMissing) {
      return { status: 'DISCONNECTED', state: 'not_created', instance: instanceName() };
    }
    logger.warn({ err: err.message }, 'No se pudo consultar el estado de WhatsApp');
    return { status: 'ERROR', reason: err.message, code: err.code || null };
  }
}

function webhookConfig() {
  if (!env.WEBHOOK_URL) return undefined;
  const cfg = {
    enabled: true,
    url: env.WEBHOOK_URL,
    byEvents: false,
    base64: false,
    events: WEBHOOK_EVENTS,
  };
  if (env.WEBHOOK_SECRET) cfg.headers = { 'x-webhook-token': env.WEBHOOK_SECRET };
  return cfg;
}

async function createInstance(extra = {}) {
  const baseURL = await requireConfig();
  const body = {
    instanceName: instanceName(),
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    ...extra,
  };
  const webhook = webhookConfig();
  if (webhook) body.webhook = webhook;
  try {
    const { data } = await client(baseURL).post('/instance/create', body);
    return data;
  } catch (err) {
    const status = err.response && err.response.status;
    // 403/409 "ya existe": otro proceso la creo antes -> se tolera.
    if ((status === 403 || status === 409) && /already|exist|in use|ya existe/i.test(upstreamMessage(err))) {
      return { instance: { instanceName: instanceName(), status: 'already_exists' } };
    }
    throw serviceError('crear instancia', err, baseURL);
  }
}

function normalizeConnect(data) {
  const root = (data && (data.data || data.response)) || data || {};
  const qr = root.qrcode || root.qrCode || {};
  return {
    base64: qr.base64 || root.base64 || null,
    code: qr.code || root.code || null,
    pairingCode: qr.pairingCode || root.pairingCode || null,
  };
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

// Obtiene el QR o, si se indica `number` (con codigo de pais), el codigo de
// vinculacion de 8 caracteres. Si la instancia no existe, la crea y reintenta.
async function getQrCode(options = {}) {
  const baseURL = await requireConfig();
  const number = digitsOnly(options.number);
  const params = number ? { number } : undefined;
  const path = `/instance/connect/${encodeURIComponent(instanceName())}`;

  const connect = async () => {
    const { data } = await client(baseURL).get(path, { params });
    return data;
  };

  let created = false;
  let data;
  try {
    data = await connect();
  } catch (err) {
    if (isHostingFallback(err)) throw serviceError('obtener QR', err, baseURL);
    if (!isInstanceMissing(err)) throw serviceError('obtener QR', err, baseURL);
    logger.info(`La instancia ${instanceName()} no existe en Evolution API: se crea automaticamente`);
    await createInstance();
    created = true;
    try {
      data = await connect();
    } catch (err2) {
      throw serviceError('obtener QR tras crear la instancia', err2, baseURL);
    }
  }

  const result = normalizeConnect(data);
  const state = extractState(data);
  return {
    success: true,
    instance: instanceName(),
    created,
    mode: number ? 'pairing' : 'qr',
    status: state ? mapConnectionStatus(state) : 'CONNECTING',
    base64: result.base64,
    code: result.code,
    pairingCode: result.pairingCode,
    qrcode: result,
    // Evolution a veces responde {count:0} mientras prepara la sesion.
    pending: !result.base64 && !result.pairingCode && !result.code,
  };
}

// Registra (o actualiza) el webhook de la instancia YA existente para que
// Evolution API envie los mensajes al backend. Idempotente.
async function setWebhook(options = {}) {
  const baseURL = await requireConfig();
  const url = env.WEBHOOK_URL || options.url;
  if (!url) {
    const e = new Error('Falta WEBHOOK_URL: no se sabe a que direccion enviar los mensajes');
    e.status = 503;
    throw e;
  }
  const cfg = { enabled: true, url, byEvents: false, base64: false, events: WEBHOOK_EVENTS };
  if (env.WEBHOOK_SECRET) cfg.headers = { 'x-webhook-token': env.WEBHOOK_SECRET };
  const path = `/webhook/set/${encodeURIComponent(instanceName())}`;
  try {
    await client(baseURL).post(path, { webhook: cfg });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status !== 400 && status !== 422) throw serviceError('configurar webhook', err, baseURL);
    // Algunas versiones esperan el cuerpo sin el envoltorio "webhook".
    try {
      await client(baseURL).post(path, cfg);
    } catch (err2) {
      throw serviceError('configurar webhook', err2, baseURL);
    }
  }
  let verified = null;
  try {
    const { data } = await client(baseURL).get(`/webhook/find/${encodeURIComponent(instanceName())}`);
    const w = (data && data.webhook) || data || {};
    verified = Boolean(w.enabled && w.url === url);
  } catch (e) {
    /* la verificacion es informativa */
  }
  return { configured: true, verified, url, events: WEBHOOK_EVENTS, secretHeader: Boolean(env.WEBHOOK_SECRET) };
}

async function logoutInstance() {
  const baseURL = await requireConfig();
  try {
    const { data } = await client(baseURL).delete(`/instance/logout/${encodeURIComponent(instanceName())}`);
    return data;
  } catch (err) {
    if (isInstanceMissing(err)) return { status: 'SUCCESS', message: 'La instancia no existe; nada que cerrar' };
    throw serviceError('cerrar sesion', err, baseURL);
  }
}

async function sendTextMessage(phone, text) {
  const baseURL = await requireConfig();
  const raw = String(phone || '').trim();
  // Evolution API acepta un JID completo para chats @lid; no hay que
  // reducirlo a digitos porque entonces lo interpreta como un telefono.
  const number = raw.includes('@') ? raw : digitsOnly(raw);
  try {
    const { data } = await client(baseURL).post(`/message/sendText/${encodeURIComponent(instanceName())}`, {
      number,
      text,
    });
    return {
      externalMessageId: (data && data.key && data.key.id) || (data && data.messageId) || null,
      raw: data,
    };
  } catch (err) {
    throw serviceError('enviar mensaje', err, baseURL);
  }
}

// Nombre del contacto tal como lo tiene guardado el telefono vinculado
// (agenda de WhatsApp). Evolution API lo expone en chat/findContacts. Es
// "mejor esfuerzo": ante cualquier fallo devuelve null y no frena el bot.
async function findContactName(phoneOrJid) {
  try {
    const baseURL = await requireConfig();
    const raw = String(phoneOrJid || '').trim();
    if (!raw) return null;
    const jid = raw.includes('@') ? raw : `${digitsOnly(raw)}@s.whatsapp.net`;
    const { data } = await client(baseURL).post(
      `/chat/findContacts/${encodeURIComponent(instanceName())}`,
      { where: { remoteJid: jid } },
      { timeout: 4000 }
    );
    const list = Array.isArray(data) ? data : data && Array.isArray(data.contacts) ? data.contacts : [];
    const digits = digitsOnly(raw);
    for (const c of list) {
      const name = String((c && (c.pushName || c.name || c.verifiedName)) || '').trim();
      if (name.length >= 2 && /\p{L}/u.test(name) && name.replace(/\D/g, '') !== digits) return name.slice(0, 150);
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Borra un mensaje enviado por el bot para todos en WhatsApp (delete for
// everyone). Evolution API expone esto segun la version/edicion:
// se prueban todas las variantes conocidas y se informa si ninguna
// funciona (la version actual del servidor puede no traer la ruta).
async function revokeMessage({ externalId, chatJid, fromMe = true }) {
  const baseURL = await requireConfig();
  const inst = encodeURIComponent(instanceName());
  const key = { id: externalId, remoteJid: chatJid, fromMe: Boolean(fromMe) };
  const variantes = [
    ['delete', `/message/revoke/${inst}`, { key }],
    ['post', `/message/revoke/${inst}`, { key }],
    ['delete', `/chat/revokeMessage/${inst}`, { id: externalId, remoteJid: chatJid, fromMe: Boolean(fromMe) }],
    ['post', `/chat/revokeMessage/${inst}`, { id: externalId, remoteJid: chatJid, fromMe: Boolean(fromMe) }],
  ];
  let lastErr = null;
  for (const [method, path, body] of variantes) {
    try {
      await client(baseURL)[method](path, method === 'delete' ? { data: body } : body);
      return { revoked: true, endpoint: path };
    } catch (err) {
      lastErr = err;
      // 404 = la ruta no existe en esta version: probar la siguiente.
      // Otros errores (400/403/500) tambien: el cuerpo o el estado difieren.
    }
  }
  const detalle = serviceError('borrar en WhatsApp', lastErr, baseURL);
  return { revoked: false, error: detalle.message };
}

module.exports = {
  checkConnection,
  getConnectionState,
  createInstance,
  getQrCode,
  logoutInstance,
  setWebhook,
  sendTextMessage,
  findContactName,
  revokeMessage,
  mapConnectionStatus,
  getBaseUrl,
  clearUrlCache,
};
