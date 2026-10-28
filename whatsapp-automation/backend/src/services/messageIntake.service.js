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
const responseJobModel = require('../models/responseJob.model');
const rulesService = require('./rules.service');
const aiService = require('./ai.service');
const assistantService = require('./assistant.service');
const mediaService = require('./media.service');
const responseControl = require('./responseControl.service');
const responseProcessing = require('./responseProcessing.service');
const env = require('../config/env');
const logger = require('../utils/logger');

async function handleInboundMessage(parsedEvent) {
  const { phone, pushName, externalMessageId, messageType, isGroup, fromMe, remoteJid } =
    parsedEvent;
  let { content } = parsedEvent;

  if (isGroup) {
    // El sistema esta orientado a atencion 1:1 con clientes; los mensajes
    // de grupos se ignoran de forma segura (Seccion 6, ultima linea).
    return { skipped: true, reason: 'group_message' };
  }

  // Los mensajes "fromMe" se procesan igual: en el chat consigo mismo el
  // propietario escribe a mano desde el telefono, y en Android esos mensajes
  // tambien tienen ids que empiezan con "3EB0" (igual que los envios del bot
  // via API), asi que el prefijo NO distingue quien lo envio.
  // El anti-bucle real es la deduplicacion por externalMessageId: el worker
  // guarda el id de cada envio del bot (OUTBOUND) y si Evolution reenviara
  // el eco de un mensaje propio, aqui abajo se descarta como duplicado.

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

  // ---- Audios, imagenes y stickers: descifrar y entender antes de responder.
  // Si se logra transcribir/describir, el contenido entra al chat como texto
  // y el bot responde de forma natural (sin decir que fue una transcripcion).
  if (parsedEvent.media && ['AUDIO', 'IMAGE', 'STICKER'].includes(parsedEvent.media.kind)) {
    const understood = await understandIncomingMedia(parsedEvent.media, customer);
    if (understood) {
      content = [content, understood].filter(Boolean).join('\n');
    }
  }

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

  // ---- Seccion 6, pasos 11-13: reglas / IA y programacion de la respuesta ----
  await processAutomatedReply({ customer, conversation, content, prefs, message });

  return { skipped: false, customer, conversation, message };
}

// Descarga, descifra y entiende un archivo multimedia entrante.
// Devuelve el texto (transcripcion/descripcion) para tratarlo como un
// mensaje normal, o null si no se logro (el bot responde con elegancia).
async function understandIncomingMedia(media, customer) {
  const startedAt = Date.now();
  try {
    const decrypted = await mediaService.decryptMedia(media);
    if (!decrypted) {
      await logModel.record({
        eventType: 'media_failed',
        level: 'WARN',
        message: `No se pudo descifrar el ${media.kind.toLowerCase()} de ${customer.phone}`,
        metadata: { customerId: customer.id },
      });
      return null;
    }
    const text = await aiService.understandMedia({
      kind: media.kind,
      buffer: decrypted.buffer,
      mimetype: media.mimetype,
    });
    if (!text) {
      await logModel.record({
        eventType: 'media_failed',
        level: 'WARN',
        message: `La IA no pudo entender el ${media.kind.toLowerCase()} de ${customer.phone}`,
        metadata: { customerId: customer.id },
      });
      return null;
    }
    await logModel.record({
      eventType: 'media_understood',
      level: 'INFO',
      message: `${media.kind === 'AUDIO' ? 'Audio transcrito' : 'Imagen leida'} de ${customer.phone} (${Date.now() - startedAt}ms)`,
      metadata: { customerId: customer.id, kind: media.kind },
    });
    const etiqueta =
      media.kind === 'AUDIO'
        ? '[La persona envio una nota de voz que dice]: '
        : '[La persona envio una imagen que muestra]: ';
    return etiqueta + text;
  } catch (err) {
    logger.error({ err: err.message, kind: media.kind }, 'Error procesando archivo multimedia');
    await logModel.record({
      eventType: 'media_failed',
      level: 'ERROR',
      message: `Error procesando el ${media.kind.toLowerCase()} de ${customer.phone}: ${err.message}`,
      metadata: { customerId: customer.id },
    });
    return null;
  }
}

// Procesa comandos de opt-in/opt-out, comandos del dueno y modos del
// asistente. Para una respuesta normal NO genera el texto aqui: crea un
// trabajo persistente con el tiempo configurado y dispara el procesador.
// Asi el webhook responde rapido y la cola sobrevive reinicios.
async function processAutomatedReply({ customer, conversation, content, prefs = null, message = null }) {
  const optCommand = rulesService.detectOptCommand(content);
  if (optCommand === 'OPT_OUT') {
    await prefsModel.optOut(customer.id);
    await responseJobModel.cancelOpenByCustomer(customer.id, 'Cliente solicito opt-out');
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

  // ---- Asistente personal: comandos del dueno (ejecutan aunque el modo
  // sea OFF, para poder reactivarlo) ----
  const ownerCommand = await assistantService.parseOwnerCommand(customer.phone, content);
  if (ownerCommand) {
    const confirm = await assistantService.executeOwnerCommand(ownerCommand, customer);
    if (confirm) {
      await responseJobModel.cancelOpenByCustomer(customer.id, 'Comando del dueno');
      await queueModel.cancelPendingByCustomer(customer.id);
      await queueModel.enqueue({ customerId: customer.id, phone: customer.phone, message: confirm });
      try {
        const worker = require('../workers/message.worker');
        await worker.tick({ budgetMs: 20000 });
      } catch (err) {
        logger.error({ err: err.message }, 'No se pudo ejecutar el worker tras un comando del dueno');
      }
    }
    return;
  }

  // ---- Modos del asistente: disponible / ocupado / manual (OFF) ----
  const effective = await assistantService.effectiveMode();
  if (effective.mode === 'OFF') {
    await responseJobModel.cancelOpenByConversation(conversation.id, 'Modo manual activo');
    await queueModel.cancelPendingByCustomer(customer.id);
    await logModel.record({
      eventType: 'auto_reply_skipped',
      level: 'INFO',
      message: `Sin respuesta automatica para ${customer.phone}: modo manual activo`,
      metadata: { customerId: customer.id },
    });
    return;
  }
  if (effective.mode === 'BUSY') {
    if (customer.phone === effective.ownerPhone) {
      // Al dueno no se le contesta con el aviso de ocupado (se esta hablando
      // a si mismo en pruebas).
      return;
    }
    await responseJobModel.cancelOpenByConversation(conversation.id, 'Modo ocupado');
    await queueModel.cancelPendingByCustomer(customer.id);
    await queueModel.enqueue({ customerId: customer.id, phone: customer.phone, message: effective.busyReply });
    await logModel.record({
      eventType: 'auto_reply_queued',
      level: 'INFO',
      message: `Respuesta de OCUPADO encolada para ${customer.phone}${effective.reason ? ' (' + effective.reason + ')' : ''}`,
      metadata: { customerId: customer.id, conversationId: conversation.id },
    });
    try {
      const worker = require('../workers/message.worker');
      await worker.tick({ budgetMs: 20000 });
    } catch (err) {
      logger.error({ err: err.message }, 'No se pudo ejecutar el worker tras el modo ocupado');
    }
    return;
  }

  const currentPrefs = prefs || (await prefsModel.ensureForCustomer(customer.id));
  if (currentPrefs.opted_out) {
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

  if (!message) {
    logger.warn({ customerId: customer.id }, 'Mensaje sin id: no se puede programar una respuesta idempotente');
    return;
  }

  const scheduled = await responseControl.scheduleResponse({ customer, conversation, message });
  if (!scheduled.scheduled) {
    await logModel.record({
      eventType: 'auto_reply_skipped',
      level: 'INFO',
      message: `Sin respuesta automatica para ${customer.phone}: ${scheduled.reason}`,
      metadata: {
        customerId: customer.id,
        conversationId: conversation.id,
        reason: scheduled.reason,
      },
    });
    return;
  }

  // En Vercel no hay proceso permanente: este tick espera (acotado) el
  // tiempo configurado y procesa el trabajo. Si el tiempo es mayor o la
  // ejecucion se corta, el cron de Supabase lo recupera desde PostgreSQL.
  try {
    const summary = await responseProcessing.tick({
      budgetMs: env.RESPONSE_INLINE_BUDGET_MS,
      waitMs: env.RESPONSE_INLINE_WAIT_MS,
    });
    logger.info({ summary, jobId: scheduled.job?.id }, 'Procesador de respuestas ejecutado tras el mensaje entrante');
  } catch (err) {
    logger.error({ err: err.message }, 'No se pudo procesar la cola de respuestas ahora; queda persistida');
  }
}

module.exports = { handleInboundMessage };
