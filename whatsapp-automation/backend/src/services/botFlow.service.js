// Flujos conversacionales solicitados en PLANTILLAS-CRM-BOT.md:
//
//  1) Pedir nombre y apellidos cuando todavia no los conocemos, guardarlos
//     en el contacto y continuar con la consulta original. Si el cliente
//     prefiere no compartirlos, se deja de insistir y se le atiende igual.
//
// Las funciones de parsing/validacion son puras (se exportan para tests);
// las funciones handle* son las que tocan la base de datos y la cola.

const customerModel = require('../models/customer.model');
const stateModel = require('../models/botState.model');
const logModel = require('../models/automationLog.model');
const queueModel = require('../models/messageQueue.model');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// Mensajes del flujo
// ---------------------------------------------------------------------

const NAME_PROMPT =
  'Para poder atenderte mejor, ¿me compartes tu nombre y apellidos, por favor? 😊';

const NAME_DECLINED_ACK = 'No hay problema 😊 Te ayudo igual. ';

const NAME_SAVED_THANKS = '¡Gracias, {nombre}! 😊 Con gusto sigo con tu solicitud.';

// ---------------------------------------------------------------------
// Utilidades de texto (puras)
// ---------------------------------------------------------------------

// Minúsculas, sin acentos y sin doble espacios: funciona para todo el parsing.
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palabras que NO son un nombre: respuestas sueltas o parte de una consulta.
const NON_NAME_WORDS = [
  'hola', 'buenas', 'gracias', 'no', 'si', 'ok', 'okay', 'va', 'ya', 'bien',
  'dale', 'vale', 'listo', 'perfecto', 'manana', 'tarde', 'noche', 'hoy',
  'ayer', 'dia', 'hora', 'quoteres', 'nada', 'nuevo', 'quiero', 'necesito',
  'puedo', 'podrias', 'cuanto', 'cuando', 'donde', 'que', 'como', 'por',
  'favor', 'aqui', 'bueno', 'stop', 'baja', 'alta', 'salir', 'cancelar',
];

// Si el mensaje habla de esto, no es un nombre (sino una consulta del cliente).
const QUERY_HINT_RE =
  /(reserv|cita|agend|comprar|precio|costo|catalogo|stock|disponib|producto|laptop|servic|reparac|mantenim|instalac|soporte|falla|problema|reclamo|garantia|cotiza|pedido|envio)/;

// Un nombre plausible: solo letras y espacios, entre 1 y 5 palabras de
// 2+ caracteres, sin palabras de consulta ("quiero una cita", "precio").
function looksLikeName(text) {
  const norm = normalizeText(text);
  if (!norm || /\d/.test(norm) || /[@_/]/.test(norm)) return false;
  if (QUERY_HINT_RE.test(norm)) return false;
  const words = norm.split(' ').filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;
  return words.every(
    (w) => w.length >= 2 && /^[a-zñü]+$/.test(w) && !NON_NAME_WORDS.includes(w)
  );
}

// "No quiero dar mi nombre", "prefiero no", etc.: continuar sin insistir.
const NAME_DECLINE_RE =
  /(no quiero|no puedo|no deseo|prefiero no|no voy a|no me gusta dar|sin nombre|no dar)/;

// ---------------------------------------------------------------------
// Envio de mensajes del flujo (encola y dispara el worker)
// ---------------------------------------------------------------------

async function sendAndLog({ customer, conversation, message, eventType }) {
  await queueModel.cancelPendingByCustomer(customer.id);
  await queueModel.enqueue({
    customerId: customer.id,
    phone: customer.phone,
    message,
  });
  await logModel.record({
    eventType,
    level: 'INFO',
    message: `Respuesta del flujo encolada para ${customer.phone} (${eventType})`,
    metadata: { customerId: customer.id, conversationId: conversation ? conversation.id : null },
  });
  try {
    const worker = require('../workers/message.worker');
    await worker.tick({ budgetMs: 20000 });
  } catch (err) {
    logger.error({ err: err.message }, 'No se pudo ejecutar el worker tras un mensaje del flujo');
  }
}

// ---------------------------------------------------------------------
// Flujo 1: nombre y apellidos
// ---------------------------------------------------------------------

// Pregunta el nombre/apellidos ANTES de atender la consulta. Guarda el
// mensaje original en el estado para retomarlo cuando respondan.
async function startNameCapture({ customer, conversation, pendingText }) {
  await stateModel.set(customer.id, 'NAME', { pending: String(pendingText || '').trim() });
  await logModel.record({
    eventType: 'name_capture_started',
    level: 'INFO',
    message: `Pidiendo nombre y apellidos a ${customer.phone}`,
    metadata: { customerId: customer.id, conversationId: conversation ? conversation.id : null },
  });
  await sendAndLog({
    customer,
    conversation,
    message: NAME_PROMPT,
    eventType: 'auto_reply_queued',
  });
  return true;
}

// Si ya nos dieron el nombre por otra via (pushName), no se vuelve a preguntar.
async function maybeClearNameFlow(customer) {
  if (customerModel.isUsableName(customer.name)) {
    await stateModel.ensureNameNotDeclined(customer.id);
    const state = await stateModel.get(customer.id);
    if (state && state.awaiting === 'NAME') {
      await stateModel.clear(customer.id);
      return state.context && state.context.pending ? state.context.pending : null;
    }
  }
  return null;
}

// Procesa la respuesta al pedido de nombre. Devuelve:
//  - null: el turno no era de nombre (no debería ocurrir con awaiting=NAME)
//  - { intercepted: true }: el bot ya respondio y encolo (fin del turno)
//  - { preface, content, customer }: continuar el flujo normal con ese contenido
async function handleNameReply({ customer, conversation, text, state }) {
  const norm = normalizeText(text);
  const pending = state.context && state.context.pending ? state.context.pending : null;

  // Si el nombre llego por otra via (pushName de WhatsApp, panel), no
  // preguntamos nada: se continua con la consulta pendiente tal qual.
  if (customerModel.isUsableName(customer.name)) {
    await stateModel.clear(customer.id);
    return { content: pending || text, customer };
  }

  // Prefiere no compartirlo: se deja de insistir y se atiende igual.
  if (NAME_DECLINE_RE.test(norm)) {
    await stateModel.markNameDeclined(customer.id);
    await logModel.record({
      eventType: 'name_declined',
      level: 'INFO',
      message: `${customer.phone} prefirio no compartir su nombre`,
      metadata: { customerId: customer.id },
    });
    return { preface: NAME_DECLINED_ACK, content: pending || text, customer };
  }

  // Se ve a un nombre: se guarda en el contacto y se continua la consulta.
  if (looksLikeName(norm)) {
    const updated = (await customerModel.setName(customer.id, text.trim())) || customer;
    await stateModel.clear(customer.id);
    await logModel.record({
      eventType: 'customer_name_captured',
      level: 'INFO',
      message: `Nombre y apellidos capturados para ${customer.phone}: ${text.trim()}`,
      metadata: { customerId: customer.id },
    });
    const firstName = String(updated.name || '').split(/\s+/)[0];
    return {
      preface: NAME_SAVED_THANKS.replace('{nombre}', firstName),
      content: pending || text,
      customer: updated,
    };
  }

  // Ignoro la pregunta y escribio algo mas (una consulta): se deja de
  // insistir y se atiende lo que mando.
  await stateModel.markNameDeclined(customer.id);
  await logModel.record({
    eventType: 'name_declined',
    level: 'INFO',
    message: `${customer.phone} no respondio con su nombre; el bot continua sin insistir`,
    metadata: { customerId: customer.id },
  });
  return { preface: NAME_DECLINED_ACK, content: text, customer };
}

// ---------------------------------------------------------------------
// Despachador del turno
// ---------------------------------------------------------------------

// Si el cliente esta en medio de algun flujo, lo atiende. Devuelve:
//  - null: no hay flujo activo (continuar normal)
//  - { intercepted: true }: el flujo respondio y quedo encolado
//  - { preface, content, customer }: continuar el flujo normal con esos datos
async function handleAwaiting({ customer, conversation, text }) {
  const state = await stateModel.get(customer.id);
  if (!state || !state.awaiting || state.awaiting === 'NONE') return null;
  if (state.awaiting === 'NAME') return handleNameReply({ customer, conversation, text, state });
  return null;
}

module.exports = {
  // mensajes
  NAME_PROMPT,
  // flujos
  startNameCapture,
  maybeClearNameFlow,
  handleAwaiting,
  // purezas (tests)
  normalizeText,
  looksLikeName,
};
