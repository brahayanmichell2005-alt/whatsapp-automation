// Controller del gestor de plantillas (Message Templates).
//
// CRUD de plantillas + despacho: POST /:id/send sustituye las variables
// {{1}}, {{2}}... con los valores recibidos, crea/recupera el cliente y
// pone el mensaje en la COLA REAL de salida (message_queue), igual que
// cualquier otro envio del sistema. Nada simulado.
const templateModel = require('../models/messageTemplate.model');
const customerModel = require('../models/customer.model');
const queueModel = require('../models/messageQueue.model');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

// Express 4 no captura errores de handlers async: sin esto, un fallo de DB
// deja la request colgada hasta el timeout de Vercel en vez de responder 500.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function extractVariables(text) {
  const matches = String(text || '').match(/\{\{([a-zA-Z0-9_-]+)\}\}/g) || [];
  return Array.from(new Set(matches.map((m) => m.replace(/[{}]/g, ''))));
}

// Sustituye {{clave}} por su valor (los que falten quedan como estan).
function substitute(text, values) {
  return String(text || '').replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (match, key) => {
    const v = values && values[key];
    return v === undefined || v === null || String(v).trim() === '' ? match : String(v);
  });
}

function cleanName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 80);
}

function sanitizeBody(data) {
  const body = String(data.body || '').trim();
  if (!body) return { error: 'El cuerpo del mensaje es obligatorio' };
  if (body.length > 1024) return { error: 'El cuerpo supera los 1024 caracteres de WhatsApp' };
  return { body };
}

function sanitizeButtons(buttons) {
  const list = Array.isArray(buttons) ? buttons : [];
  if (list.length > 3) return { error: 'WhatsApp permite maximo 3 botones por plantilla' };
  const clean = [];
  for (const b of list) {
    const text = String(b.text || '').trim();
    if (!text) continue;
    const type = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(b.type) ? b.type : 'QUICK_REPLY';
    clean.push({
      id: b.id || 'btn-' + Date.now() + '-' + clean.length,
      type,
      text: text.slice(0, 60),
      url: type === 'URL' ? String(b.url || '').slice(0, 400) : undefined,
      phoneNumber: type === 'PHONE_NUMBER' ? String(b.phoneNumber || '').replace(/[^\d+]/g, '') : undefined,
    });
  }
  return { buttons: clean };
}

async function list(req, res) {
  const templates = await templateModel.list();
  res.json(templates);
}

async function create(req, res) {
  const data = req.body || {};
  const name = cleanName(data.name);
  if (!name) return res.status(400).json({ error: 'El nombre tecnico (snake_case) es obligatorio' });

  const bodyCheck = sanitizeBody(data);
  if (bodyCheck.error) return res.status(400).json({ error: bodyCheck.error });
  const btnCheck = sanitizeButtons(data.buttons);
  if (btnCheck.error) return res.status(400).json({ error: btnCheck.error });

  const dup = await templateModel.getByName(name);
  if (dup) return res.status(409).json({ error: `Ya existe una plantilla con el nombre "${name}"` });

  const created = await templateModel.create({
    name,
    title: String(data.title || name).trim().slice(0, 120),
    category: ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(data.category) ? data.category : 'UTILITY',
    language: String(data.language || 'es').slice(0, 12),
    status: ['APPROVED', 'PENDING', 'DRAFT', 'REJECTED'].includes(data.status) ? data.status : 'APPROVED',
    headerType: ['NONE', 'TEXT', 'IMAGE', 'DOCUMENT'].includes(data.headerType) ? data.headerType : 'NONE',
    headerContent: String(data.headerContent || '').slice(0, 300),
    body: bodyCheck.body,
    footer: String(data.footer || '').slice(0, 120),
    buttons: btnCheck.buttons,
    variables: extractVariables(bodyCheck.body),
    sampleValues: data.sampleValues || {},
  });
  await logModel.record({
    eventType: 'template_created',
    level: 'INFO',
    message: `Plantilla "${created.name}" creada`,
    metadata: { templateId: created.id },
  });
  res.status(201).json(created);
}

async function update(req, res) {
  const id = Number(req.params.id);
  const existing = await templateModel.getById(id);
  if (!existing) return res.status(404).json({ error: 'Plantilla no encontrada' });

  const data = req.body || {};
  const name = cleanName(data.name) || existing.name;
  const bodyCheck = sanitizeBody({ body: data.body ?? existing.body });
  if (bodyCheck.error) return res.status(400).json({ error: bodyCheck.error });
  const btnCheck = sanitizeButtons(data.buttons ?? existing.buttons);
  if (btnCheck.error) return res.status(400).json({ error: btnCheck.error });

  const dup = await templateModel.getByName(name);
  if (dup && dup.id !== id) return res.status(409).json({ error: `El nombre "${name}" ya esta en uso por otra plantilla` });

  const updated = await templateModel.update(id, {
    name,
    title: String(data.title ?? existing.title).trim().slice(0, 120),
    category: ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(data.category) ? data.category : existing.category,
    language: String(data.language ?? existing.language).slice(0, 12),
    status: ['APPROVED', 'PENDING', 'DRAFT', 'REJECTED'].includes(data.status) ? data.status : existing.status,
    headerType: ['NONE', 'TEXT', 'IMAGE', 'DOCUMENT'].includes(data.headerType) ? data.headerType : existing.headerType,
    headerContent: String(data.headerContent ?? existing.headerContent).slice(0, 300),
    body: bodyCheck.body,
    footer: String(data.footer ?? existing.footer).slice(0, 120),
    buttons: btnCheck.buttons,
    variables: extractVariables(bodyCheck.body),
    sampleValues: data.sampleValues ?? existing.sampleValues,
  });
  res.json(updated);
}

async function remove(req, res) {
  const id = Number(req.params.id);
  const ok = await templateModel.remove(id);
  if (!ok) return res.status(404).json({ error: 'Plantilla no encontrada' });
  await logModel.record({
    eventType: 'template_deleted',
    level: 'WARN',
    message: `Plantilla #${id} eliminada`,
    metadata: { templateId: id },
  });
  res.json({ ok: true });
}

// Despacho real: sustituye variables y encola en message_queue.
async function send(req, res) {
  const id = Number(req.params.id);
  const tpl = await templateModel.getById(id);
  if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada' });

  const phone = String((req.body || {}).phone || '').replace(/[^\d]/g, '');
  const values = (req.body || {}).variables || {};
  if (!phone) return res.status(400).json({ error: 'Falta el numero de telefono de destino' });

  const finalText = substitute(tpl.body, values).slice(0, 4096);
  const customer = await customerModel.findOrCreateByPhone(phone, null, null);

  const item = await queueModel.enqueue({
    customerId: customer.id,
    phone: customer.phone,
    message: finalText,
  });
  await templateModel.incrementUsage(id);
  await logModel.record({
    eventType: 'template_dispatched',
    level: 'INFO',
    message: `Plantilla "${tpl.name}" encolada para ${customer.phone}`,
    metadata: { templateId: id, queueItemId: item.id },
  });

  res.json({
    ok: true,
    queueItemId: item.id,
    phone: customer.phone,
    finalText,
    note: 'El mensaje quedo en la cola de salida y se enviara al procesar la cola (respeta limites y horarios).',
  });
}

module.exports = { list: wrap(list), create: wrap(create), update: wrap(update), remove: wrap(remove), send: wrap(send), extractVariables, substitute };
