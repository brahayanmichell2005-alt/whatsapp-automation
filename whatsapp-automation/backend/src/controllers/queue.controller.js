// Controller de la cola de mensajes (Seccion 10 y Seccion 34 - API REST).
// El envio real lo hace el worker (llamado por /api/cron/tick); aqui solo se consulta el
// estado de la cola y se controla su pausa/reanudacion/detencion a nivel
// de mensajes ya encolados (el control global de automatizacion vive en
// automation.controller.js).

const queueModel = require('../models/messageQueue.model');
const logModel = require('../models/automationLog.model');

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || null;
    const items = await queueModel.list({ status, limit, offset });
    res.json(items);
  } catch (err) {
    next(err);
  }
}

// Pausa los mensajes actualmente PENDING (quedan como PAUSED) sin tocar
// el interruptor global de automatizacion.
async function pause(req, res, next) {
  try {
    const paused = await queueModel.pauseAllPending();
    await logModel.record({
      eventType: 'queue_pause',
      level: 'INFO',
      message: `Cola pausada manualmente (${paused} mensajes)`,
    });
    res.json({ paused });
  } catch (err) {
    next(err);
  }
}

async function resume(req, res, next) {
  try {
    const resumed = await queueModel.resumeAllPaused();
    await logModel.record({
      eventType: 'queue_resume',
      level: 'INFO',
      message: `Cola reanudada manualmente (${resumed} mensajes)`,
    });
    res.json({ resumed });
  } catch (err) {
    next(err);
  }
}

async function stop(req, res, next) {
  try {
    const cancelled = await queueModel.cancelAllOpen();
    await logModel.record({
      eventType: 'queue_stop',
      level: 'WARN',
      message: `Cola detenida manualmente, mensajes cancelados: ${cancelled}`,
    });
    res.json({ cancelled });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, pause, resume, stop };
