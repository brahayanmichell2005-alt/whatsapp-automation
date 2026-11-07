// Asistente: modos (disponible / ocupado / manual), horario de atencion y
// resumen inteligente de las ultimas 24h.
//
// La configuracion vive en system_settings:
//   assistant_mode      AVAILABLE | BUSY | OFF        (default AVAILABLE)
//   busy_reply          texto para el modo ocupado
//   office_start/office_end   'HH:MM' opcional: fuera de ese rango se atiende
//                       como ocupado (fuera de horario).
//
// El sistema de comandos del dueno escritos en su chat personal de WhatsApp
// se ELIMINO: el dueño controla el asistente desde el chat integrado del
// panel (endpoint /api/assistant/chat). El resumen de actividad se consulta
// ahi mismo; ya no se envia solo al auto-chat.

const { pool } = require('../config/database');
const settingsModel = require('../models/systemSetting.model');

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
    // El numero del dueno solo se usa para excluir su propio trafico del
    // resumen de actividad (no hay ya ninguna conversacion consigo mismo).
    ownerPhone: String(all.owner_phone || DEFAULT_OWNER_PHONE).replace(/\D/g, ''),
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

// Resumen inteligente de las ultimas 24 horas (texto plano, priorizado).
// Herramienta del chat del asistente del panel: el dueño lo pide ahi.
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

// Estadisticas vivas del sistema (datos reales de la BD, no simulados).
// Herramienta del chat del asistente: respuestas como "cuantos clientes
// tengo" o "cuantos mensajes en cola" salen de aqui.
async function systemStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM customers) AS clientes,
      (SELECT COUNT(*)::int FROM customers WHERE created_at > NOW() - INTERVAL '24 hours') AS clientes_nuevos_24h,
      (SELECT COUNT(*)::int FROM conversations WHERE status = 'OPEN') AS conversaciones_abiertas,
      (SELECT COUNT(*)::int FROM messages WHERE direction = 'INBOUND' AND created_at > NOW() - INTERVAL '24 hours') AS entrantes_24h,
      (SELECT COUNT(*)::int FROM messages WHERE direction = 'OUTBOUND' AND created_at > NOW() - INTERVAL '24 hours') AS salientes_24h,
      (SELECT COUNT(*)::int FROM message_queue WHERE status = 'PENDING') AS cola_pendiente,
      (SELECT COUNT(*)::int FROM message_queue WHERE status = 'FAILED') AS cola_fallidos,
      (SELECT COUNT(*)::int FROM scheduled_messages WHERE status = 'PENDING') AS programados
  `);
  const stats = rows[0] || {};
  const mode = await effectiveMode();
  return { ...stats, asistente_mode: mode.mode };
}

module.exports = {
  getSettings,
  effectiveMode,
  buildDailySummary,
  systemStats,
};
