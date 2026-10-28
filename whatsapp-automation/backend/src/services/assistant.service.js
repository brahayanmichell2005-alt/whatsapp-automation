// Asistente personal: modos (disponible / ocupado / manual), comandos del
// dueno escritos desde su propio WhatsApp y resumen diario inteligente.
//
// Toda la configuracion vive en system_settings:
//   assistant_mode      AVAILABLE | BUSY | OFF        (default AVAILABLE)
//   busy_reply          texto para el modo ocupado    (default abajo)
//   owner_phone         telefono del dueno            (default 51910989309)
//   daily_summary_hour  hora (0-23, Lima) del resumen (default 8)
//   daily_summary_last  fecha (YYYY-MM-DD) del ultimo resumen enviado
//   office_start/office_end   'HH:MM' opcional: fuera de ese rago se atiende
//                       como ocupado (fuera de horario).
//
// Los comandos del dueno se detectan en los mensajes del chat del dueno y se
// ejecutan aunque el modo sea OFF (si estuviera apagado, siempre se puede
// volver a prender).

const { pool } = require('../config/database');
const settingsModel = require('../models/systemSetting.model');
const queueModel = require('../models/messageQueue.model');
const customerModel = require('../models/customer.model');
const conversationModel = require('../models/conversation.model');
const logModel = require('../models/automationLog.model');

const DEFAULT_BUSY_REPLY =
  'Hola, gracias por escribirme. En este momento estoy ocupado, pero revisaré tu mensaje y te responderé en cuanto pueda.';
const DEFAULT_OWNER_PHONE = '51910989309';

// Hora/fecha actual en Lima (America/Lima) para horarios del negocio.
function limaParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minutes: hour * 60 + Number(parts.minute),
    hhmm: `${String(hour).padStart(2, '0')}:${parts.minute}`,
  };
}

async function getSettings() {
  const all = await settingsModel.getAll();
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    mode: ['AVAILABLE', 'BUSY', 'OFF'].includes(String(all.assistant_mode))
      ? String(all.assistant_mode)
      : 'AVAILABLE',
    busyReply: String(all.busy_reply || DEFAULT_BUSY_REPLY),
    ownerPhone: String(all.owner_phone || DEFAULT_OWNER_PHONE).replace(/\D/g, ''),
    summaryHour: Math.max(0, Math.min(23, num(all.daily_summary_hour, 8))),
    summaryLast: all.daily_summary_last ? String(all.daily_summary_last) : null,
    officeStart: all.office_start ? String(all.office_start) : null,
    officeEnd: all.office_end ? String(all.office_end) : null,
  };
}

// Modo efectivo: si hay horario de atencion configurado y estamos fuera,
// se atiende como ocupado aunque el modo sea AVAILABLE.
async function effectiveMode() {
  const s = await getSettings();
  if (s.mode === 'AVAILABLE' && s.officeStart && s.officeEnd) {
    const toMin = (hhmm) => {
      const [h, m] = String(hhmm).split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const now = limaParts();
    if (now.minutes < toMin(s.officeStart) || now.minutes >= toMin(s.officeEnd)) {
      return { ...s, mode: 'BUSY', reason: 'fuera_de_horario', localTime: now.hhmm };
    }
  }
  return s;
}

// Detecta un comando del dueno. Devuelve null si no lo es o si no es el dueno.
// Puede devolver un string (accion simple) o un objeto para SEND_MESSAGE:
//   { action: 'SEND_MESSAGE', text, phone, name }
async function parseOwnerCommand(phone, text) {
  const s = await getSettings();
  if (String(phone).replace(/\D/g, '') !== s.ownerPhone) return null;
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  if (!t) return null;

  // Enviar un mensaje a un contacto: "envia <texto> a <numero|nombre>"
  // (se evalua primero para que frases como "envia modo ocupado a Juan"
  // no disparen los comandos de modo). Tambien entiende frases naturales:
  // "enviale un mensaje a Juan", "escríbele a Maria", "mandale que ya llegué a Pedro".
  const sendMatch = raw.match(
    /^(?:env[ií]a(?:le)?|m[aá]nda(?:le)?|escr[ií]bele?|escribe(?:le)?)\s+(.+)/i
  );
  if (sendMatch) {
    const rest = sendMatch[1].trim();
    // 0) Frase natural sin contenido de mensaje: "enviale un mensaje a Juan",
    //    "manda un saludo a Maria", "escríbele a Pedro" -> se pide el texto.
    const soloDestino =
      rest.match(
        /^(?:(?:un|este|ese)\s+)?(?:mensaje|sms|texto|aviso|saludo|recado)\s+a\s+(.+)$/i
      ) || rest.match(/^a\s+(.+)$/i);
    if (soloDestino) {
      const dest = soloDestino[1].trim();
      if (/^\+?\d[\d\s]{7,}\d$/.test(dest)) {
        return { action: 'SEND_MESSAGE', text: '', phone: dest.replace(/\D/g, ''), name: null };
      }
      return { action: 'SEND_MESSAGE', text: '', phone: null, name: dest };
    }
    // 0b) "enviale un mensaje que diga hola a Juan" -> texto + destino.
    const conDiga = rest.match(
      /^(?:(?:un|este|ese)\s+)?(?:mensaje|sms|texto|aviso|saludo|recado)\s+(?:que\s+diga\s+|diciendo\s+|de\s+)?(.*?)\s+a\s+(.+)$/i
    );
    if (conDiga && conDiga[1].trim()) {
      const dest = conDiga[2].trim();
      const text = conDiga[1].trim().replace(/^["']|["']$/g, '');
      if (/^\+?\d[\d\s]{7,}\d$/.test(dest)) {
        return { action: 'SEND_MESSAGE', text, phone: dest.replace(/\D/g, ''), name: null };
      }
      return { action: 'SEND_MESSAGE', text, phone: null, name: dest };
    }
    // 1) telefono al final: "... a +51999888777"
    const phoneAtEnd = rest.match(/^(.*?)\s+a\s+\+?(\d[\d\s]{7,}\d)\s*$/i);
    if (phoneAtEnd) {
      return {
        action: 'SEND_MESSAGE',
        text: phoneAtEnd[1].trim().replace(/^["']|["']$/g, ''),
        phone: phoneAtEnd[2].replace(/\D/g, ''),
        name: null,
      };
    }
    // 2) nombre al final: "... a Juan"
    const nameAtEnd = rest.match(/^(.*?)\s+a\s+([A-Za-z][A-Za-z0-9 .\u00C0-\u017F]{1,40})\s*$/i);
    if (nameAtEnd) {
      return {
        action: 'SEND_MESSAGE',
        text: nameAtEnd[1].trim().replace(/^["']|["']$/g, ''),
        phone: null,
        name: nameAtEnd[2].trim(),
      };
    }
    return 'SEND_HELP';
  }

  if (/(resumen|reporte).*(d[ií]a|hoy|24)|dame el resumen/.test(t)) return 'SUMMARY';
  if (/(modo\s*)?(estoy\s*)?ocupado|no molestar/.test(t) && !/disponible/.test(t)) return 'SET_BUSY';
  if (/modo disponible|estoy disponible|modo activo|activa(el)? (bot|asistente)|prende el bot/.test(t))
    return 'SET_AVAILABLE';
  if (/modo manual|silenciar|apaga(r)? (el )?(bot|asistente)|no respondas (mas|autom)/.test(t))
    return 'SET_OFF';
  if (/estado del (bot|asistente)|en que modo estas|cual es tu modo/.test(t)) return 'STATUS';

  return null;
}

// Ejecuta un comando del dueno y devuelve el texto de confirmacion.
async function executeOwnerCommand(command, ownerCustomer) {
  // Comandos con datos (objetos): enviar mensaje a un contacto.
  if (command && typeof command === 'object') {
    if (command.action === 'SEND_MESSAGE') return sendToContact(command);
    return null;
  }
  const s = await getSettings();
  switch (command) {
    case 'SET_BUSY':
      await settingsModel.set('assistant_mode', 'BUSY');
      await logModel.record({
        eventType: 'assistant_mode_changed',
        level: 'INFO',
        message: 'Modo OCUPADO activado por el dueno',
      });
      return 'Listo 👍 modo ocupado activado. Ahora aviso a quien me escriba que estas ocupado. Dime "modo disponible" cuando quieras volver.';
    case 'SET_AVAILABLE':
      await settingsModel.set('assistant_mode', 'AVAILABLE');
      await logModel.record({
        eventType: 'assistant_mode_changed',
        level: 'INFO',
        message: 'Modo DISPONIBLE activado por el dueno',
      });
      return 'Listo ✅ modo disponible. Vuelvo a atender normal con la IA.';
    case 'SET_OFF':
      await settingsModel.set('assistant_mode', 'OFF');
      await logModel.record({
        eventType: 'assistant_mode_changed',
        level: 'INFO',
        message: 'Modo MANUAL (OFF) activado por el dueno',
      });
      return 'Silencio activado 🤫 no voy a responder automaticamente. Dime "modo disponible" (o "modo ocupado") para reactivarme.';
    case 'STATUS': {
      const pend = await pool.query("SELECT COUNT(*)::int AS n FROM message_queue WHERE status = 'PENDING'");
      const extra =
        s.officeStart && s.officeEnd ? `, horario de atención ${s.officeStart} a ${s.officeEnd} (Lima)` : '';
      return `Estado del asistente: modo ${s.mode}${extra}. Mensajes en cola pendientes: ${pend.rows[0].n}. Clientes registrados: activos en la base. Tu resumen diario sale a las ${s.summaryHour}:00 (Lima).`;
    }
    case 'SUMMARY': {
      const text = await buildDailySummary();
      return text;
    }
    case 'SEND_HELP':
      return 'Con gusto 😊 mándame: envia <texto> a <numero>. Ejemplo: envia Hola, ya te mando la info a 51987654321. También sirve con el nombre exacto de un cliente registrado: envia Hola a Juan.';
    default:
      return null;
  }
}

// Envia el texto del dueno a un contacto (por numero o por nombre registrado).
// Si el destino se encuentra pero falta el texto, pregunta que decir.
async function sendToContact({ text, phone, name }) {
  const clean = String(text || '').trim();
  const destinoLabel = phone ? phone : `"${name}"`;

  let customer = null;
  if (phone) {
    customer = await customerModel.findOrCreateByPhone(phone, null, null);
  } else if (name) {
    const { rows } = await pool.query(
      'SELECT id, phone, name FROM customers WHERE LOWER(name) LIKE LOWER($1) ORDER BY updated_at DESC NULLS LAST LIMIT 5',
      [`%${name}%`]
    );
    if (!rows.length) {
      return `No tengo ningún contacto registrado como "${name}". Puedo enviarle el mensaje por número: envia ${clean || '<texto>'} a <numero>.`;
    }
    if (rows.length > 1) {
      const lista = rows.map((r) => `${r.name} (${r.phone})`).join(', ');
      return `Encontré varios con ese nombre: ${lista}. Especifica el número: envia ${clean || '<texto>'} a <numero>.`;
    }
    customer = await customerModel.findOrCreateByPhone(rows[0].phone, null, null);
  } else {
    return 'Necesito el destino: envia <texto> a <numero>.';
  }

  if (!clean) {
    const quien = customer.name || customer.phone;
    return `¿Qué texto quieres que le mande a ${quien}? Escríbelo así: envia <texto> a ${destinoLabel}.`;
  }

  await queueModel.enqueue({ customerId: customer.id, phone: customer.phone, message: clean });
  const worker = require('../workers/message.worker');
  await worker.tick({ budgetMs: 20000 });
  await logModel.record({
    eventType: 'owner_direct_send',
    level: 'INFO',
    message: `El dueno envio un mensaje manual a ${customer.phone}`,
    metadata: { customerId: customer.id },
  });
  return `Listo ✅ Envié tu mensaje a ${customer.name || customer.phone}: "${clean.slice(0, 80)}"`;
}

// Resumen inteligente de las ultimas 24 horas (texto plano, priorizado).
async function buildDailySummary() {
  const s = await getSettings();
  const { rows: conv } = await pool.query(
    `
    SELECT c.name, c.phone, COUNT(*)::int AS entraron,
           MAX(m.created_at) AS last_at,
           (SELECT m2.direction FROM messages m2
             WHERE m2.customer_id = c.id
             ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS last_dir,
           (SELECT m3.content FROM messages m3
             WHERE m3.customer_id = c.id
             ORDER BY m3.created_at DESC, m3.id DESC LIMIT 1) AS last_msg
    FROM messages m
    JOIN customers c ON c.id = m.customer_id
    WHERE m.direction = 'INBOUND'
      AND m.created_at > NOW() - INTERVAL '24 hours'
      AND REPLACE(c.phone, ' ', '') <> $1
    GROUP BY c.id, c.name, c.phone
    ORDER BY MAX(m.created_at) DESC
    LIMIT 10`,
    [s.ownerPhone]
  );

  const { rows: pend } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM message_queue WHERE status = 'PENDING'"
  );
  const { rows: nuevos } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM customers WHERE created_at > NOW() - INTERVAL '24 hours'"
  );

  const now = limaParts();
  const totalEntraron = conv.reduce((a, c) => a + c.entraron, 0);
  const sinResponder = conv.filter((c) => c.last_dir === 'INBOUND');
  const hhmm = (v) => {
    try {
      return new Intl.DateTimeFormat('es-PE', {
        timeZone: 'America/Lima',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(v));
    } catch {
      return '?';
    }
  };

  const lines = [];
  lines.push(`📋 *Resumen de las últimas 24h* (${now.date} ${now.hhmm} Lima)`);
  lines.push(`Mensajes recibidos: ${totalEntraron} de ${conv.length} cliente(s). Nuevos clientes: ${nuevos[0].n}. En cola pendiente: ${pend[0].n}.`);
  if (sinResponder.length) {
    lines.push('');
    lines.push('*⏳ Sin respuesta (prioridad):*');
    for (const c of sinResponder.slice(0, 5)) {
      lines.push(`- ${c.name || c.phone} (${hhmm(c.last_at)}): ${String(c.last_msg || '').slice(0, 60)}`);
    }
  }
  if (conv.length) {
    lines.push('');
    lines.push('*💬 Actividad reciente:*');
    for (const c of conv.slice(0, 5)) {
      const marquin = c.last_dir === 'INBOUND' ? '⏳' : '✅';
      lines.push(`${marquin} ${c.name || c.phone} — ${c.entraron} msj, último ${hhmm(c.last_at)}`);
    }
  } else {
    lines.push('');
    lines.push('Sin mensajes de clientes en las últimas 24 horas. Todo en calma 😴');
  }
  lines.push('');
  lines.push('Prioridad sugerida: contestar primero a los marcados con ⏳.');
  return lines.join('\n');
}

// Envia un texto al dueno (por la cola, con envio inmediato).
async function sendToOwner(text) {
  const s = await getSettings();
  const customer = await customerModel.findOrCreateByPhone(s.ownerPhone, 'Dueño', null);
  await conversationModel.findOrCreateOpenByCustomer(customer.id);
  await queueModel.enqueue({ customerId: customer.id, phone: customer.phone, message: text });
  const worker = require('../workers/message.worker');
  await worker.tick({ budgetMs: 20000 });
  await logModel.record({
    eventType: 'daily_summary_sent',
    level: 'INFO',
    message: `Resumen enviado al dueno (${s.ownerPhone})`,
  });
}

// Tarea diaria: la llama /api/cron/tick. Envia el resumen una vez al dia
// a la hora configurada (hora de Lima).
async function dailyTick() {
  const s = await getSettings();
  const now = limaParts();
  if (now.hour !== s.summaryHour) return { skipped: 'fuera_de_hora', hora: now.hhmm };
  if (s.summaryLast === now.date) return { skipped: 'ya_enviado' };
  const text = await buildDailySummary();
  await sendToOwner(text);
  await settingsModel.set('daily_summary_last', now.date);
  return { sent: true };
}

module.exports = {
  getSettings,
  effectiveMode,
  parseOwnerCommand,
  executeOwnerCommand,
  buildDailySummary,
  sendToOwner,
  dailyTick,
};
