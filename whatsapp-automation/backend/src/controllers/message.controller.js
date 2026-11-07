// Controller de mensajes (Seccion 9 y Seccion 34 - API REST). Lectura para
// el panel y borrado desde la vista de chat en vivo. Los mensajes se crean
// via webhook (entrantes) o via worker (salientes), nunca directamente.

const messageModel = require('../models/message.model');
const conversationModel = require('../models/conversation.model');
const customerModel = require('../models/customer.model');
const queueModel = require('../models/messageQueue.model');
const evolutionService = require('../services/evolution.service');
const mediaService = require('../services/media.service');
const aiService = require('../services/ai.service');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

// Contexto compartido por sugerencias y resumen: historial reciente de la
// conversacion en formato de transcripcion.
async function buildTranscript(conversationId, limit = 30) {
  const history = (await messageModel.listRecentByConversation(conversationId, limit)) || [];
  return history
    .map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Bot'}: ${String(m.content || '').trim()}`)
    .filter((t) => t.length > 2)
    .join('\n');
}

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    if (req.query.conversation_id) {
      if (!/^\d+$/.test(String(req.query.conversation_id))) {
        return res.status(400).json({ error: 'conversation_id debe ser un numero entero' });
      }
      // Chat en vivo: con since_id el panel pide SOLO los mensajes nuevos
      // (polling incremental: sin duplicados ni recargar el historial).
      if (req.query.since_id && /^\d+$/.test(String(req.query.since_id))) {
        const fresh = await messageModel.listSince(
          req.query.conversation_id,
          req.query.since_id,
          { limit }
        );
        return res.json(fresh);
      }
      const messages = await messageModel.listByConversation(req.query.conversation_id, {
        limit,
        offset,
      });
      return res.json(messages);
    }

    const messages = await messageModel.list({ limit, offset });
    res.json(messages);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const message = await messageModel.findById(req.params.id);
    if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });
    res.json(message);
  } catch (err) {
    next(err);
  }
}

// Borrado desde la vista de chat en vivo. Borra el mensaje del panel y, si
// fue enviado por el bot, intenta borrarlo tambien en WhatsApp para todos.
// Los mensajes recibidos solo se pueden borrar del panel (WhatsApp no
// permite que un tercero borre mensajes de otra persona).
async function remove(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!/^\d+$/.test(String(req.params.id)) || Number.isNaN(id)) {
      return res.status(400).json({ error: 'id invalido' });
    }
    const message = await messageModel.findById(id);
    if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });

    const conversation = await conversationModel.findById(message.conversation_id);
    const customer = conversation
      ? await customerModel.findById(conversation.customer_id)
      : null;

    let whatsappRevoked = false;
    let whatsappError = null;
    if (message.direction === 'OUTBOUND' && message.external_message_id && customer) {
      const digits = String(customer.phone || '').replace(/\D/g, '');
      const chatJid = customer.remote_jid || (digits ? `${digits}@s.whatsapp.net` : null);
      if (chatJid) {
        try {
          const result = await evolutionService.revokeMessage({
            externalId: message.external_message_id,
            chatJid,
            fromMe: true,
          });
          whatsappRevoked = Boolean(result.revoked);
          if (!whatsappRevoked) whatsappError = result.error || null;
        } catch (err) {
          whatsappError = err.message;
          logger.warn({ err: err.message, messageId: id }, 'Fallo el borrado del mensaje en WhatsApp');
        }
      }
    }

    await messageModel.remove(id);
    await logModel.record({
      eventType: 'message_deleted',
      level: 'INFO',
      message: `Mensaje ${id} borrado del panel${whatsappRevoked ? ' y de WhatsApp' : ''}${
        whatsappError ? ' (WhatsApp: la API no soporta el borrado en esta version)' : ''
      }`,
      metadata: { messageId: id, whatsappRevoked },
    });

    res.json({ ok: true, deletedFromPanel: true, whatsappRevoked, whatsappError: whatsappError || null });
  } catch (err) {
    next(err);
  }
}

// Envio desde el panel (operador humano). Difiere de la respuesta automatica:
// cancela la respuesta pendiente de la IA para que bot y operador no manden
// cosas contradictorias a la vez, envia por WhatsApp y registra el mensaje
// como OUTBOUND con marca de origen PANEL (Seccion 5 y 6 del modulo).
async function send(req, res, next) {
  try {
    const conversationId = parseInt(req.body.conversation_id, 10);
    const text = String(req.body.text || '').trim();
    if (!/^\d+$/.test(String(req.body.conversation_id)) || Number.isNaN(conversationId)) {
      return res.status(400).json({ error: 'conversation_id debe ser un numero entero' });
    }
    if (!text) return res.status(400).json({ error: 'El texto no puede estar vacio' });
    if (text.length > 4096) {
      return res.status(400).json({ error: 'El mensaje supera el limite de 4096 caracteres' });
    }

    const conversation = await conversationModel.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversacion no encontrada' });
    const customer = await customerModel.findById(conversation.customer_id);
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado' });

    // La respuesta automatica pendiente pierde sentido si el operador
    // respondio a mano: se cancela antes de enviar.
    await queueModel.cancelPendingByCustomer(customer.id);

    // Los chats @lid no tienen telefono real: se usa el JID guardado.
    const recipient = customer.remote_jid || customer.phone;
    const connection = await evolutionService.checkConnection();
    if (connection.status !== 'CONNECTED') {
      return res.status(503).json({ error: 'WhatsApp no esta conectado. Escanea el QR en la pestana Estado.' });
    }
    const result = await evolutionService.sendTextMessage(recipient, text);

    const message = await messageModel.create({
      conversationId: conversation.id,
      customerId: customer.id,
      direction: 'OUTBOUND',
      messageType: 'TEXT',
      content: text,
      externalMessageId: result.externalMessageId,
      status: 'SENT',
    });
    await conversationModel.touchLastMessage(conversation.id);
    await customerModel.touchLastMessage(customer.id);

    await logModel.record({
      eventType: 'panel_send',
      level: 'INFO',
      message: `Mensaje enviado desde el panel a ${customer.phone}`,
      metadata: { messageId: message.id, conversationId: conversation.id },
    });

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
}

// Sirve el archivo multimedia de un mensaje (audio, imagen, sticker, video o
// documento) para pintarlo en el panel. Autenticacion: Bearer normal o
// ?token= en la URL (necesario para <img>/<audio>, que no pueden mandar
// cabeceras). Orden de fuentes: 1) bytes guardados en llegada (media_data,
// siempre disponibles), 2) descifrado on-demand del CDN de WhatsApp
// (mensajes viejos anteriores al almacenamiento, mientras la URL siga viva).
// Sin session no hay archivo: nada queda expuesto.
const MIME_BY_KIND = {
  AUDIO: 'audio/ogg',
  IMAGE: 'image/jpeg',
  STICKER: 'image/webp',
  VIDEO: 'video/mp4',
  DOCUMENT: 'application/octet-stream',
};

const EXT_BY_MIME = {
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
};

function contentDisposition(req, message) {
  if (!req.query.download) return 'inline';
  const meta = message.media_meta || {};
  const base = String(meta.fileName || `archivo${EXT_BY_MIME[message.media_mime] || ''}`)
    .replace(/[^\w.\-() ]/g, '_')
    .slice(0, 120);
  return `attachment; filename="${base}"`;
}

async function media(req, res, next) {
  try {
    const message = await messageModel.getMediaData(req.params.id);
    if (!message || (!message.media_data && !message.media_url)) {
      return res.status(404).json({ error: 'El mensaje no tiene archivo multimedia' });
    }

    // 1) Bytes guardados en llegada: siempre disponibles, sin depender del CDN.
    if (message.media_data) {
      const bytes = Buffer.from(message.media_data);
      res.setHeader('Content-Type', message.media_mime || MIME_BY_KIND[message.media_kind] || 'application/octet-stream');
      // must-revalidate: los bytes de la BD no cambian, pero si un dia quedara
      // una entrada corrupta en cache, el navegador la refresca en vez de
      // quedarse 24 h mostrando basura.
      res.setHeader('Cache-Control', 'private, max-age=3600, must-revalidate');
      res.setHeader('Content-Disposition', contentDisposition(req, message));
      res.setHeader('Content-Length', bytes.length);
      return res.send(bytes);
    }

    // 2) Mensajes anteriores al almacenamiento: descifrar del CDN si aun vive.
    const decrypted = await mediaService.decryptMedia({
      kind: message.media_kind || 'IMAGE',
      url: message.media_url,
      mediaKey: message.media_key,
    });
    if (!decrypted) {
      return res.status(410).json({ error: 'Archivo no disponible (la URL de WhatsApp ya vencio)' });
    }
    res.setHeader('Content-Type', message.media_mime || MIME_BY_KIND[message.media_kind] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600, must-revalidate');
    res.setHeader('Content-Disposition', contentDisposition(req, message));
    // Auto-cache: la primera vez que el panel descarga del CDN, los bytes
    // quedan en la BD. Asi el sticker/foto/audio/documento sigue visible
    // incluso cuando la URL de WhatsApp expire (dias despues).
    messageModel.cacheMediaData(req.params.id, decrypted.buffer, message.media_mime);
    res.send(decrypted.buffer);
  } catch (err) {
    next(err);
  }
}

// Respuesta SUGERIDA por la IA para la conversacion: solo se propone, NUNCA
// se envia (diferencia explicita entre propuesta y mensaje real, Seccion 5).
async function suggestions(req, res, next) {
  try {
    const conversationId = parseInt(req.query.conversation_id, 10);
    if (!/^\d+$/.test(String(req.query.conversation_id)) || Number.isNaN(conversationId)) {
      return res.status(400).json({ error: 'conversation_id debe ser un numero entero' });
    }
    const conversation = await conversationModel.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversacion no encontrada' });
    const customer = await customerModel.findById(conversation.customer_id);

    if (!aiService.isEnabled()) {
      return res.status(503).json({ error: 'La IA no esta configurada' });
    }
    const transcript = await buildTranscript(conversationId);
    if (!transcript) {
      return res.json({ suggestion: null, reason: 'La conversacion todavia no tiene mensajes' });
    }
    let text = null;
    try {
      text = await aiService.chat(
        'Eres el asistente de WhatsApp de un negocio. Con la conversacion, redacta UNA respuesta corta, natural y en espanol para el cliente. Responde unicamente con el texto del mensaje, sin comillas, sin explicaciones y sin decir que eres una IA.',
        [{ role: 'user', content: `Conversacion reciente:\n${transcript}\n\nRedacta la siguiente respuesta como el Bot.` }],
        1000
      );
    } catch (err) {
      logger.warn({ err: err.message, conversationId }, 'La IA no pudo generar una sugerencia');
      await logModel.record({
        eventType: 'ai_suggestion_failed',
        level: 'WARN',
        message: `Sugerencia falló: ${err.message}`,
        metadata: { conversationId },
      }).catch(() => {});
    }
    res.json({ suggestion: (text || '').trim() || null, reason: text ? null : 'La IA no respondio, intenta de nuevo' });
  } catch (err) {
    next(err);
  }
}

// Resumen de la conversacion para el panel contextual (Seccion 5).
async function summary(req, res, next) {
  try {
    const conversationId = parseInt(req.query.conversation_id, 10);
    if (!/^\d+$/.test(String(req.query.conversation_id)) || Number.isNaN(conversationId)) {
      return res.status(400).json({ error: 'conversation_id debe ser un numero entero' });
    }
    const conversation = await conversationModel.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversacion no encontrada' });

    if (!aiService.isEnabled()) {
      return res.status(503).json({ error: 'La IA no esta configurada' });
    }
    const transcript = await buildTranscript(conversationId, 50);
    if (!transcript) {
      return res.json({ summary: null, reason: 'La conversacion todavia no tiene mensajes' });
    }
    let text = null;
    try {
      text = await aiService.chat(
        'Eres un asistente que resume conversaciones de WhatsApp para el operador del panel. Escribe un resumen breve en espanol (3-5 lineas): de que habla la conversacion, que pide el cliente y si hay algo pendiente por resolver. Solo el resumen, sin saludos.',
        [{ role: 'user', content: `Conversacion:\n${transcript}\n\nResume la conversacion para el operador.` }],
        1000
      );
    } catch (err) {
      logger.warn({ err: err.message, conversationId }, 'La IA no pudo resumir la conversacion');
      await logModel.record({
        eventType: 'ai_summary_failed',
        level: 'WARN',
        message: `Resumen falló: ${err.message}`,
        metadata: { conversationId },
      }).catch(() => {});
    }
    res.json({ summary: (text || '').trim() || null, reason: text ? null : 'La IA no respondio, intenta de nuevo' });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getById, remove, send, media, suggestions, summary };
