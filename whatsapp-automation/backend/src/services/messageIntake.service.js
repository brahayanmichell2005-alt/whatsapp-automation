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
const productModel = require('../models/product.model');
const assistantService = require('./assistant.service');
const mediaService = require('./media.service');
const logger = require('../utils/logger');

// Cada cuantos mensajes de una conversacion la IA resume y guarda la
// memoria de largo plazo del cliente (columna customers.ai_profile).
const MEMORY_SUMMARY_EVERY = 8;

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

  // ---- Seccion 6, pasos 11-13: reglas / IA y creacion de la respuesta ----
  await processAutomatedReply({ customer, conversation, content, prefs });

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

  // ---- Asistente personal: comandos del dueno (ejecutan aunque el modo
  // sea OFF, para poder reactivarlo) ----
  const ownerCommand = await assistantService.parseOwnerCommand(customer.phone, content);
  if (ownerCommand) {
    const confirm = await assistantService.executeOwnerCommand(ownerCommand, customer);
    if (confirm) {
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
    // Modo manual: el bot no responde nada automaticamente.
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
  // Mensajes sin texto y sin poder entender el archivo (video, documento,
  // o medio que fallo): se pide el mensaje por escrito con elegancia.
  const text = String(content || '').trim();
  if (!text) {
    const noTextReply = `${customer.name ? `Hola ${customer.name}` : 'Hola'}, no pude abrir bien lo que me mandaste; ¿me lo puedes escribir por aquí, por favor? 🙏`;
    await queueModel.cancelPendingByCustomer(customer.id);
    await queueModel.enqueue({ customerId: customer.id, phone: customer.phone, message: noTextReply });
    await logModel.record({
      eventType: 'auto_reply_queued',
      level: 'INFO',
      message: `Respuesta automatica encolada para ${customer.phone} (mensaje sin texto, origen: NON_TEXT)`,
      metadata: { customerId: customer.id, conversationId: conversation.id },
    });
    // Envio instantaneo (mismo mecanismo que las respuestas de la IA).
    try {
      const worker = require('../workers/message.worker');
      await worker.tick({ budgetMs: 20000 });
    } catch (err) {
      logger.error({ err: err.message }, 'No se pudo ejecutar el worker tras un mensaje sin texto');
    }
    return { skipped: false, customer, conversation };
  }

  const classification = { ...rulesService.classify(content), source: 'RULES' };

  await customerModel.updateClassification(customer.id, classification);

  // Respuesta conversacional con IA a partir del historial. Si la IA esta
  // desactivada (o falla), el motor de reglas responde igualmente: el bot no
  // debe quedarse mudo. Solo se omite si la plantilla es identica a la ultima
  // respuesta enviada, para no repetir el mismo texto en cada mensaje.
  // Contexto para la IA: historial reciente (los ultimos 50 mensajes de la
  // conversacion), memoria de largo plazo del cliente y productos del
  // catalogo que coinciden con lo que acabo de escribir.
  const history = (await messageModel.listRecentByConversation(conversation.id, 50)) || [];
  const memory = await customerModel.getAiProfile(customer.id);
  const catalog = await productModel.search(content, 3);
  // Investigacion web: si la persona pide buscar en internet, la IA usa su
  // herramienta de busqueda (Google Search grounding) para esa respuesta.
  const wantsSearch =
    /(busca(n)? en (internet|google|la web)|investiga|googlea|informaci[oó]n actualizada|noticias (sobre|de)|qu[eé] est[aá] pasando)/i.test(
      text
    );
  let replyText = aiService.isEnabled()
    ? await aiService.generateReply({ customerName: customer.name, history, memory, catalog, useSearch: wantsSearch })
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

  // Memoria de largo plazo: cada N mensajes la IA resume la conversacion
  // (mezclando el resumen anterior) y lo guarda en customers.ai_profile.
  // Se hace despues de encolar la respuesta: si falla, no afecta al bot.
  try {
    const total = await messageModel.countByConversation(conversation.id);
    if (total > 0 && total % MEMORY_SUMMARY_EVERY === 0) {
      const transcript = history
        .map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Bot'}: ${String(m.content || '').trim()}`)
        .filter((t) => t.length > 6)
        .join('\n');
      const summary = await aiService.summarizeCustomer({
        customerName: customer.name,
        previous: memory,
        transcript,
      });
      if (summary) {
        await customerModel.updateAiProfile(customer.id, summary);
        await logModel.record({
          eventType: 'ai_memory_updated',
          level: 'INFO',
          message: `Memoria de largo plazo actualizada para ${customer.phone}`,
          metadata: { customerId: customer.id, conversationId: conversation.id },
        });
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Fallo actualizando la memoria de largo plazo (no afecta la respuesta)');
  }

  // En la nube (Vercel) no hay proceso permanente: sin este disparo la
  // respuesta quedaria en la cola hasta que un cron externo la procese.
  // Se ejecuta el worker en el mismo request para que la respuesta salga
  // al instante. Si falla, el cron de Supabase (database/cron.sql) la
  // enviaria mas tarde; el bot no se queda mudo por esto.
  try {
    const worker = require('../workers/message.worker');
    const summary = await worker.tick({ budgetMs: 20000 });
    logger.info({ summary }, 'Worker ejecutado tras encolar respuesta automatica');
  } catch (err) {
    logger.error({ err: err.message }, 'No se pudo ejecutar el worker tras encolar (la respuesta queda en cola)');
  }
}

module.exports = { handleInboundMessage };
