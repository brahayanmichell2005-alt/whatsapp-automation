// Controller de conversaciones (Seccion 8 y Seccion 34 - API REST).

const conversationModel = require('../models/conversation.model');

const VALID_STATUSES = ['OPEN', 'PENDING', 'HUMAN', 'CLOSED'];

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || null;
    // Vista "chat": para el chat en vivo del panel, con nombre del cliente
    // y vista previa del ultimo mensaje.
    const conversations = req.query.view === 'chat'
      ? await conversationModel.listForChat({ limit, offset })
      : await conversationModel.list({ status, limit, offset });
    res.json(conversations);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const conversation = await conversationModel.findById(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversacion no encontrada' });
    res.json(conversation);
  } catch (err) {
    next(err);
  }
}

// Permite cambiar el estado (por ejemplo, derivar a un agente humano: Seccion 8)
// y opcionalmente asignar un agente.
async function update(req, res, next) {
  try {
    const existing = await conversationModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Conversacion no encontrada' });

    if (req.body.status && !VALID_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `status debe ser uno de: ${VALID_STATUSES.join(', ')}` });
    }

    if (
      req.body.assigned_to !== undefined
      && req.body.assigned_to !== null
      && !/^\d+$/.test(String(req.body.assigned_to))
    ) {
      return res.status(400).json({ error: 'assigned_to debe ser el id numerico de un usuario' });
    }

    const updated = await conversationModel.updateStatus(
      req.params.id,
      req.body.status || existing.status,
      { assignedTo: req.body.assigned_to }
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getById, update };
