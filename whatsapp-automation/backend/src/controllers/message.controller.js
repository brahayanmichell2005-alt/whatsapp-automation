// Controller de mensajes (Seccion 9 y Seccion 34 - API REST). Solo lectura:
// los mensajes se crean via webhook (entrantes) o via worker (salientes,
// Entrega 6), nunca directamente por el panel.

const messageModel = require('../models/message.model');

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    if (req.query.conversation_id) {
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

module.exports = { list, getById };
