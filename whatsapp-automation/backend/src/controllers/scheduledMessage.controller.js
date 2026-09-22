const scheduledModel = require('../models/scheduledMessage.model');
const customerModel = require('../models/customer.model');
const { validateCreateScheduledMessage } = require('../validators/scheduledMessage.validator');

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || null;
    const items = await scheduledModel.list({ status, limit, offset });
    res.json(items);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const { valid, errors } = validateCreateScheduledMessage(req.body);
    if (!valid) return res.status(400).json({ errors });

    const customer = await customerModel.findById(req.body.customer_id);
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado' });

    const scheduled = await scheduledModel.create({
      customerId: req.body.customer_id,
      phone: req.body.phone,
      message: req.body.message,
      scheduledAt: new Date(req.body.scheduled_at),
    });
    res.status(201).json(scheduled);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const existing = await scheduledModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Mensaje programado no encontrado' });
    if (existing.status !== 'SCHEDULED') {
      return res.status(409).json({ error: `No se puede editar un mensaje en estado ${existing.status}` });
    }

    const scheduledAt = req.body.scheduled_at ? new Date(req.body.scheduled_at) : undefined;
    const updated = await scheduledModel.update(req.params.id, {
      message: req.body.message,
      scheduledAt,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const existing = await scheduledModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Mensaje programado no encontrado' });

    const cancelled = await scheduledModel.cancel(req.params.id);
    res.json(cancelled);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove };
