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

// Placeholder para mensajes sin texto (audio, imagen, etc.). Da a la IA un
// turno valido del usuario para responder de forma natural en lugar de caer
// a la plantilla.
const CONTENT_PLACEHOLDERS = {
  AUDIO: '[Mensaje de voz]',
  IMAGE: '[Imagen]',
  VIDEO: '[Video]',
  DOCUMENT: '[Documento]',
  LOCATION: '[Ubicacion]',
};

async function handleInboundMessage(parsedEvent) {
  const { phone, pushName, externalMessageId, messageType, isGroup, fromMe, remoteJid } =
    parsedEvent;
  const content = parsedEvent.content || CONTENT_PLACEHOLDERS[messageType] || null;

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

  const customer = await customerModel.findOrCreateByPhone(phone, pushName, remoteJid || null);
  const prefs = await prefsModel.ensureForCustomer(customer.id);

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
  await processAutomatedReply({ customer, conversation, content, prefs });

  return { skipped: false, customer, conversation, message };
}

// Procesa comandos de opt-in/opt-out, clasifica el mensaje (IA si esta
// activada, con fallback al motor de reglas) y encola una respuesta
// automatica, respetando el opt-out del cliente (Seccion 15-16, 23-24).
// El envio real de lo encolado ocurre en el worker de la Entrega 6.
async function processAutomatedReply({ customer, conversation, content, prefs = null }) {
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

  const currentPrefs = prefs || (await prefsModel.ensureForCustomer(customer.id));
  if (currentPrefs.opted_out) {
    // No generamos ni encolamos respuestas comerciales a quien opto por salir.
    return;
  }

  if (customer.status === 'BLOCKED' || customer.status === 'ARCHIVED') {
    await logModel.record({
      eventType: 'auto_reply_skipped',
      level: 'INFO',
      message: `Sin respuesta automatica para ${customer.phone}: cliente en estado ${customer.status}`,
      metadata: { customerId: customer.id, conversationId: conversation.id },
    });
    return;
  }

  // La clasificacion por IA agregaba otra llamada (y mas latencia) antes de
  // redactar la respuesta. El motor de reglas ya distingue PRODUCTO /
  // SERVICIO / INDECISO, asi que se usa directamente y la IA se reserva para
  // la respuesta conversacional.
  const classification = { ...rulesService.classify(content), source: 'RULES' };

  await customerModel.updateClassification(customer.id, classification);

  // Respuesta conversacional con IA a partir del historial. Si la IA esta
  // desactivada (o falla), el motor de reglas responde igualmente: el bot no
  // debe quedarse mudo. Solo se omite si la plantilla es identica a la ultima
  // respuesta enviada, para no repetir el mismo texto en cada mensaje.
  const history = (await messageModel.listRecentByConversation(conversation.id, 20)) || [];
  let replyText = aiService.isEnabled()
    ? await aiService.generateReply({ customerName: customer.name, history })
    : null;
  let replySource = 'AI';
  if (!replyText) {
    const template = rulesService.generateReply(classification, customer.name);
    const lastOutbound = [...history].reverse().find((m) => m.direction === 'OUTBOUND');
    if (lastOutbound && String(lastOutbound.content || '').trim() === template.trim()) {
      await logModel.record({
        eventType: 'auto_reply_skipped',
        level: 'WARN',
        message: `Sin respuesta automatica para ${customer.phone}: la IA no genero texto y la plantilla ya se habia enviado`,
        metadata: { customerId: customer.id, conversationId: conversation.id },
      });
      return;
    }
    replyText = template;
    replySource = 'RULES';
  }

  // Varios mensajes seguidos = una sola respuesta: se descarta la respuesta aun
  // pendiente (generada con menos contexto) y se encola la nueva con todo el historial.
  await queueModel.cancelPendingByCustomer(customer.id);

  await queueModel.enqueue({
    customerId: customer.id,
    phone: customer.phone,
    message: replyText,
  });

  await logModel.record({
    eventType: 'auto_reply_queued',
    level: 'INFO',
    message: `Respuesta automatica encolada para ${customer.phone} (clasificacion: ${classification.interestType}, origen: ${replySource})`,
    metadata: { customerId: customer.id, conversationId: conversation.id, classification },
  });
}

module.exports = { handleInboundMessage };
