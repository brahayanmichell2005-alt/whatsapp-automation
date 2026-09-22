// Controller de control de automatizacion global (Seccion 18).
// ACTIVE: procesa normalmente. PAUSED: no agrega nuevos envios ni procesa
// la cola. STOPPED: detiene todos los envios automaticos.

const settingsModel = require('../models/systemSetting.model');
const logModel = require('../models/automationLog.model');

async function getStatus(req, res, next) {
  try {
    const status = await settingsModel.get('automation_status');
    const pauseQueue = await settingsModel.get('pause_queue');
    res.json({ status: status || 'ACTIVE', pause_queue: pauseQueue === 'true' });
  } catch (err) {
    next(err);
  }
}

async function setStatus(status, logMessage) {
  await settingsModel.set('automation_status', status);
  await settingsModel.set('pause_queue', status === 'ACTIVE' ? 'false' : 'true');
  await logModel.record({ eventType: 'automation_status_change', level: 'INFO', message: logMessage });
}

async function activate(req, res, next) {
  try {
    await setStatus('ACTIVE', 'Automatizacion activada manualmente');
    res.json({ status: 'ACTIVE' });
  } catch (err) {
    next(err);
  }
}

async function pause(req, res, next) {
  try {
    await setStatus('PAUSED', 'Automatizacion pausada manualmente');
    res.json({ status: 'PAUSED' });
  } catch (err) {
    next(err);
  }
}

async function stop(req, res, next) {
  try {
    await setStatus('STOPPED', 'Automatizacion detenida manualmente');
    res.json({ status: 'STOPPED' });
  } catch (err) {
    next(err);
  }
}

async function resume(req, res, next) {
  try {
    await setStatus('ACTIVE', 'Automatizacion reanudada manualmente');
    res.json({ status: 'ACTIVE' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, activate, pause, stop, resume };
