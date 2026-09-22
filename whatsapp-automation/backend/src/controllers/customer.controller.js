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

    const updated = await customerModel.update(req.params.id, req.body);
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
