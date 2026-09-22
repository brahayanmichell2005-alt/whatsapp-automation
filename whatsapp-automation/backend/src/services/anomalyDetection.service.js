// Deteccion de comportamiento anormal (Seccion 19). Si el numero de
// errores recientes de un tipo supera el umbral, pausa la cola
// automaticamente y deja constancia del incidente.

const logModel = require('../models/automationLog.model');
const settingsModel = require('../models/systemSetting.model');
const logger = require('../utils/logger');

const ERROR_THRESHOLD = parseInt(process.env.ANOMALY_ERROR_THRESHOLD, 10) || 5;
const WINDOW_MINUTES = parseInt(process.env.ANOMALY_WINDOW_MINUTES, 10) || 10;

async function checkAfterFailure(eventType) {
  const recentErrors = await logModel.countRecentErrors(eventType, WINDOW_MINUTES);

  if (recentErrors >= ERROR_THRESHOLD) {
    const alreadyPaused = (await settingsModel.get('pause_queue')) === 'true';
    if (!alreadyPaused) {
      await settingsModel.set('pause_queue', 'true');
      await settingsModel.set('automation_status', 'PAUSED');
      await logModel.record({
        eventType: 'anomaly_detected',
        level: 'ERROR',
        message: `Se detectaron ${recentErrors} errores de "${eventType}" en los ultimos ${WINDOW_MINUTES} minutos. Cola pausada automaticamente.`,
        metadata: { eventType, recentErrors, windowMinutes: WINDOW_MINUTES },
      });
      logger.error(
        { eventType, recentErrors },
        'Comportamiento anormal detectado: cola pausada automaticamente'
      );
    }
    return true;
  }
  return false;
}

module.exports = { checkAfterFailure };
