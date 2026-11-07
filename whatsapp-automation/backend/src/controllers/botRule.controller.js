// Controller de reglas de chatbot (palabras clave -> respuesta automatica).
const botRuleModel = require('../models/botRule.model');
const logModel = require('../models/automationLog.model');

function sanitize(data) {
  const keyword = String(data.keyword || '').trim();
  const reply = String(data.reply || '').trim();
  if (!keyword) return { error: 'La palabra clave es obligatoria' };
  if (!reply) return { error: 'La respuesta automatica es obligatoria' };
  if (keyword.length > 200) return { error: 'La palabra clave supera los 200 caracteres' };
  if (reply.length > 1024) return { error: 'La respuesta supera los 1024 caracteres' };
  return {
    triggerType: data.triggerType === 'EXACT' ? 'EXACT' : 'CONTAINS',
    keyword,
    reply,
    active: data.active !== false,
    priority: Number.isInteger(data.priority) ? data.priority : 100,
  };
}

async function list(req, res, next) {
  try {
    res.json(await botRuleModel.list());
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const clean = sanitize(req.body || {});
    if (clean.error) return res.status(400).json({ error: clean.error });
    const rule = await botRuleModel.create(clean);
    await logModel.record({
      eventType: 'bot_rule_created',
      level: 'INFO',
      message: `Regla de chatbot creada: "${rule.keyword}" (${rule.triggerType})`,
      metadata: { ruleId: rule.id },
    });
    res.status(201).json(rule);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await botRuleModel.getById(id);
    if (!existing) return res.status(404).json({ error: 'Regla no encontrada' });
    const clean = sanitize(req.body || {});
    if (clean.error) return res.status(400).json({ error: clean.error });
    const rule = await botRuleModel.update(id, clean);
    res.json(rule);
  } catch (err) {
    next(err);
  }
}

async function setActive(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await botRuleModel.getById(id);
    if (!existing) return res.status(404).json({ error: 'Regla no encontrada' });
    const rule = await botRuleModel.setActive(id, !!(req.body || {}).active);
    res.json(rule);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const ok = await botRuleModel.remove(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Regla no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// Prueba una regla/cliente sin enviar nada: responde si coincidiria.
async function test(req, res) {
  const text = String((req.body || {}).text || '');
  const rule = await botRuleModel.match(text);
  res.json({
    matched: !!rule,
    rule: rule ? { id: rule.id, keyword: rule.keyword, triggerType: rule.triggerType, reply: rule.reply } : null,
  });
}

module.exports = { list, create, update, setActive, remove, test };
