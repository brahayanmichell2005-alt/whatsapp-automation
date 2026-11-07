// Controller de seguimientos (recordatorios del dueño en el panel).
// CRUD minimo: crear, listar pendientes, completar, borrar. Todo protegido
// con la sesion del panel (requireAuth).

const followUpModel = require('../models/followUp.model');

// Valida "YYYY-MM-DDTHH:mm" local del input datetime-local o ISO completo.
function parseRemindAt(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const d = new Date(raw.length === 16 && !/[Zz+]/.test(raw) ? `${raw}:00` : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function list(req, res, next) {
  try {
    const onlyDue = req.query.due === '1';
    const customerId = /^\d+$/.test(String(req.query.customer_id || ''))
      ? Number(req.query.customer_id)
      : null;
    const items = await followUpModel.listPending({ onlyDue, customerId });
    res.json(items);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const { customerId, remindAt, note } = req.body || {};
    const cid = Number(customerId);
    if (!Number.isInteger(cid) || cid <= 0) {
      return res.status(400).json({ error: 'customerId es requerido (numerico)' });
    }
    const when = parseRemindAt(remindAt);
    if (!when) {
      return res.status(400).json({ error: 'remindAt debe ser una fecha valida (YYYY-MM-DDTHH:mm)' });
    }
    const item = await followUpModel.create({
      customerId: cid,
      conversationId: Number.isInteger(Number(req.body.conversationId))
        ? Number(req.body.conversationId)
        : null,
      remindAt: when.toISOString(),
      note: typeof note === 'string' ? note : null,
    });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
}

async function markDone(req, res, next) {
  try {
    const item = await followUpModel.markDone(req.params.id);
    if (!item) return res.status(404).json({ error: 'Seguimiento no encontrado' });
    res.json(item);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const ok = await followUpModel.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Seguimiento no encontrado' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, markDone, remove };
