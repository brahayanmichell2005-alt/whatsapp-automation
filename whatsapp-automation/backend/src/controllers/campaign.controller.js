// Controller de campanas masivas. Crea la campana, resuelve la audiencia
// entre los clientes REALES de la base y encola un mensaje por cliente en
// message_queue. El envio lo hace el worker de siempre (con limites y
// anti-ban). Progreso = conteo real de la cola.
const campaignModel = require('../models/campaign.model');
const customerModel = require('../models/customer.model');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

const MAX_RECIPIENTS = 500; // proteccion anti-ban: tope por campana

async function list(req, res, next) {
  try {
    const campaigns = await campaignModel.list();
    // Progreso en vivo por campana (lee la cola de salida real)
    const withProgress = await Promise.all(
      campaigns.map(async (c) => {
        const p = await campaignModel.progress(c.id);
        const sent = p.SENT || 0;
        const failed = p.FAILED || 0;
        const status = p.total > 0 && sent + failed >= p.total ? 'COMPLETED' : (p.total > 0 ? 'SENDING' : c.status);
        return { ...c, sent, failed, pending: (p.PENDING || 0) + (p.PROCESSING || 0), status };
      })
    );
    res.json(withProgress);
  } catch (err) {
    next(err);
  }
}

// Audiencia: { mode: 'ALL' | 'FILTER' | 'LIST', statuses: [], interestTypes: [], customerIds: [] }
async function resolveAudience(audience = {}) {
  const mode = ['ALL', 'FILTER', 'LIST'].includes(audience.mode) ? audience.mode : 'ALL';
  if (mode === 'LIST') {
    const ids = (audience.customerIds || []).map(Number).filter(Number.isFinite);
    return customerModel.listByIds(ids);
  }
  // ALL y FILTER leen clientes activos (no bloqueados/archivados)
  const statuses = Array.isArray(audience.statuses) && audience.statuses.length
    ? audience.statuses : ['ACTIVE'];
  const interestTypes = Array.isArray(audience.interestTypes) && audience.interestTypes.length
    ? audience.interestTypes : null;
  const all = await customerModel.list({ limit: 1000 });
  return all.filter((c) => {
    if (!statuses.includes(c.status)) return false;
    if (interestTypes && !interestTypes.includes(c.interest_type)) return false;
    return true;
  });
}

async function create(req, res, next) {
  try {
    const data = req.body || {};
    const name = String(data.name || '').trim().slice(0, 120);
    const message = String(data.message || '').trim();
    if (!name) return res.status(400).json({ error: 'El nombre de la campana es obligatorio' });
    if (!message) return res.status(400).json({ error: 'El mensaje de la campana es obligatorio' });
    if (message.length > 4096) return res.status(400).json({ error: 'El mensaje supera los 4096 caracteres' });

    const recipients = await resolveAudience(data.audience);
    if (!recipients.length) {
      return res.status(400).json({ error: 'La audiencia seleccionada no tiene clientes. Agrega contactos o cambia el filtro.' });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `Maximo ${MAX_RECIPIENTS} destinatarios por campana (seleccionaste ${recipients.length})` });
    }

    const campaign = await campaignModel.create({
      name,
      message,
      audience: data.audience || { mode: 'ALL' },
      total: recipients.length,
    });

    // Encola uno por uno (personalizable a futuro con {{nombre}})
    let enqueued = 0;
    for (const c of recipients) {
      try {
        const personal = message
          .replace(/\{\{\s*nombre\s*\}\}/gi, c.name || '')
          .replace(/\{\{\s*telefono\s*\}\}/gi, c.phone || '');
        await campaignModel.enqueueForCampaign({
          customerId: c.id,
          phone: c.phone,
          message: personal,
          campaignId: campaign.id,
        });
        enqueued += 1;
      } catch (err) {
        logger.error({ err: err.message }, `Fallo encolando campana para ${c.phone}`);
      }
    }

    await logModel.record({
      eventType: 'campaign_created',
      level: 'INFO',
      message: `Campana "${name}" encolada para ${enqueued} clientes`,
      metadata: { campaignId: campaign.id, total: enqueued },
    });

    res.status(201).json({ ...campaign, total: enqueued, note: 'Los mensajes estan en la cola de salida y se enviaran respetando los limites anti-ban.' });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const campaign = await campaignModel.getById(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campana no encontrada' });
    const fresh = await campaignModel.refreshProgress(campaign.id);
    res.json(fresh || campaign);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const ok = await campaignModel.remove(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Campana no encontrada' });
    await logModel.record({
      eventType: 'campaign_deleted',
      level: 'WARN',
      message: `Campana #${req.params.id} eliminada (pendientes cancelados)`,
      metadata: { campaignId: Number(req.params.id) },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, getById, remove };
