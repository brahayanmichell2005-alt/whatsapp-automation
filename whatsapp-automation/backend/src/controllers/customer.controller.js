// Controller CRUD de clientes (Seccion 7 y Seccion 34 - API REST).

const customerModel = require('../models/customer.model');
const { validateCreateCustomer, validateUpdateCustomer } = require('../validators/customer.validator');

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const customers = await customerModel.list({ limit, offset });
    res.json(customers);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const customer = await customerModel.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(customer);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const { valid, errors } = validateCreateCustomer(req.body);
    if (!valid) return res.status(400).json({ errors });

    const existing = await customerModel.findByPhone(req.body.phone);
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un cliente con ese telefono', customer: existing });
    }

    const customer = await customerModel.create({
      phone: req.body.phone,
      name: req.body.name || null,
      email: req.body.email || null,
    });
    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { valid, errors } = validateUpdateCustomer(req.body);
    if (!valid) return res.status(400).json({ errors });

    const existing = await customerModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Suite de ventas: etapa de embudo, notas y pausa de IA por cliente.
    const FUNNEL_STAGES = ['NUEVO', 'NEGOCIANDO', 'CERRADO'];
    const body = { ...req.body };
    if (body.funnel_stage !== undefined) {
      if (!FUNNEL_STAGES.includes(body.funnel_stage)) {
        return res.status(400).json({ error: `funnel_stage debe ser uno de: ${FUNNEL_STAGES.join(', ')}` });
      }
    }
    if (body.notes !== undefined) {
      if (body.notes !== null && typeof body.notes !== 'string') {
        return res.status(400).json({ error: 'notes debe ser texto' });
      }
      body.notes = body.notes === null ? null : String(body.notes).slice(0, 4000);
    }
    if (body.ai_paused !== undefined) {
      body.ai_paused = body.ai_paused === true || body.ai_paused === 'true';
    }
    // Solo se pasan las claves de la suite que vinieron en el body; el resto
    // lo valida el validator de siempre.
    const suiteKeys = ['funnel_stage', 'notes', 'ai_paused'].filter((k) => body[k] !== undefined);
    const payload = {};
    for (const k of suiteKeys) payload[k] = body[k];
    if (req.body.name !== undefined) payload.name = req.body.name;
    if (req.body.email !== undefined) payload.email = req.body.email;
    if (req.body.status !== undefined) payload.status = req.body.status;
    if (req.body.interest_type !== undefined) payload.interest_type = req.body.interest_type;
    if (req.body.interest_level !== undefined) payload.interest_level = req.body.interest_level;

    const updated = await customerModel.update(req.params.id, payload);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const existing = await customerModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Cliente no encontrado' });

    await customerModel.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getById, create, update, remove };
