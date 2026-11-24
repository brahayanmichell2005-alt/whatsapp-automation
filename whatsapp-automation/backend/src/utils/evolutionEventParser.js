// Interpreta el payload crudo que envia Evolution API al webhook
// (Seccion 6, pasos 3-8). Aisla el formato especifico del proveedor
// del resto del sistema: si en el futuro cambia el formato del webhook,
// solo se toca este archivo.

// Tipos de evento que el sistema conoce y procesa activamente.
// Cualquier otro evento se ignora de forma segura (Seccion 6, ultima linea).
const KNOWN_EVENTS = new Set([
  'messages.upsert',
  'messages.update',
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

// ---------------------------------------------------------------------------
// Mensajes de "ver una vez"
// ---------------------------------------------------------------------------
// WhatsApp los entrega dentro de un sobre (viewOnceMessage / V2 / V2Extension)
// y a veces dentro de otro sobre (ephemeralMessage) si el chat usa mensajes
// temporales. Se detecta el sobre SIN abrir su contenido: el sistema no
// descarga, no descifra y no guarda el archivo, porque "ver una vez" es una
// promesa de privacidad del cliente. Solo se registra que llego.
const VIEW_ONCE_WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
const TRANSPARENT_WRAPPERS = ['ephemeralMessage', 'documentWithCaptionMessage'];
const MEDIA_KINDS = [
  ['IMAGE', 'imageMessage'],
  ['VIDEO', 'videoMessage'],
  ['AUDIO', 'audioMessage'],
  ['DOCUMENT', 'documentMessage'],
];

function viewOnceKind(inner) {
  if (!inner || typeof inner !== 'object') return 'OTHER';
  for (const [kind, key] of MEDIA_KINDS) {
    if (inner[key]) return kind;
  }
  return 'OTHER';
}

// Devuelve { subtype, wrapper } si el mensaje es de "ver una vez", o null.
// `subtype` solo describe el tipo (IMAGEN/VIDEO/AUDIO); nunca incluye la URL,
// la mediaKey ni el contenido.
function findViewOnce(message) {
  let current = message;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i += 1) {
    const wrapper = VIEW_ONCE_WRAPPERS.find((key) => current[key]);
    if (wrapper) {
      const inner = current[wrapper] && current[wrapper].message ? current[wrapper].message : current[wrapper];
      return { subtype: viewOnceKind(inner), wrapper };
    }
    // Algunos payloads no traen sobre y solo marcan el archivo con viewOnce.
    const direct = MEDIA_KINDS.find(([, key]) => current[key] && current[key].viewOnce === true);
    if (direct) return { subtype: direct[0], wrapper: null };
    const next = TRANSPARENT_WRAPPERS.map((key) => current[key] && current[key].message).find(Boolean);
    if (!next) break;
    current = next;
  }
  return null;
}

// Normaliza un evento "messages.upsert" a un objeto simple y estable
// que el resto del sistema puede consumir sin conocer el formato de Baileys.
function parseMessageUpsert(payload) {
  const entry = payload?.data;
  if (!entry) return null;

  const primaryJid = entry.key?.remoteJid;
  // Mensajes enviados por el propio telefono del dueno (fromMe) se ignoran
  // por completo: el bot no los registra ni responde. Asi el dueno puede
  // escribirse a si mismo (o el celular reenvia ecos de salidas) sin que la
  // IA conteste ni aparezcan chats fantasma en el panel. Los envios que hace
  // el bot por la API los registra el worker de envio, no este webhook.
  if (entry.key?.fromMe) return null;
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
  // "Ver una vez": se anota el tipo, pero jamas se extrae la media.
  const viewOnce = findViewOnce(message);

  return {
    fromMe,
    isGroup: isGroupJid(resolvedJid),
    phone: extractPhoneFromJid(resolvedJid),
    // Solo se guarda el JID completo cuando no hay telefono alternativo: en
    // ese caso el numero visible es un LID y no sirve para enviar.
    remoteJid: isLid && !phoneJid ? primaryJid : null,
    pushName: entry.pushName || null,
    externalMessageId,
    messageType: viewOnce ? 'OTHER' : detectMessageType(message),
    content: viewOnce ? null : extractTextContent(message),
    // Informacion del archivo adjunto (nota de voz, imagen, sticker...):
    // url cifrada del CDN + mediaKey para descifrarlo en el sistema.
    media: viewOnce ? null : extractMedia(message),
    viewOnce,
    timestamp: entry.messageTimestamp || null,
  };
}

// Normaliza un evento "connection.update" (cambios de estado de la instancia).
function parseConnectionUpdate(payload) {
  const entry = payload?.data;
  return {
    state: entry?.state || null,
    statusReason: entry?.statusReason !== undefined ? entry.statusReason : null,
  };
}

// ---------------------------------------------------------------------------
// messages.update -> cambios de estado (ACK) de los mensajes salientes.
// WhatsApp informa: enviado (SERVER_ACK), entregado (DELIVERY_ACK) y leido
// (READ). Se traducen a los estados que guarda la tabla messages.
// ---------------------------------------------------------------------------
const STATUS_BY_NAME = {
  ERROR: 'FAILED',
  PENDING: 'PENDING',
  SERVER_ACK: 'SENT',
  DELIVERY_ACK: 'DELIVERED',
  READ: 'READ',
  PLAYED: 'READ',
};

// Baileys tambien puede enviar el estado como numero (indice en esta lista).
const STATUS_NAMES_BY_INDEX = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];

function mapAckStatus(raw) {
  const name = typeof raw === 'number' ? STATUS_NAMES_BY_INDEX[raw] : String(raw || '').toUpperCase();
  return STATUS_BY_NAME[name] || null;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

// Devuelve [{ externalMessageId, status }] solo para actualizaciones utiles.
function parseMessagesUpdate(payload) {
  const updates = [];
  for (const item of toArray(payload && payload.data)) {
    if (!item || typeof item !== 'object') continue;

    const fromMe = item.fromMe !== undefined ? item.fromMe : item.key && item.key.fromMe;
    if (fromMe === false) continue; // estado de un mensaje entrante: no interesa

    const externalMessageId = item.keyId || (item.key && item.key.id);
    const status = mapAckStatus(item.status !== undefined ? item.status : item.update && item.update.status);
    if (!externalMessageId || !status || status === 'PENDING') continue;

    updates.push({ externalMessageId: String(externalMessageId), status });
  }
  return updates;
}

module.exports = {
  isKnownEvent,
  extractPhoneFromJid,
  isGroupJid,
  detectMessageType,
  extractTextContent,
  findViewOnce,
  parseMessageUpsert,
  parseMessagesUpdate,
  parseConnectionUpdate,
};
