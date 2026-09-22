// Interpreta el payload crudo que envia Evolution API al webhook
// (Seccion 6, pasos 3-8). Aisla el formato especifico del proveedor
// del resto del sistema: si en el futuro cambia el formato del webhook,
// solo se toca este archivo.

// Tipos de evento que el sistema conoce y procesa activamente.
// Cualquier otro evento se ignora de forma segura (Seccion 6, ultima linea).
const KNOWN_EVENTS = new Set([
  'messages.upsert',
  'connection.update',
  'qrcode.updated',
]);

function isKnownEvent(eventName) {
  return KNOWN_EVENTS.has(eventName);
}

// remoteJid llega como "51999000111@s.whatsapp.net" o "...@g.us" para grupos.
function extractPhoneFromJid(jid) {
  if (!jid) return null;
  return jid.split('@')[0];
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

// Detecta el tipo de mensaje a partir del objeto `message` de Baileys/Evolution.
function detectMessageType(message) {
  if (!message) return 'OTHER';
  if (message.conversation || message.extendedTextMessage) return 'TEXT';
  if (message.imageMessage) return 'IMAGE';
  if (message.audioMessage) return 'AUDIO';
  if (message.videoMessage) return 'VIDEO';
  if (message.documentMessage) return 'DOCUMENT';
  if (message.locationMessage) return 'LOCATION';
  return 'OTHER';
}

// Extrae el texto legible del mensaje, cuando existe.
function extractTextContent(message) {
  if (!message) return null;
  if (typeof message.conversation === 'string') return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}

// Normaliza un evento "messages.upsert" a un objeto simple y estable
// que el resto del sistema puede consumir sin conocer el formato de Baileys.
function parseMessageUpsert(payload) {
  const entry = payload?.data;
  if (!entry) return null;

  const remoteJid = entry.key?.remoteJid;
  const fromMe = Boolean(entry.key?.fromMe);
  const externalMessageId = entry.key?.id || null;
  const message = entry.message || null;

  return {
    fromMe,
    isGroup: isGroupJid(remoteJid),
    phone: extractPhoneFromJid(remoteJid),
    pushName: entry.pushName || null,
    externalMessageId,
    messageType: detectMessageType(message),
    content: extractTextContent(message),
    timestamp: entry.messageTimestamp || null,
  };
}

// Normaliza un evento "connection.update" (cambios de estado de la instancia).
function parseConnectionUpdate(payload) {
  const entry = payload?.data;
  return {
    state: entry?.state || null,
    statusReason: entry?.statusReason || null,
  };
}

module.exports = {
  isKnownEvent,
  extractPhoneFromJid,
  isGroupJid,
  detectMessageType,
  extractTextContent,
  parseMessageUpsert,
  parseConnectionUpdate,
};
