// Controller del webhook de WhatsApp (Seccion 6).
// Flujo: recibir -> validar -> identificar tipo de evento -> delegar al
// servicio correspondiente -> responder siempre con un HTTP valido y rapido,
// incluso si el procesamiento interno falla, para que Evolution API no
// reintente indefinidamente el mismo evento.

const eventParser = require('../utils/evolutionEventParser');
const { validateWebhookPayload } = require('../validators/webhook.validator');
const messageIntakeService = require('../services/messageIntake.service');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

async function receiveWhatsappEvent(req, res) {
  const validation = validateWebhookPayload(req.body);
  if (!validation.valid) {
    logger.warn({ reason: validation.reason }, 'Webhook rechazado por estructura invalida');
    return res.status(400).json({ error: validation.reason });
  }

  const { event } = req.body;

  if (!eventParser.isKnownEvent(event)) {
    // Ignorar de forma segura eventos no utilizados (Seccion 6, ultima linea).
    return res.status(200).json({ received: true, processed: false, event });
  }

  try {
    if (event === 'messages.upsert') {
      const parsed = eventParser.parseMessageUpsert(req.body);
      if (!parsed) {
        return res.status(200).json({ received: true, processed: false, event });
      }
      const result = await messageIntakeService.handleInboundMessage(parsed);
      return res.status(200).json({ received: true, processed: !result.skipped, ...resultSummary(result) });
    }

    if (event === 'connection.update') {
      const parsed = eventParser.parseConnectionUpdate(req.body);
      await logModel.record({
        eventType: 'connection_update',
        level: 'INFO',
        message: `Estado de conexion de WhatsApp: ${parsed.state || 'desconocido'}`,
        metadata: parsed,
      });
      return res.status(200).json({ received: true, processed: true, event });
    }

    if (event === 'qrcode.updated') {
      await logModel.record({
        eventType: 'qrcode_updated',
        level: 'INFO',
        message: 'Se genero un nuevo codigo QR para vincular WhatsApp',
      });
      return res.status(200).json({ received: true, processed: true, event });
    }

    // No deberia llegar aqui porque isKnownEvent ya filtro, pero por
    // seguridad respondemos igual con 200 para no generar reintentos.
    return res.status(200).json({ received: true, processed: false, event });
  } catch (err) {
    logger.error({ err, event }, 'Error procesando evento de webhook');
    await logModel.record({
      eventType: 'webhook_error',
      level: 'ERROR',
      message: `Error procesando evento "${event}": ${err.message}`,
    });
    // Se responde 200 igualmente: el error ya quedo registrado, y no
    // queremos que Evolution API reintente un evento que fallo por un
    // problema interno (evita bucles de reintento sobre el mismo mensaje).
    return res.status(200).json({ received: true, processed: false, error: 'internal_error' });
  }
}

// Pequeno helper para no filtrar objetos completos de modelo en la respuesta HTTP.
function resultSummary(result) {
  if (result.skipped) {
    return { reason: result.reason };
  }
  return {
    customerId: result.customer.id,
    conversationId: result.conversation.id,
    messageId: result.message.id,
  };
}

module.exports = { receiveWhatsappEvent };
