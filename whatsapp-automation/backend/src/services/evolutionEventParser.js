// Parser de eventos de webhook de Evolution API (v2).
//
// Aisla el formato especifico del proveedor: el resto del sistema solo ve
// objetos normalizados. Son funciones PURAS (sin BD ni red), por lo que se
// pueden probar sin levantar nada (ver scripts/verify-webhook.js).
//
// Si Evolution API cambia su payload, solo hay que tocar este archivo.

const { phoneFromJid } = require('../utils/phone');

const EVENTS = {
  MESSAGES_UPSERT: 'messages.upsert',
  MESSAGES_UPDATE: 'messages.update',
  CONNECTION_UPDATE: 'connection.update',
};

// Limite de seguridad para el campo TEXT de MySQL (65.535 bytes; utf8mb4 usa
// hasta 4 bytes por caracter).
const MAX_CONTENT_LENGTH = 15000;

// ---------------------------------------------------------------------------
// Nombre del evento
// ---------------------------------------------------------------------------

// Evolution API expresa el mismo evento de tres formas:
//   body.event = "messages.upsert"          (cuerpo del webhook)
//   env/config = "MESSAGES_UPSERT"          (nombre de configuracion)
//   URL        = "/messages-upsert"         (modo "webhook por eventos")
// Todas se normalizan a "messages.upsert".
function normalizeEventName(bodyEvent, urlEvent) {
  const raw = bodyEvent || urlEvent;
  if (!raw) return null;
  return String(raw).trim().toLowerCase().replace(/[-_]/g, '.');
}

function toArray(data) {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 150);
  return name || null;
}

// ---------------------------------------------------------------------------
// Contenido del mensaje
// ---------------------------------------------------------------------------

// Contenedores que envuelven al mensaje real (mensajes temporales, "ver una
// sola vez", documentos con texto).
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
];

// Claves que acompanan a los mensajes pero no son contenido.
const NOISE_KEYS = ['messageContextInfo', 'senderKeyDistributionMessage'];

// Mensajes que NO son mensajes nuevos del cliente: no se registran.
const NON_MESSAGE_KEYS = {
  protocolMessage: 'protocol_message', // borrados, sincronizaciones internas
  reactionMessage: 'reaction',
  editedMessage: 'edited_message',
  pollUpdateMessage: 'poll_update',
};

function unwrapMessage(message) {
  let current = message;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i += 1) {
    const wrapper = WRAPPERS.find((key) => current[key] && current[key].message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current;
}

function clip(text) {
  return typeof text === 'string' ? text.slice(0, MAX_CONTENT_LENGTH) : null;
}

function describeLocation(loc) {
  const parts = [];
  if (loc.name) parts.push(loc.name);
  if (loc.address) parts.push(loc.address);
  if (loc.degreesLatitude !== undefined && loc.degreesLongitude !== undefined) {
    parts.push(`(${loc.degreesLatitude}, ${loc.degreesLongitude})`);
  }
  return parts.join(' ') || null;
}

// Devuelve { messageType, content } o { ignored: 'motivo' }.
// messageType usa los valores del ENUM de messages.message_type.
function extractContent(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return { ignored: 'empty_message' };

  const m = unwrapMessage(rawMessage);
  if (!m || typeof m !== 'object') return { ignored: 'empty_message' };

  // Primero descartar lo que no es un mensaje del cliente.
  for (const [key, reason] of Object.entries(NON_MESSAGE_KEYS)) {
    if (m[key]) return { ignored: reason };
  }

  if (typeof m.conversation === 'string') {
    return { messageType: 'TEXT', content: clip(m.conversation) };
  }
  if (m.extendedTextMessage) {
    return { messageType: 'TEXT', content: clip(m.extendedTextMessage.text) };
  }
  if (m.imageMessage) {
    return { messageType: 'IMAGE', content: clip(m.imageMessage.caption) };
  }
  if (m.videoMessage || m.ptvMessage) {
    return { messageType: 'VIDEO', content: clip((m.videoMessage || m.ptvMessage).caption) };
  }
  if (m.audioMessage) {
    return { messageType: 'AUDIO', content: null };
  }
  if (m.documentMessage) {
    const doc = m.documentMessage;
    return { messageType: 'DOCUMENT', content: clip(doc.caption || doc.fileName) };
  }
  if (m.locationMessage || m.liveLocationMessage) {
    return {
      messageType: 'LOCATION',
      content: clip(describeLocation(m.locationMessage || m.liveLocationMessage)),
    };
  }

  // Respuestas a botones / listas: llegan como texto para las reglas.
  if (m.buttonsResponseMessage) {
    const r = m.buttonsResponseMessage;
    return { messageType: 'TEXT', content: clip(r.selectedDisplayText || r.selectedButtonId) };
  }
  if (m.listResponseMessage) {
    const r = m.listResponseMessage;
    const rowId = r.singleSelectReply && r.singleSelectReply.selectedRowId;
    return { messageType: 'TEXT', content: clip(r.title || rowId) };
  }
  if (m.templateButtonReplyMessage) {
    const r = m.templateButtonReplyMessage;
    return { messageType: 'TEXT', content: clip(r.selectedDisplayText || r.selectedId) };
  }

  // Cualquier otro tipo con contenido (sticker, contacto, encuesta...) se
  // guarda como OTHER para no perder el rastro, sin contenido de texto.
  const remaining = Object.keys(m).filter((k) => !NOISE_KEYS.includes(k));
  if (remaining.length === 0) return { ignored: 'empty_message' };
  return { messageType: 'OTHER', content: null };
}

// ---------------------------------------------------------------------------
// messages.upsert  ->  mensajes entrantes
// ---------------------------------------------------------------------------

// Resuelve el telefono del remitente. Los JID normales
// ("51999888777@s.whatsapp.net") lo traen directo. WhatsApp esta migrando a
// identificadores "@lid" que NO contienen el telefono; en ese caso se intenta
// con los campos alternativos que Evolution API puede incluir.
function resolvePhone(key, item) {
  const direct = phoneFromJid(key.remoteJid);
  if (direct) return direct;

  if (typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@lid')) {
    const candidates = [key.remoteJidAlt, key.senderPn, item.remoteJidAlt, item.senderPn];
    for (const candidate of candidates) {
      const phone = phoneFromJid(candidate);
      if (phone) return phone;
    }
    return { unresolved: 'unresolved_lid' };
  }
  return null;
}

// Devuelve { ignored, externalMessageId? } o { message: {...} }.
function parseUpsertItem(item) {
  const key = item && item.key;
  if (!key || !key.id || !key.remoteJid) return { ignored: 'invalid_payload' };

  // Mensajes enviados por nosotros (por la API o desde el celular).
  // Los salientes los registra el worker de envio (Entrega 6).
  if (key.fromMe) return { ignored: 'from_me', externalMessageId: key.id };

  const jid = String(key.remoteJid);
  if (jid.endsWith('@g.us')) return { ignored: 'group', externalMessageId: key.id };
  if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
    return { ignored: 'broadcast', externalMessageId: key.id };
  }

  const phone = resolvePhone(key, item);
  if (phone && phone.unresolved) return { ignored: phone.unresolved, externalMessageId: key.id };
  if (!phone) return { ignored: 'invalid_jid', externalMessageId: key.id };

  const extracted = extractContent(item.message);
  if (extracted.ignored) return { ignored: extracted.ignored, externalMessageId: key.id };

  return {
    message: {
      externalMessageId: String(key.id),
      phone,
      pushName: cleanName(item.pushName),
      messageType: extracted.messageType,
      content: extracted.content,
    },
  };
}

// Evolution API normalmente envia un objeto en `data`; se acepta tambien un
// arreglo por robustez.
function parseMessagesUpsert(body) {
  return toArray(body && body.data).map(parseUpsertItem);
}

// ---------------------------------------------------------------------------
// messages.update  ->  cambios de estado de mensajes salientes
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

// Devuelve [{ externalMessageId, status }] solo para actualizaciones utiles.
function parseMessagesUpdate(body) {
  const updates = [];
  for (const item of toArray(body && body.data)) {
    if (!item || typeof item !== 'object') continue;

    const fromMe = item.fromMe !== undefined ? item.fromMe : item.key && item.key.fromMe;
    if (fromMe === false) continue; // estado de un mensaje entrante: no nos interesa

    const externalMessageId = item.keyId || (item.key && item.key.id);
    const status = mapAckStatus(item.status !== undefined ? item.status : item.update && item.update.status);
    if (!externalMessageId || !status || status === 'PENDING') continue;

    updates.push({ externalMessageId: String(externalMessageId), status });
  }
  return updates;
}

// ---------------------------------------------------------------------------
// connection.update  ->  estado de la conexion de WhatsApp
// ---------------------------------------------------------------------------

// Devuelve { state, statusReason } con el estado crudo de Evolution API
// (open | close | connecting); el mapeo a CONNECTED/DISCONNECTED lo hace
// evolution.service.mapConnectionStatus.
function parseConnectionUpdate(body) {
  const data = (body && body.data) || {};
  return {
    state: data.state || null,
    statusReason: data.statusReason !== undefined ? data.statusReason : null,
  };
}

module.exports = {
  EVENTS,
  MAX_CONTENT_LENGTH,
  normalizeEventName,
  extractContent,
  parseMessagesUpsert,
  parseMessagesUpdate,
  parseConnectionUpdate,
};
