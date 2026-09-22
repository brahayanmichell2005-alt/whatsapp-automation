// Orquesta lo que sucede cuando llega un mensaje entrante valido
// (Seccion 6, pasos 9-10): identificar o crear cliente, encontrar o abrir
// una conversacion, y registrar el mensaje evitando duplicados.
//
// El procesamiento de reglas/IA (paso 11-12) y la creacion del mensaje de
// respuesta en la cola (paso 13) se implementan en las Entregas 5 y 6;
// aqui queda un punto de extension claro para conectarlos despues.

const customerModel = require('../models/customer.model');
const conversationModel = require('../models/conversation.model');
const messageModel = require('../models/message.model');
const prefsModel = require('../models/communicationPreference.model');
const logModel = require('../models/automationLog.model');
const queueModel = require('../models/messageQueue.model');
const rulesService = require('./rules.service');
const aiService = require('./ai.service');
const logger = require('../utils/logger');

async function handleInboundMessage(parsedEvent) {
  const { phone, pushName, externalMessageId, messageType, content, isGroup, fromMe } =
    parsedEvent;

  if (isGroup) {
    // El sistema esta orientado a atencion 1:1 con clientes; los mensajes
    // de grupos se ignoran de forma segura (Seccion 6, ultima linea).
    return { skipped: true, reason: 'group_message' };
  }

  if (fromMe) {
    // Mensajes que salieron desde el propio WhatsApp (por ejemplo, enviados
    // manualmente desde el telefono). Se registraran junto con la logica de
    // envio en la Entrega 6 para no duplicar aqui.
    return { skipped: true, reason: 'from_me' };
  }

  if (!phone) {
    return { skipped: true, reason: 'missing_phone' };
  }

  // Evita registrar dos veces el mismo mensaje si Evolution API reenvia el evento.
  if (externalMessageId) {
    const existing = await messageModel.findByExternalId(externalMessageId);
    if (existing) {
      return { skipped: true, reason: 'duplicate_message', messageId: existing.id };
    }
  }

  const customer = await customerModel.findOrCreateByPhone(phone, pushName);
  await prefsModel.ensureForCustomer(customer.id);

  const conversation = await conversationModel.findOrCreateOpenByCustomer(customer.id);

  const message = await messageModel.create({
    conversationId: conversation.id,
    customerId: customer.id,
    direction: 'INBOUND',
    messageType,
    content,
    externalMessageId,
    status: 'DELIVERED',
  });

  await conversationModel.touchLastMessage(conversation.id);
  await customerModel.touchLastMessage(customer.id);

  logger.info(
    { customerId: customer.id, conversationId: conversation.id, messageId: message.id },
    'Mensaje entrante registrado'
  );

  await logModel.record({
    eventType: 'message_received',
    level: 'INFO',
    message: `Mensaje recibido de ${phone}`,
    metadata: { customerId: customer.id, conversationId: conversation.id, messageId: message.id },
  });

  // ---- Seccion 6, pasos 11-13: reglas / IA y creacion de la respuesta ----
  await processAutomatedReply({ customer, conversation, content });

  return { skipped: false, customer, conversation, message };
}

// Procesa comandos de opt-in/opt-out, clasifica el mensaje (IA si esta
// activada, con fallback al motor de reglas) y encola una respuesta
// automatica, respetando el opt-out del cliente (Seccion 15-16, 23-24).
// El envio real de lo encolado ocurre en el worker de la Entrega 6.
async function processAutomatedReply({ customer, conversation, content }) {
  const optCommand = rulesService.detectOptCommand(content);
  if (optCommand === 'OPT_OUT') {
    await prefsModel.optOut(customer.id);
    await queueModel.cancelPendingByCustomer(customer.id);
    await logModel.record({
      eventType: 'opt_out',
      level: 'INFO',
      message: `Cliente ${customer.phone} solicito dejar de recibir mensajes`,
      metadata: { customerId: customer.id },
    });
    return;
  }
  if (optCommand === 'OPT_IN') {
    await prefsModel.optIn(customer.id);
    await logModel.record({
      eventType: 'opt_in',
      level: 'INFO',
      message: `Cliente ${customer.phone} solicito volver a recibir mensajes`,
      metadata: { customerId: customer.id },
    });
    return;
  }

  const prefs = await prefsModel.ensureForCustomer(customer.id);
  if (prefs.opted_out) {
    // No generamos ni encolamos respuestas comerciales a quien opto por salir.
    return;
  }

  let classification = await aiService.classifyIntent(content);
  if (!classification) {
    classification = { ...rulesService.classify(content), source: 'RULES' };
  }

  await customerModel.updateClassification(customer.id, classification);

  const replyText = rulesService.generateReply(classification, customer.name);

  await queueModel.enqueue({
    customerId: customer.id,
    phone: customer.phone,
    message: replyText,
  });

  await logModel.record({
    eventType: 'auto_reply_queued',
    level: 'INFO',
    message: `Respuesta automatica encolada para ${customer.phone} (clasificacion: ${classification.interestType}, origen: ${classification.source})`,
    metadata: { customerId: customer.id, conversationId: conversation.id, classification },
  });
}

module.exports = { handleInboundMessage };
