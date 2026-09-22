// Servicio de integracion con Evolution API (Seccion 21-22 del prompt maestro).
// Toda comunicacion con Evolution API pasa por aqui: crear/consultar instancia,
// obtener QR, comprobar conexion, enviar mensajes y procesar eventos.
// Nunca colocar API_KEY/tokens en el codigo: se leen desde config/env.js.

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

if (!env.EVOLUTION_API_URL) {
  logger.warn(
    'EVOLUTION_API_URL no esta configurado. El servicio de Evolution API no podra operar hasta definirlo en .env'
  );
}

const client = axios.create({
  baseURL: env.EVOLUTION_API_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    apikey: env.EVOLUTION_API_KEY,
  },
});

function instanceName() {
  return env.EVOLUTION_INSTANCE;
}

// Crea la instancia de WhatsApp en Evolution API (idempotente: si ya existe,
// Evolution API normalmente responde con un error controlado que se propaga
// como error de negocio, no como caida del sistema).
async function createInstance() {
  const { data } = await client.post('/instance/create', {
    instanceName: instanceName(),
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
  });
  return data;
}

// Solicita el estado de conexion actual (open/close/connecting) de la instancia.
async function getConnectionState() {
  const { data } = await client.get(`/instance/connectionState/${instanceName()}`);
  return data;
}

// Solicita el QR para vincular WhatsApp (Seccion 22, paso "Obtener QR").
async function getQrCode() {
  const { data } = await client.get(`/instance/connect/${instanceName()}`);
  return data;
}

// Cierra la sesion de WhatsApp de la instancia (util para reconectar desde cero).
async function logoutInstance() {
  const { data } = await client.delete(`/instance/logout/${instanceName()}`);
  return data;
}

// Traduce el estado crudo de Evolution API al vocabulario del panel
// (Seccion 22: CONECTADO / DESCONECTADO / CONECTANDO / ERROR).
function mapConnectionStatus(rawState) {
  const state = String(rawState || '').toLowerCase();
  if (state === 'open') return 'CONNECTED';
  if (state === 'connecting') return 'CONNECTING';
  if (state === 'close' || state === 'closed') return 'DISCONNECTED';
  return 'ERROR';
}

// Usado por el dashboard/healthcheck: nunca lanza, devuelve siempre un estado.
async function checkConnection() {
  if (!env.EVOLUTION_API_URL || !instanceName()) {
    return { status: 'ERROR', detail: 'EVOLUTION_API_URL o EVOLUTION_INSTANCE no configurados' };
  }
  try {
    const data = await getConnectionState();
    const rawState = data?.instance?.state || data?.state;
    return { status: mapConnectionStatus(rawState), detail: rawState || null };
  } catch (err) {
    logger.error({ err: err.message }, 'No se pudo consultar el estado de Evolution API');
    return { status: 'ERROR', detail: err.message };
  }
}

// Envia un mensaje de texto. Devuelve el id externo del mensaje cuando
// Evolution API lo entrega, para poder deduplicar en la tabla `messages`.
async function sendTextMessage(phone, message) {
  const { data } = await client.post(`/message/sendText/${instanceName()}`, {
    number: phone,
    text: message,
  });
  return {
    externalMessageId: data?.key?.id || null,
    raw: data,
  };
}

module.exports = {
  createInstance,
  getConnectionState,
  getQrCode,
  logoutInstance,
  checkConnection,
  sendTextMessage,
  mapConnectionStatus,
};
