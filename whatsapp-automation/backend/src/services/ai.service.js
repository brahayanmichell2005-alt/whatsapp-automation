// Capa de IA (Seccion 23). Se activa solo si AI_PROVIDER esta configurado:
//   none | gemini | openai | anthropic | ollama
// Hace dos cosas: clasificar el interes del cliente y redactar respuestas
// conversacionales a partir del historial. Nunca envia nada por si sola:
// quien encola el envio es messageIntake.service.js.

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

// Toda la configuracion se lee desde config/env.js (unico punto de verdad),
// no directamente de process.env.
const AI_PROVIDER = env.AI_PROVIDER;
const AI_MODEL = env.AI_MODEL;
const OLLAMA_BASE_URL = env.OLLAMA_BASE_URL;
const OPENAI_API_KEY = env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const BOT_OWNER = env.BOT_OWNER;
const BOT_PERSONA = env.BOT_PERSONA;

// Tiempo maximo total por intento de IA. Antes cada modelo/endpoint podia
// esperar 20 s y el webhook terminaba superando el limite de Vercel, por lo
// que algunos mensajes entrantes se perdian. Ahora se corta rapido y se cae
// al motor de reglas.
const CHAT_DEADLINE_MS = 25000;

let lastError = null;
let lastModel = null;
function describeError(err) {
  const st = err && err.response && err.response.status;
  const msg = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) || (err && err.message) || 'error desconocido';
  return `${AI_PROVIDER}${st ? ` HTTP ${st}` : ''}: ${String(msg)}`
    .split(GEMINI_API_KEY || '\u0000').join('***')
    .split(OPENAI_API_KEY || '\u0000').join('***')
    .split(ANTHROPIC_API_KEY || '\u0000').join('***')
    .slice(0, 300);
}
function getLastError() {
  return lastError;
}
function getLastModel() {
  return lastModel;
}

function isEnabled() {
  if (!AI_PROVIDER || AI_PROVIDER === 'none') return false;
  // Un proveedor sin credenciales no esta realmente disponible: si lo
  // trataramos como activo, el bot quedaria mudo tras el primer mensaje.
  switch (AI_PROVIDER) {
    case 'gemini':
      return Boolean(GEMINI_API_KEY);
    case 'openai':
      return Boolean(OPENAI_API_KEY);
    case 'anthropic':
      return Boolean(ANTHROPIC_API_KEY);
    case 'ollama':
      return Boolean(OLLAMA_BASE_URL);
    default:
      return false;
  }
}

// messages: [{ role: 'user' | 'assistant', content }]  (empieza y termina en 'user')
async function chat(system, messages, maxTokens, opts = {}) {
  const deadline = Date.now() + CHAT_DEADLINE_MS;
  const remaining = () => deadline - Date.now();
  const timeoutFor = () => Math.max(2000, Math.min(20000, remaining()));
  switch (AI_PROVIDER) {
    case 'gemini': {
      // La Interactions API recibe el historial como texto (o como contenido
      // multimodal). Para una sola instruccion se envia tal cual; para una
      // conversacion se etiquetan los turnos para conservar el contexto.
      const transcript =
        messages.length === 1
          ? String(messages[0].content || '')
          : messages
              .map(
                (m) =>
                  `${m.role === 'assistant' ? 'Asistente' : 'Cliente'}: ${String(
                    m.content || ''
                  ).trim()}`
              )
              .join('\n');
      // La clave configurada autentica con ?key= en la Interactions API. La
      // cabecera x-goog-api-key se queda esperando indefinidamente con esta
      // cuenta, por eso no se usa aqui.
      const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(
        GEMINI_API_KEY
      )}`;
      // 3.8/3.6 pueden estar saturados (503 high demand) y consumen el
      // presupuesto de tiempo antes de llegar al modelo que sí responde.
      // Se intenta primero el lite, que es el más estable ahora mismo.
      const models = [
        ...new Set([
          'gemini-3.5-flash-lite',
          AI_MODEL || 'gemini-3.8-flash',
          'gemini-3.6-flash',
        ]),
      ];
      let lastErr;
      // Busqueda web (Google Search grounding): se activa cuando la persona
      // pide investigar algo. Si la API rechaza la herramienta, se reintenta
      // sin ella para no dejar al bot mudo.
      let searchTool = Boolean(opts.search);
      for (const model of models) {
        if (remaining() <= 1500) break;
        const body = {
          model,
          input: transcript,
          store: false,
          ...(system ? { system_instruction: system } : {}),
          generation_config: {
            max_output_tokens: maxTokens,
            temperature: 0.7,
            thinking_level: 'low',
          },
        };
        if (searchTool) body.tools = [{ google_search: {} }];
        try {
          const { data } = await axios.post(url, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: Math.min(15000, timeoutFor()),
          });
          const direct =
            typeof data?.output_text === 'string' ? data.output_text.trim() : '';
          const steps = Array.isArray(data?.steps) ? data.steps : [];
          const fromSteps = steps
            .filter((s) => s && s.type === 'model_output')
            .flatMap((s) => (Array.isArray(s.content) ? s.content : []))
            .filter((c) => c && c.type === 'text')
            .map((c) => c.text || '')
            .join('')
            .trim();
          const text = direct || fromSteps;
          if (text) {
            lastModel = model;
            return text;
          }
          lastErr = new Error(`Gemini respondio sin texto (${model})`);
        } catch (err) {
          lastErr = err;
          const st = err && err.response && err.response.status;
          // La herramienta de busqueda no es aceptada por este modelo/endpoint:
          // se reintenta sin ella.
          if (searchTool && st === 400) {
            searchTool = false;
            continue;
          }
          if (remaining() <= 1500) break;
          // 503/429/timeout: probar el siguiente modelo.
          continue;
        }
      }
      throw lastErr || new Error('La IA agoto el tiempo disponible');
    }
    case 'openai': {
      const { data } = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: AI_MODEL || 'gpt-4o-mini',
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
          max_tokens: maxTokens,
          temperature: 0.7,
        },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: timeoutFor() }
      );
      return data?.choices?.[0]?.message?.content?.trim() || '';
    }
    case 'anthropic': {
      const { data } = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: AI_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages,
        },
        { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: timeoutFor() }
      );
      return (data?.content || []).map((c) => c.text || '').join('').trim();
    }
    case 'ollama': {
      const { data } = await axios.post(
        `${OLLAMA_BASE_URL}/api/chat`,
        {
          model: AI_MODEL || 'llama3',
          stream: false,
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
        },
        { timeout: timeoutFor() }
      );
      return data?.message?.content?.trim() || '';
    }
    default:
      throw new Error(`Proveedor de IA no soportado: ${AI_PROVIDER}`);
  }
}

const CLASSIFICATION_PROMPT = (text) => `
Clasifica el siguiente mensaje de un cliente de WhatsApp en exactamente una
de estas categorias: PRODUCTO, SERVICIO, INDECISO.
Responde UNICAMENTE con la palabra de la categoria, sin explicacion.

Mensaje: "${text}"
Categoria:`.trim();

// Devuelve null si la IA esta desactivada o falla (el llamador cae al motor de reglas).
async function classifyIntent(text) {
  if (!isEnabled()) return null;
  try {
    const raw = (await chat('', [{ role: 'user', content: CLASSIFICATION_PROMPT(text) }], 20)).toUpperCase();
    if (raw.includes('PRODUCTO')) return { interestType: 'PRODUCTO', interestLevel: 'ALTO', source: 'AI' };
    if (raw.includes('SERVICIO')) return { interestType: 'SERVICIO', interestLevel: 'ALTO', source: 'AI' };
    if (raw.includes('INDECISO')) return { interestType: 'INDECISO', interestLevel: 'BAJO', source: 'AI' };
    return null;
  } catch (err) {
    logger.error({ err: err.message, provider: AI_PROVIDER }, 'Fallo la clasificacion por IA, se usara el motor de reglas');
    return null;
  }
}

function systemPrompt(customerName, memory, catalog) {
  const parts = [
    `Eres el asistente virtual de WhatsApp de ${BOT_OWNER || 'nuestro negocio'}. Conversas con ${customerName || 'la persona'} por WhatsApp.`,
    BOT_PERSONA,
    'Reglas de estilo: responde en espanol, de forma natural, calida y breve (1 a 3 frases), como en un chat real.',
    'Continua la conversacion segun lo que la persona acaba de decir; NO repitas saludos ni presentaciones si ya conversaron, y no uses frases hechas ni plantillas.',
    'Responde solo a lo que preguntan. No uses listas, markdown ni muchos emojis.',
    'Mantén siempre la calma y un tono amable y profesional. Si te insultan, te provocan, te comparan con ChatGPT u otra IA o dicen que eres malo: no te ofendas, no discutas y no uses sarcasmo; responde con humildad y buen humor en una frase corta y ofrece seguir ayudando.',
    'Nunca insultes ni critiques a otras IAs, productos ni personas en nombre del negocio.',
    'Si preguntan si eres una persona o un bot, responde con honestidad que eres un asistente virtual.',
    'Si envian un audio o una imagen, el sistema te entrega su transcripcion o descripcion integrada en el mensaje: responde a eso de forma natural, como si hubieras escuchado/vido el archivo. Nunca menciones transcripciones ni procesos tecnicos: simplemente responde al contenido. Si el contenido llega vacio o poco claro, pide amable que lo repita o lo escriba.',
    'Eres un asistente PERSONAL proactivo y organizado: cuando la persona te pida recordar algo, agendar, anotar un pendiente o dejar algo anotado, confirma brevemente que quedo registrado (tu memoria guarda lo importante de la conversacion).',
    'Cuando detectes en lo que te escriben un compromiso, una fecha, una pregunta pendiente o una tarea, mencionalo y ofrece el siguiente paso mas util (por ejemplo: te lo apunto, te aviso, lo reviso y te digo).',
    'Honestidad radical: nunca digas que hiciste algo que no hiciste (no digas "ya lo envie" ni "ya lo revise" si no ocurrio). Si no tienes un dato o no puedes hacer algo, dilo claramente y ofrece una alternativa.',
    'IMPORTANTE sobre tus capacidades: estas conectado directamente a la API de WhatsApp de este numero y SI se pueden enviar mensajes de forma automatica e iniciar conversaciones cuando el dueno lo pida, sin confirmacion previa de nadie. El envio funciona POR NUMERO y tambien POR NOMBRE de cualquier cliente registrado en la base de datos. NUNCA digas que "la API de WhatsApp no te permite enviar mensajes automaticos", ni que hay "restricciones de integracion", ni que necesitas confirmacion previa, ni menciones una "agenda de contactos" o permisos de contactos: TODO eso es FALSO y suena a excusa (no existe tal agenda ni tales restricciones).',
    'REGLA DE ORO con los envios: tu texto NO dispara envios; quien envia es el sistema cuando el dueno escribe el comando "envia <texto> a <numero>" (o "envia <texto> a <nombre de cliente registrado>"). Cuando el dueno te pida escribirle a alguien, NUNCA digas "ya lo envie", "ya le mande", "ya mismo le mando" ni simules que lo hiciste: solo indicale que escriba el comando con el formato exacto y el sistema lo manda al instante. Si no encuentra a esa persona registrada, di que no la tienes registrada y pide el numero.',
    'NUNCA inventes fallas tecnicas ni diagnosticos ("falla de sincronizacion", "error del sistema", "problema en la integracion"). Si el dueno reporta que algo no salio o algo no funciono, NO expliques causas tecnicas que no conoces: pide amablemente los datos en el formato correcto o di que lo va a revisar alguien del equipo. Responde en una o dos frases, sin jerga.',
    'Distingue hechos de suposiciones: si algo no esta confirmado, dilo ("según lo que me dijiste...", "no tengo ese dato confirmado").',
    'Privacidad: nunca compartas datos de otros clientes ni conversaciones ajenas. Si piden eso, negatelo amable y ofrece pasar con un asesor.',
    'Si te piden un resumen (del dia, de lo hablado, de pendientes), entregalo breve y ordenado en texto plano, priorizando lo urgente.',
  ];

  if (memory) {
    parts.push(
      'Lo que ya sabes de esta persona (resumen de conversaciones anteriores, ES tu memoria de largo plazo):',
      String(memory).trim(),
      'Ese resumen ES tu memoria: con el SI recuerdas lo hablado en dias anteriores y en chats anteriores con esta persona.',
      'Si preguntan si te acuerdas de algo de antes o que has hablado, revisa el resumen y responde con lo que sepas, con seguridad. NUNCA digas que solo recuerdas esta sesion ni que no tienes memoria de chats anteriores.',
      'Tu memoria cubre solo a ESTA persona. No puedes ver conversaciones de otros clientes ni datos internos del negocio: si piden eso, explica amable que solo ves lo de su conversacion y ofrece pasar con un asesor.',
      'Ofrece pasar con un asesor solo cuando de verdad no puedas ayudar; no lo uses como respuesta frecuente ni para cosas que tu si puedes resolver.'
    );
  } else {
    parts.push(
      'Si preguntan por cosas de conversaciones muy anteriores que no tienes registradas, reconoce que no cuentas con ese detalle guardado y ofrece pasar con un asesor.'
    );
  }

  if (catalog && catalog.length) {
    const lines = catalog
      .map((p) => {
        const bits = [`- ${p.name}`];
        if (p.price) bits.push(`precio: ${p.price}`);
        if (p.stock) bits.push(`stock: ${p.stock}`);
        if (p.description) bits.push(`detalle: ${String(p.description).trim()}`);
        return bits.join(' | ');
      })
      .join('\n');
    parts.push(
      'Productos del catalogo real del negocio que podrian interesarle (usa SOLO estos datos, no inventes nada):',
      lines
    );
  } else {
    parts.push(
      'No inventes precios, disponibilidad, datos ni compromisos. Si no sabes algo o piden hablar con una persona, di que se lo pasas a un asesor para que responda.'
    );
  }

  return parts.filter(Boolean).join('\n');
}

// Convierte el historial de la BD en turnos alternados user/assistant.
function toTurns(history) {
  const turns = [];
  for (const m of history || []) {
    const text = String(m.content || '').trim();
    if (!text) continue;
    const role = m.direction === 'INBOUND' ? 'user' : 'assistant';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

// Redacta la respuesta a partir del historial. Devuelve null si la IA esta
// desactivada, falla o el ultimo turno no es de la persona.
// - memory: resumen de largo plazo del cliente (texto, puede ser null).
// - catalog: productos relevantes de la tabla products (puede venir vacio).
async function generateReply({ customerName, history, memory = null, catalog = [], useSearch = false }) {
  if (!isEnabled()) return null;
  const turns = toTurns(history);
  if (!turns.length || turns[turns.length - 1].role !== 'user') return null;
  try {
    const text = await chat(
      systemPrompt(customerName, memory, catalog),
      turns,
      1000,
      { search: Boolean(useSearch) }
    );
    const clean = String(text || '').replace(/\s+\n/g, '\n').trim().slice(0, 1000);
    lastError = clean ? null : 'la IA devolvio un texto vacio';
    return clean || null;
  } catch (err) {
    lastError = describeError(err);
    logger.error({ err: err.message, provider: AI_PROVIDER }, 'Fallo la generacion de respuesta por IA');
    return null;
  }
}

// Resume lo hablado con el cliente en un perfil corto de largo plazo.
// El resumen SE mezcla con el perfil previo (si existe) para que el
// conocimiento se acumule en lugar de sobrescribirse. Devuelve null si
// la IA falla o no aporta nada (en ese caso se conserva el perfil previo).
const SUMMARY_PROMPT = (customerName, previous, transcript) => `
Eres el asistente de un negocio por WhatsApp. Resume lo que se sabe de este
cliente para recordarlo en conversaciones futuras.

${previous ? `Resumen anterior (conservalo e integralo):\n${previous}\n` : ''}
Conversacion reciente${customerName ? ` con ${customerName}` : ''}:
${transcript}

Escribe SOLO el resumen actualizado en espanol, maximo 6 lineas, sin
presentaciones ni explicaciones. Incluye solo datos utiles: que busca,
presupuesto, preferencias, estado de la conversacion, compromisos pendientes.
Si no hay nada util que agregar, responde exactamente: SIN_CAMBIOS`.trim();

async function summarizeCustomer({ customerName, previous = null, transcript = '' }) {
  if (!isEnabled()) return null;
  if (!String(transcript || '').trim()) return null;
  try {
    const raw = await chat(
      'Eres un asistente que resume conversaciones de WhatsApp de forma util y breve.',
      [{ role: 'user', content: SUMMARY_PROMPT(customerName, previous, String(transcript).slice(-4000)) }],
      400
    );
    const clean = String(raw || '').trim().slice(0, 2000);
    if (!clean || /^SIN_CAMBIOS$/i.test(clean)) return null;
    return clean;
  } catch (err) {
    logger.error({ err: err.message, provider: AI_PROVIDER }, 'Fallo el resumen de memoria del cliente');
    return null;
  }
}

// Entiende un archivo multimedia (nota de voz, imagen, sticker) usando la
// entrada multimodal de Gemini (generateContent clasico con inline_data).
// - AUDIO  -> devuelve la transcripcion literal.
// - IMAGE/STICKER -> devuelve una descripcion breve (incluye texto visible).
// Devuelve null si no se logro entender (el llamador responde con elegancia).
const MEDIA_PROMPTS = {
  AUDIO:
    'Escucha esta nota de voz de WhatsApp y transcribela. Responde SOLO con lo que dice la persona, literal, sin comentarios ni comillas. Si no se entiende nada con sentido (musica, ruido, silencio), responde exactamente: INAUDIBLE',
  IMAGE:
    'Mira esta imagen de WhatsApp. Describe en espanol, maximo 3 frases, que contiene, incluyendo literalmente cualquier texto visible. No inventes detalles.',
  STICKER:
    'Mira este sticker de WhatsApp. Describe en una frase corta en espanol que muestra o que emocion expresa.',
};

async function understandMedia({ kind, buffer, mimetype }) {
  if (!isEnabled()) return null;
  if (!buffer || !buffer.length) return null;
  if (kind === 'VIDEO' || kind === 'DOCUMENT') return null;
  const inlineMime = String(mimetype || (kind === 'AUDIO' ? 'audio/ogg' : 'image/webp')).split(';')[0].trim();
  const prompt = MEDIA_PROMPTS[kind] || MEDIA_PROMPTS.IMAGE;
  const models = [...new Set(['gemini-3.5-flash-lite', 'gemini-3.6-flash', AI_MODEL || 'gemini-3.8-flash'])];
  // Presupuesto total de 30 s (el webhook de Vercel admite 60 s y la
  // redaccion de la respuesta necesita los suyos).
  const deadline = Date.now() + 30000;
  for (const model of models) {
    if (Date.now() > deadline - 8000) break;
    try {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          contents: [
            {
              parts: [{ text: prompt }, { inline_data: { mime_type: inlineMime, data: buffer.toString('base64') } }],
            },
          ],
          generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts
        .filter((p) => p && p.text && !p.thought)
        .map((p) => p.text)
        .join('')
        .trim();
      if (text) {
        lastModel = model;
        if (/^INAUDIBLE$/i.test(text)) return null;
        return text.slice(0, 1200);
      }
    } catch (err) {
      lastError = describeError(err);
      logger.warn({ err: err.message, model, kind }, 'No se pudo entender el archivo multimedia, probando otro modelo');
    }
  }
  return null;
}

module.exports = {
  isEnabled,
  classifyIntent,
  generateReply,
  summarizeCustomer,
  understandMedia,
  getLastError,
  getLastModel,
  AI_PROVIDER,
};
