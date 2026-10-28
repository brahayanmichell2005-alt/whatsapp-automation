// Controller de la cola de respuestas automaticas (tiempos por cliente,
// agrupacion, concurrencia global y atencion humana).
//
// Permisos:
//  - Lectura del estado y de los trabajos: cualquier usuario autenticado.
//  - Configuracion global, pausa/reanudacion/detencion de emergencia y
//    reintentos manuales: solo ADMIN.
//  - Configuracion por cliente y atencion humana: cualquier usuario
//    autenticado (es una accion operativa, no de configuracion global).
//
// La validacion de rangos vive en validators/response.validator.js y se aplica
// tambien en el servicio, de modo que no se puede saltar desde otra ruta.

const evolutionService = require('../services/evolution.service');
const responseControl = require('../services/responseControl.service');
const responseJobModel = require('../models/responseJob.model');
const responseSettingsModel = require('../models/responseSettings.model');

function parsePaging(query) {
  return {
    limit: Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200),
    offset: Math.max(parseInt(query.offset, 10) || 0, 0),
  };
}

async function connectionStatus() {
  try {
    const connection = await evolutionService.checkConnection();
    return connection || null;
  } catch (err) {
    return { status: 'UNKNOWN', error: err.message };
  }
}

async function getStatus(req, res, next) {
  try {
    const payload = await responseControl.getStatus({ connection: await connectionStatus() });
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const updated = await responseControl.updateGlobalSettings(req.body || {}, req.user);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function pause(req, res, next) {
  try {
    const updated = await responseControl.pauseGlobal(req.user, req.body && req.body.reason);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function resume(req, res, next) {
  try {
    const updated = await responseControl.resumeGlobal(req.user);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function stop(req, res, next) {
  try {
    const updated = await responseControl.stopGlobal(req.user, (req.body && req.body.reason) || 'Detencion de emergencia');
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function listJobs(req, res, next) {
  try {
    const { limit, offset } = parsePaging(req.query);
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const allowed = responseJobModel.OPEN_STATUSES.concat([
      'SENT',
      'FAILED',
      'CANCELLED',
      'UNCERTAIN',
    ]);
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `status debe ser uno de: ${allowed.join(', ')}` });
    }
    const jobs = await responseJobModel.list({ status, limit, offset });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
}

async function retryJob(req, res, next) {
  try {
    const job = await responseControl.retryJob(req.params.id, req.user);
    res.json(job);
  } catch (err) {
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const { limit, offset } = parsePaging(req.query);
    const items = await responseSettingsModel.listHistory({ limit, offset });
    res.json(items);
  } catch (err) {
    next(err);
  }
}

async function getCustomer(req, res, next) {
  try {
    const state = await responseControl.getCustomerState(req.params.customerId);
    if (!state) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(state);
  } catch (err) {
    next(err);
  }
}

async function updateCustomer(req, res, next) {
  try {
    const result = await responseControl.updateCustomerSettings(
      req.params.customerId,
      req.body || {},
      req.user
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function resetCustomer(req, res, next) {
  try {
    const result = await responseControl.resetCustomerSettings(req.params.customerId, req.user);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function setCustomerState(req, res, next) {
  try {
    const values = {};
    if (req.body && req.body.enabled !== undefined) values.enabled = req.body.enabled;
    if (req.body && req.body.paused !== undefined) values.paused = req.body.paused;
    const result = await responseControl.setCustomerAutomation(
      req.params.customerId,
      values,
      req.user,
      req.body && req.body.reason
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function takeOver(req, res, next) {
  try {
    const result = await responseControl.takeOverConversation({
      conversationId: req.params.id,
      actor: req.user,
      reason: (req.body && req.body.reason) || null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function release(req, res, next) {
  try {
    const conversation = await responseControl.releaseConversation({
      conversationId: req.params.id,
      actor: req.user,
    });
    res.json(conversation);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStatus,
  updateSettings,
  pause,
  resume,
  stop,
  listJobs,
  retryJob,
  history,
  getCustomer,
  updateCustomer,
  resetCustomer,
  setCustomerState,
  takeOver,
  release,
};
