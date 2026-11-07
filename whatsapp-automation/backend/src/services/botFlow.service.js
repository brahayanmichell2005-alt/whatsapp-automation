// Flujos conversacionales solicitados en PLANTILLAS-CRM-BOT.md:
//
//  1) Pedir nombre y apellidos cuando todavia no los conocemos, guardarlos
//     en el contacto y continuar con la consulta original. Si el cliente
//     prefiere no compartirlos, se deja de insistir y se le atiende igual.
//
//  2) Cuando la persona pide una reserva o una cita: preguntar fecha y hora
//     (horario de trabajo 09:00 a. m. a 08:00 p. m.), pedir solamente el
//     dato que falte, repetir ambos datos y verificar que el horario este
//     disponible ANTES de presentar la reserva como confirmada. Si la hora
//     cae fuera del rango, se explica y se pide otra dentro del horario.
//
// Las funciones de parsing/validacion son puras (se exportan para tests);
// las funciones handle* son las que tocan la base de datos y la cola.

const customerModel = require('../models/customer.model');
const stateModel = require('../models/botState.model');
const reservationModel = require('../models/reservation.model');
const logModel = require('../models/automationLog.model');
const queueModel = require('../models/messageQueue.model');
const logger = require('../utils/logger');
const businessHours = require('../utils/businessHours');
const env = require('../config/env');

// ---------------------------------------------------------------------
// Mensajes del flujo
// ---------------------------------------------------------------------

const NAME_PROMPT =
  'Para poder atenderte mejor, ¿me compartes tu nombre y apellidos, por favor? 😊';

const NAME_DECLINED_ACK = 'No hay problema 😊 Te ayudo igual. ';

const NAME_SAVED_THANKS = '¡Gracias, {nombre}! 😊 Con gusto sigo con tu solicitud.';

const RESERVATION_QUESTION =
  '¡Con gusto te ayudo con tu reserva o cita! 📅 Nuestro horario es de 09:00 a. m. a 08:00 p. m. ' +
  '¿Qué fecha y hora dentro de ese horario prefieres?';

const RESERVATION_MISSING_TIME =
  'Perfecto, anotado el día ✅ ¿Y a qué hora prefieres? Recuerda que atendemos de 09:00 a. m. a 08:00 p. m.';

const RESERVATION_MISSING_DATE =
  'Perfecto, anotada la hora ✅ ¿Qué día te va bien para tu reserva?';

const RESERVATION_OUT_OF_RANGE =
  'Esa hora está fuera de nuestro horario de atención 🙏 Atendemos de 09:00 a. m. a 08:00 p. m. ' +
  '¿Me indicas otra hora dentro de ese rango, por favor?';

const RESERVATION_CONFIRM_REASK =
  '¿Me confirmas tu reserva con esos datos? Responde SÍ para confirmar o NO para cambiarlos. 🙏';

const RESERVATION_UNAVAILABLE =
  'Revisé la agenda y esa fecha u hora ya no está disponible 😔 ¿Me dices otra fecha y hora dentro del horario de 09:00 a. m. a 08:00 p. m.?';

const RESERVATION_CANCELLED =
  'No hay problema, cancelé esa reserva 🙏 ¿Te ayudo con algo más?';

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

const RESERVATION_INTENT_RE =
  /(reserv[ae]|\bcita\b|agend|apartar|programar|separar.*(dia|hora|fecha)|\bturno\b|una hora de atencion)/;

function detectReservationIntent(text) {
  return RESERVATION_INTENT_RE.test(normalizeText(text));
}

// ---------------------------------------------------------------------
// Parsing de HORA (puro)
// ---------------------------------------------------------------------

// Ventana de atencion permitida: 09:00 a. m. a 08:00 p. m. (inclusive).
const OPEN_MINUTES = 9 * 60; // 09:00
const CLOSE_MINUTES = 20 * 60; // 20:00

// Convierte "3 pm", "15:00", "3 de la tarde", "8:45 a. m." etc. a 24h.
// Devuelve { hour, minute, marker } o null si no se entiende.
// Sin marcador, 1-7 se asumen de la tarde (7 pm = 19); 8+ se leen tal
// cual (formato 24h), asi "20" = 8 de la noche y "15" = 3 de la tarde.
function parseTimeText(raw) {
  const text = normalizeText(raw)
    // Primero las frases en espanol (evitan confundirse con la forma "a. m.").
    .replace(/de la manana/g, ' am')
    .replace(/de la (tarde|noche)/g, ' pm')
    .replace(/del mediodia/g, ' pm')
    .replace(/medio ?dia/g, ' 12 pm')
    // Luego "a. m." / "a m" / "am", con guardas para no cortar palabras
    // (cama, programame, promedio...).
    .replace(/(?<![a-z])\s*a\.?\s*m\.?(?![a-z])/g, ' am')
    .replace(/(?<![a-z])\s*p\.?\s*m\.?(?![a-z])/g, ' pm')
    .replace(/\s+/g, ' ')
    .trim();

  const markerMatch = text.match(/\b(am|pm)\b/);
  const marker = markerMatch ? markerMatch[1] : null;

  // Hora con minutos explícitos: "15:30", "3h30", "3.30 pm".
  const full = text.match(/(\d{1,2})\s*[:h.]\s*(\d{2})\b/);
  // "20h": hora sin minutos con sufijo h.
  const suffixed = !full ? text.match(/\b(\d{1,2})\s*h\b/) : null;
  // Solo la hora: "3 pm", "a las 9".
  const simple = !full && !suffixed ? text.match(/\b(\d{1,2})\b/) : null;

  let hour = null;
  let minute = 0;
  if (full) {
    hour = parseInt(full[1], 10);
    minute = parseInt(full[2], 10);
  } else if (suffixed) {
    hour = parseInt(suffixed[1], 10);
  } else if (simple) {
    hour = parseInt(simple[1], 10);
  }
  if (hour === null || Number.isNaN(hour) || hour > 23 || minute > 59) return null;

  if (marker === 'am') {
    if (hour === 12) hour = 0; // 12 am = medianoche
  } else if (marker === 'pm') {
    if (hour >= 1 && hour <= 11) hour += 12;
  } else if (hour <= 7) {
    hour += 12; // "a las 3" se entiende como 3 de la tarde
  }

  return { hour, minute, marker: Boolean(marker) };
}

function toMinutes({ hour, minute }) {
  return hour * 60 + minute;
}

// La hora pedida debe caer en la ventana de atencion.
function isTimeInRange(time) {
  if (!time) return true; // sin hora no se evalua rango
  const mins = toMinutes(time);
  return mins >= OPEN_MINUTES && mins <= CLOSE_MINUTES;
}

function formatTimeLabel(time) {
  if (!time) return '';
  const { hour, minute } = time;
  const hour12Raw = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'a. m.' : 'p. m.';
  return `${hour12Raw}:${String(minute).padStart(2, '0')} ${suffix}`;
}

// ---------------------------------------------------------------------
// Parsing de FECHA (puro)
// ---------------------------------------------------------------------

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// Hoy (y su hora) en la zona horaria del negocio — no en la del servidor.
function todayInTimezone(now = new Date()) {
  const tz = env.TIMEZONE || 'America/Guatemala';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return { year: get('year'), month: get('month'), day: get('day'), minuteOfDay: get('hour') * 60 + get('minute') };
}

function makeDate({ year, month, day }) {
  return { year, month, day };
}

function addDays(date, days) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day));
  d.setUTCDate(d.getUTCDate() + days);
  return makeDate({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
}

function compareDates(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

// Entiende "hoy", "manana", "pasado manana", "25/12", "12 de noviembre",
// "viernes". Devuelve { date, label } o null. Un anio sin digitos en el
// mensaje se resuelve como el anio en curso (o el siguiente si ya paso).
function parseDateText(raw, today = todayInTimezone()) {
  const norm = normalizeText(raw);
  if (!norm) return null;

  const base = makeDate(today);

  if (/pasado manana/.test(norm)) return { date: addDays(base, 2), label: null };
  if (/\bmanana\b/.test(norm)) return { date: addDays(base, 1), label: null };
  if (/\bhoy\b/.test(norm)) return { date: base, label: null };

  // Dia de la semana ("el viernes"): la proxima ocurrencia (o hoy si coincide).
  const weekday = DIAS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(norm));
  if (weekday >= 0) {
    const todayWd = new Date(Date.UTC(base.year, base.month - 1, base.day)).getUTCDay();
    let delta = (weekday - todayWd + 7) % 7;
    if (delta === 0) delta = 7; // "el viernes" dichó un viernes => el próximo
    return { date: addDays(base, delta), label: null };
  }

  // "12 de noviembre" [de 2027]
  const named = norm.match(/(\d{1,2})\s+de\s+([a-z]+)/);
  if (named) {
    const month = MESES.indexOf(named[2]);
    if (month >= 0) {
      return {
        date: resolveYMD(parseInt(named[1], 10), month + 1, null, base),
        label: null,
      };
    }
  }

  // "25/12", "25-12-2027"
  const numeric = norm.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numeric) {
    let year = numeric[3] ? parseInt(numeric[3], 10) : null;
    if (year !== null && year < 100) year += 2000;
    return {
      date: resolveYMD(parseInt(numeric[1], 10), parseInt(numeric[2], 10), year, base),
      label: null,
    };
  }

  return null;
}

// Completa el anio faltante; si la fecha ya paso este anio, pone el proximo.
function resolveYMD(day, month, year, today) {
  const y = year || today.year;
  const date = makeDate({ year: y, month, day });
  if (!year && compareDates(date, today) < 0) return makeDate({ year: y + 1, month, day });
  return date;
}

function formatDateLabel(date) {
  if (!date) return '';
  const wd = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return `${DIAS[wd]} ${date.day} de ${MESES[date.month - 1]} de ${date.year}`;
}

// ---------------------------------------------------------------------
// Disponibilidad
// ---------------------------------------------------------------------

// Verifica el "slot": dentro del horario 09:00-20:00 y con fecha presente
// o futura (si es hoy, la hora no puede haber pasado). Es el único
// calendario disponible hoy; cuando haya agenda real en el CRM, esta es
// la funcion a extender para consultar citas existentes.
// `context.date` y `context.time` llegan como los objetos guardados por el
// flujo (con .date de calendario y .hour/.minute de 24h respectivamente).
function isSlotAvailable(context, now = new Date()) {
  if (!context || !context.date || !context.date.date || !context.time) return false;
  const today = todayInTimezone(now);
  const time = context.time.hour !== undefined ? context.time : parseTimeText(context.time);
  if (!time || !isTimeInRange(time)) return false;
  const dayDiff = compareDates(context.date.date, today);
  if (dayDiff < 0) return false;
  if (dayDiff === 0 && toMinutes(time) <= today.minuteOfDay) return false;
  return true;
}

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
// Flujo 2: reservas y citas (fecha + hora)
// ---------------------------------------------------------------------

async function startReservation({ customer, conversation }) {
  await stateModel.set(customer.id, 'RESERVATION_WHEN', {});
  await logModel.record({
    eventType: 'reservation_started',
    level: 'INFO',
    message: `Solicitud de reserva/cita detectada para ${customer.phone}`,
    metadata: { customerId: customer.id, conversationId: conversation ? conversation.id : null },
  });
  await sendAndLog({
    customer,
    conversation,
    message: RESERVATION_QUESTION,
    eventType: 'auto_reply_queued',
  });
  return true;
}

async function handleReservationReply({ customer, conversation, text, state }) {
  const norm = normalizeText(text);
  const today = todayInTimezone();
  const dateParsed = parseDateText(text, today);
  const timeParsed = parseTimeText(text);

  // Que sea una fecha distinta a la ya anotada? Si el mensaje trae datos
  // nuevos, se actualizan (el cliente esta corrigiendo).
  const bringsData = dateParsed || (timeParsed && isTimeInRange(timeParsed));
  const bringsOutOfRange = timeParsed && !isTimeInRange(timeParsed);

  if (state.awaiting === 'RESERVATION_WHEN') {
    if (bringsOutOfRange) {
      await sendAndLog({
        customer,
        conversation,
        message: RESERVATION_OUT_OF_RANGE,
        eventType: 'auto_reply_queued',
      });
      return { intercepted: true };
    }
    if (!bringsData) {
      await sendAndLog({
        customer,
        conversation,
        message: RESERVATION_QUESTION,
        eventType: 'auto_reply_queued',
      });
      return { intercepted: true };
    }

    const ctx = {
      date: dateParsed ? { ...dateParsed, source: text } : state.context.date || null,
      time: timeParsed ? { ...timeParsed, source: text } : state.context.time || null,
    };

    if (ctx.date && !ctx.time) {
      await stateModel.set(customer.id, 'RESERVATION_WHEN', ctx);
      await sendAndLog({
        customer,
        conversation,
        message: RESERVATION_MISSING_TIME,
        eventType: 'auto_reply_queued',
      });
      return { intercepted: true };
    }
    if (ctx.time && !ctx.date) {
      await stateModel.set(customer.id, 'RESERVATION_WHEN', ctx);
      await sendAndLog({
        customer,
        conversation,
        message: RESERVATION_MISSING_DATE,
        eventType: 'auto_reply_queued',
      });
      return { intercepted: true };
    }

    // Fecha y hora completas: se repiten y se pide confirmacion (todavia
    // NO se presenta como confirmada).
    await stateModel.set(customer.id, 'RESERVATION_CONFIRM', ctx);
    const summary =
      `Te repito los datos de tu reserva para confirmar:\n` +
      `📅 ${formatDateLabel(ctx.date.date)}\n` +
      `⏰ ${formatTimeLabel(ctx.time)}\n\n` +
      RESERVATION_CONFIRM_REASK;
    await sendAndLog({
      customer,
      conversation,
      message: summary,
      eventType: 'auto_reply_queued',
    });
    return { intercepted: true };
  }

  // ---- RESERVATION_CONFIRM ----
  if (bringsData && !/^no\b/.test(norm)) {
    // Correccion de datos antes de confirmar: se re-anotan y se re-preguntan.
    if (bringsOutOfRange) {
      await sendAndLog({
        customer,
        conversation,
        message: RESERVATION_OUT_OF_RANGE,
        eventType: 'auto_reply_queued',
      });
      return { intercepted: true };
    }
    const ctx = {
      date: dateParsed ? { ...dateParsed, source: text } : state.context.date || null,
      time: timeParsed ? { ...timeParsed, source: text } : state.context.time || null,
    };
    if (ctx.date && ctx.time) {
      await stateModel.set(customer.id, 'RESERVATION_CONFIRM', ctx);
      const summary =
        `Te repito los datos de tu reserva para confirmar:\n` +
        `📅 ${formatDateLabel(ctx.date.date)}\n` +
        `⏰ ${formatTimeLabel(ctx.time)}\n\n` +
        RESERVATION_CONFIRM_REASK;
      await sendAndLog({ customer, conversation, message: summary, eventType: 'auto_reply_queued' });
      return { intercepted: true };
    }
    await stateModel.set(customer.id, 'RESERVATION_WHEN', ctx);
    const ask = ctx.date ? RESERVATION_MISSING_TIME : RESERVATION_MISSING_DATE;
    await sendAndLog({ customer, conversation, message: ask, eventType: 'auto_reply_queued' });
    return { intercepted: true };
  }

  const saysYes = /\b(si|claro|dale|vale|ok|okay|okey|perfecto|correcto|listo|yes|de acuerdo|confirmo|asies|asi es|va)\b/.test(norm);
  const saysNo = /(\bno\b|cancela?r?|todavia no|mejor no|cambiar)/.test(norm);

  if (saysYes) {
    const available = isSlotAvailable(state.context, new Date());
    if (available) {
      // ---- Disponibilidad real contra la agenda (`reservations`) ----
      // Aparte del horario del negocio, se verifica que no exista otra
      // reserva confirmada en ese minuto (excluyendo al propio cliente,
      // que puede re-confirmar lo suyo sin error).
      const startAt = reservationModel.toStartAtIso(state.context.date.date, state.context.time);
      let taken = false;
      try {
        taken = startAt
          ? await reservationModel.isTaken(startAt, customer.phone || null)
          : false;
      } catch (err) {
        logger.error({ err: err.message }, 'No se pudo verificar disponibilidad de la reserva');
      }
      if (taken) {
        await stateModel.set(customer.id, 'RESERVATION_WHEN', {});
        await sendAndLog({
          customer,
          conversation,
          message: RESERVATION_UNAVAILABLE,
          eventType: 'auto_reply_queued',
        });
        return { intercepted: true };
      }

      // ---- Persistir la reserva en la tabla `reservations` ----
      let reservation = null;
      try {
        reservation = await reservationModel.confirm({
          customerId: customer.id,
          phone: customer.phone,
          startAt,
          dateText: formatDateLabel(state.context.date.date),
          timeText: formatTimeLabel(state.context.time),
        });
      } catch (err) {
        // Sin la tabla no se bloquea el bot: la respuesta sale igual.
        logger.error({ err: err.message }, 'No se pudo guardar la reserva');
      }
      await stateModel.clear(customer.id);
      const confirmation =
        `✅ ¡Tu reserva quedó confirmada!\n` +
        `📅 ${formatDateLabel(state.context.date.date)}\n` +
        `⏰ ${formatTimeLabel(state.context.time)}\n` +
        (reservation ? `🎫 Reserva N° ${reservation.id}\n` : '') +
        '\nTe esperamos; si necesitas cambiarla, escríbenos con gusto. 🙌';
      await logModel.record({
        eventType: 'reservation_confirmed',
        level: 'INFO',
        message: `Reserva confirmada para ${customer.phone} (${formatDateLabel(state.context.date.date)} ${formatTimeLabel(state.context.time)})${reservation ? `, N° ${reservation.id}` : ''}`,
        metadata: {
          customerId: customer.id,
          conversationId: conversation ? conversation.id : null,
          reservationId: reservation ? reservation.id : null,
          reservation: { startAt, date: formatDateLabel(state.context.date.date), time: formatTimeLabel(state.context.time) },
        },
      });
      await sendAndLog({ customer, conversation, message: confirmation, eventType: 'reservation_confirmed' });
    } else {
      await stateModel.set(customer.id, 'RESERVATION_WHEN', {});
      await sendAndLog({
        customer,
        conversation,
        message: RESERVATION_UNAVAILABLE,
        eventType: 'auto_reply_queued',
      });
    }
    return { intercepted: true };
  }

  if (saysNo) {
    await stateModel.clear(customer.id);
    await logModel.record({
      eventType: 'reservation_cancelled',
      level: 'INFO',
      message: `Reserva cancelada por ${customer.phone} antes de confirmar`,
      metadata: { customerId: customer.id },
    });
    await sendAndLog({
      customer,
      conversation,
      message: RESERVATION_CANCELLED,
      eventType: 'reservation_cancelled',
    });
    return { intercepted: true };
  }

  // No se entendio la respuesta: se vuelve a pedir confirmacion.
  await sendAndLog({
    customer,
    conversation,
    message: RESERVATION_CONFIRM_REASK,
    eventType: 'auto_reply_queued',
  });
  return { intercepted: true };
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
  if (state.awaiting === 'RESERVATION_WHEN' || state.awaiting === 'RESERVATION_CONFIRM') {
    return handleReservationReply({ customer, conversation, text, state });
  }
  return null;
}

module.exports = {
  // mensajes
  NAME_PROMPT,
  RESERVATION_QUESTION,
  // flujos
  startNameCapture,
  maybeClearNameFlow,
  startReservation,
  handleAwaiting,
  detectReservationIntent,
  // purezas (tests)
  normalizeText,
  looksLikeName,
  parseTimeText,
  parseDateText,
  isTimeInRange,
  isSlotAvailable,
  formatTimeLabel,
  formatDateLabel,
  toMinutes,
};
