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

const { extractMedia } = require('../services/media.service');

function isKnownEvent(eventName) {
  return KNOWN_EVENTS.has(eventName);
}

// remoteJid llega como "51999000111@s.whatsapp.net" o "...@g.us" para grupos.
function extractPhoneFromJid(jid) {
  if (!jid) return null;
  // Algunos payloads agregan el sufijo de dispositivo: "51999...:12@s.whatsapp.net"
  return jid.split('@')[0].split(':')[0];
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

  const primaryJid = entry.key?.remoteJid;
  const isPhoneJid = (jid) =>
    typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
  const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
  // WhatsApp puede enviar un JID @lid (identificador interno) y el telefono
  // real en remoteJidAlt. Cuando existe un telefono alternativo se responde
  // por telefono; cuando no existe, hay que conservar el JID @lid completo
  // para que Evolution API pueda entregar la respuesta.
  const phoneJid = [
    entry.key?.remoteJidAlt,
    entry.remoteJidAlt,
    entry.key?.senderPn,
    entry.senderPn,
  ].find(isPhoneJid);
  const isLid = isLidJid(primaryJid);
  const resolvedJid = isLid && phoneJid ? phoneJid : primaryJid;
  const fromMe = Boolean(entry.key?.fromMe);
  const externalMessageId = entry.key?.id || null;
  const message = entry.message || null;

  return {
    fromMe,
    isGroup: isGroupJid(resolvedJid),
    phone: extractPhoneFromJid(resolvedJid),
    // Solo se guarda el JID completo cuando no hay telefono alternativo: en
    // ese caso el numero visible es un LID y no sirve para enviar.
    remoteJid: isLid && !phoneJid ? primaryJid : null,
    pushName: entry.pushName || null,
    externalMessageId,
    messageType: detectMessageType(message),
    content: extractTextContent(message),
    // Informacion del archivo adjunto (nota de voz, imagen, sticker...):
    // url cifrada del CDN + mediaKey para descifrarlo en el sistema.
    media: extractMedia(message),
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
