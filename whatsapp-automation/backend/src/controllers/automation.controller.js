// Controller de control de automatizacion global (Seccion 18).
// ACTIVE: procesa normalmente. PAUSED: no agrega nuevos envios ni procesa
// la cola. STOPPED: detiene todos los envios automaticos.
//
// Estos endpoints se mantienen por compatibilidad con el panel anterior.
// Delegando en responseControl.service.js, el estado global de automatizacion
// y la configuracion de la cola de respuestas quedan siempre sincronizados
// (no se puede pausar uno y dejar el otro activo).

const logModel = require('../models/automationLog.model');
const responseControl = require('../services/responseControl.service');

async function getStatus(req, res, next) {
  try {
    const settings = await responseControl.getGlobalConfig();
    res.json({ status: settings.status, pause_queue: !settings.enabled || settings.status !== 'ACTIVE' });
  } catch (err) {
    next(err);
  }
}

async function setStatus(status, logMessage, actor = null) {
  await responseControl.applyGlobalStatus(status, actor, logMessage);
  await logModel.record({ eventType: 'automation_status_change', level: 'INFO', message: logMessage });
}

async function activate(req, res, next) {
  try {
    await setStatus('ACTIVE', 'Automatizacion activada manualmente', req.user);
    res.json({ status: 'ACTIVE' });
  } catch (err) {
    next(err);
  }
}

async function pause(req, res, next) {
  try {
    await setStatus('PAUSED', 'Automatizacion pausada manualmente', req.user);
    res.json({ status: 'PAUSED' });
  } catch (err) {
    next(err);
  }
}

async function stop(req, res, next) {
  try {
    await setStatus('STOPPED', 'Automatizacion detenida manualmente', req.user);
    res.json({ status: 'STOPPED' });
  } catch (err) {
    next(err);
  }
}

async function resume(req, res, next) {
  try {
    await setStatus('ACTIVE', 'Automatizacion reanudada manualmente', req.user);
    res.json({ status: 'ACTIVE' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, activate, pause, stop, resume };
