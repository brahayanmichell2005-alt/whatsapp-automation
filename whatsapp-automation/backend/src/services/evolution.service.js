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

const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'];

function instanceName() {
  return String(env.EVOLUTION_INSTANCE || '').trim();
}

function isConfigured() {
  return Boolean(env.EVOLUTION_API_URL && env.EVOLUTION_API_KEY && instanceName());
}

function missingConfig() {
  const missing = [];
  if (!env.EVOLUTION_API_URL) missing.push('EVOLUTION_API_URL');
  if (!env.EVOLUTION_API_KEY) missing.push('EVOLUTION_API_KEY');
  if (!instanceName()) missing.push('EVOLUTION_INSTANCE');
  return missing;
}

// Cliente creado en cada llamada: asi siempre usa las variables vigentes y
// nunca revienta al cargar el modulo si falta alguna.
function client() {
  return axios.create({
    baseURL: String(env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, ''),
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
  const status = err && err.response && err.response.status;
  if (status === 404) return true;
  return status === 400 && /does not exist|no existe|not found/i.test(upstreamMessage(err));
}

// Error seguro para el navegador: NUNCA reenvia 401/403 de Evolution (el panel
// los interpretaria como "sesion expirada" y cerraria la sesion del usuario).
function serviceError(step, err) {
  const upstream = err && err.response ? err.response.status : null;
  const timeout = err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT');
  const out = new Error(
    `Evolution API: fallo "${step}"${upstream ? ` (HTTP ${upstream})` : ''}: ${upstreamMessage(err)}`
  );
  out.status = timeout ? 504 : 502;
  out.upstreamStatus = upstream;
  return out;
}

function requireConfig() {
  if (!isConfigured()) {
    const e = new Error(`Evolution API sin configurar. Faltan variables: ${missingConfig().join(', ')}`);
    e.status = 503;
    throw e;
  }
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
  requireConfig();
  try {
    const { data } = await client().get(`/instance/connectionState/${encodeURIComponent(instanceName())}`);
    return data;
  } catch (err) {
    if (isInstanceMissing(err)) {
      const e = new Error('La instancia de WhatsApp todavia no existe en Evolution API');
      e.status = 404;
      e.instanceMissing = true;
      throw e;
    }
    throw serviceError('consultar estado', err);
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
    return { status: 'ERROR', reason: err.message };
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
  requireConfig();
  const body = {
    instanceName: instanceName(),
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    ...extra,
  };
  const webhook = webhookConfig();
  if (webhook) body.webhook = webhook;
  try {
    const { data } = await client().post('/instance/create', body);
    return data;
  } catch (err) {
    const status = err.response && err.response.status;
    // 403/409 "ya existe": otro proceso la creo antes -> se tolera.
    if ((status === 403 || status === 409) && /already|exist|in use|ya existe/i.test(upstreamMessage(err))) {
      return { instance: { instanceName: instanceName(), status: 'already_exists' } };
    }
    throw serviceError('crear instancia', err);
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
  requireConfig();
  const number = digitsOnly(options.number);
  const params = number ? { number } : undefined;
  const path = `/instance/connect/${encodeURIComponent(instanceName())}`;

  const connect = async () => {
    const { data } = await client().get(path, { params });
    return data;
  };

  let created = false;
  let data;
  try {
    data = await connect();
  } catch (err) {
    if (!isInstanceMissing(err)) throw serviceError('obtener QR', err);
    logger.info(`La instancia ${instanceName()} no existe en Evolution API: se crea automaticamente`);
    await createInstance();
    created = true;
    try {
      data = await connect();
    } catch (err2) {
      throw serviceError('obtener QR tras crear la instancia', err2);
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

async function logoutInstance() {
  requireConfig();
  try {
    const { data } = await client().delete(`/instance/logout/${encodeURIComponent(instanceName())}`);
    return data;
  } catch (err) {
    if (isInstanceMissing(err)) return { status: 'SUCCESS', message: 'La instancia no existe; nada que cerrar' };
    throw serviceError('cerrar sesion', err);
  }
}

async function sendTextMessage(phone, text) {
  requireConfig();
  const number = digitsOnly(phone);
  try {
    const { data } = await client().post(`/message/sendText/${encodeURIComponent(instanceName())}`, {
      number,
      text,
    });
    return {
      externalMessageId: (data && data.key && data.key.id) || (data && data.messageId) || null,
      raw: data,
    };
  } catch (err) {
    throw serviceError('enviar mensaje', err);
  }
}

module.exports = {
  checkConnection,
  getConnectionState,
  createInstance,
  getQrCode,
  logoutInstance,
  sendTextMessage,
  mapConnectionStatus,
};
