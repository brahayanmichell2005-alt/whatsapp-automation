// Controller de mensajes (Seccion 9 y Seccion 34 - API REST). Lectura para
// el panel y borrado desde la vista de chat en vivo. Los mensajes se crean
// via webhook (entrantes) o via worker (salientes), nunca directamente.

const messageModel = require('../models/message.model');
const conversationModel = require('../models/conversation.model');
const customerModel = require('../models/customer.model');
const evolutionService = require('../services/evolution.service');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    if (req.query.conversation_id) {
      if (!/^\d+$/.test(String(req.query.conversation_id))) {
        return res.status(400).json({ error: 'conversation_id debe ser un numero entero' });
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

module.exports = { list, getById, remove };
