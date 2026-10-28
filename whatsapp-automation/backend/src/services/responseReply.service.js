// Generacion del texto de una respuesta automatica a partir del historial.
// Se separo de messageIntake.service.js para que el webhook solo programe el
// trabajo y la generacion ocurra cuando vence el tiempo configurado.

const aiService = require('./ai.service');
const rulesService = require('./rules.service');
const productModel = require('../models/product.model');
const messageModel = require('../models/message.model');
const customerModel = require('../models/customer.model');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

const MEMORY_SUMMARY_EVERY = 8;

function noTextReply(customer) {
  return `${customer.name ? `Hola ${customer.name}` : 'Hola'}, no pude abrir bien lo que me mandaste; ¿me lo puedes escribir por aquí, por favor? 🙏`;
}

async function buildReply({ customer, conversation, expectedInboundId = null }) {
  const history = (await messageModel.listRecentByConversation(conversation.id, 50)) || [];
  const latestInbound = [...history].reverse().find((m) => m.direction === 'INBOUND');
  if (!latestInbound) return { cancelled: true, reason: 'no_inbound_message' };
  if (expectedInboundId && Number(latestInbound.id) !== Number(expectedInboundId)) {
    return { cancelled: true, reason: 'newer_message_arrived' };
  }

  const text = String(latestInbound.content || '').trim();
  if (!text) {
    return {
      text: noTextReply(customer),
      source: 'SYSTEM',
      classification: null,
      history,
      inbound: latestInbound,
    };
  }

  const classification = { ...rulesService.classify(text), source: 'RULES' };
  await customerModel.updateClassification(customer.id, classification);

  const memory = await customerModel.getAiProfile(customer.id);
  const catalog = await productModel.search(text, 3);
  const wantsSearch =
    /(busca(n)? en (internet|google|la web)|investiga|googlea|informaci[oó]n actualizada|noticias (sobre|de)|qu[eé] est[aá] pasando)/i.test(
      text
    );

  let replyText = aiService.isEnabled()
    ? await aiService.generateReply({
        customerName: customer.name,
        history,
        memory,
        catalog,
        useSearch: wantsSearch,
      })
    : null;
  let source = 'AI';

  if (!replyText) {
    const template = rulesService.generateReply(classification, customer.name);
    const lastOutbound = [...history].reverse().find((m) => m.direction === 'OUTBOUND');
    if (lastOutbound && String(lastOutbound.content || '').trim() === template.trim()) {
      return {
        cancelled: true,
        reason: 'duplicate_template',
        classification,
        history,
        inbound: latestInbound,
      };
    }
    replyText = template;
    source = 'RULES';
  }

  return {
    text: replyText,
    source,
    classification,
    history,
    inbound: latestInbound,
    memory,
  };
}

// Memoria de largo plazo: se actualiza despues de enviar, sin bloquear el
// envio. Si falla, solo se registra el error.
async function maybeSummarizeMemory({ customer, conversation, history }) {
  try {
    const total = await messageModel.countByConversation(conversation.id);
    if (!total || total % MEMORY_SUMMARY_EVERY !== 0) return null;
    const memory = await customerModel.getAiProfile(customer.id);
    const transcript = (history || [])
      .map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Bot'}: ${String(m.content || '').trim()}`)
      .filter((line) => line.length > 6)
      .join('\n');
    const summary = await aiService.summarizeCustomer({
      customerName: customer.name,
      previous: memory,
      transcript,
    });
    if (!summary) return null;
    await customerModel.updateAiProfile(customer.id, summary);
    await logModel.record({
      eventType: 'ai_memory_updated',
      level: 'INFO',
      message: `Memoria de largo plazo actualizada para ${customer.phone}`,
      metadata: { customerId: customer.id, conversationId: conversation.id },
    });
    return summary;
  } catch (err) {
    logger.error({ err: err.message }, 'Fallo actualizando la memoria de largo plazo');
    return null;
  }
}

module.exports = { buildReply, maybeSummarizeMemory, noTextReply };
