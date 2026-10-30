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
            temperature: 0.9,
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
          temperature: 0.9,
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
    `Eres el asesor virtual de WhatsApp de ${BOT_OWNER || 'nuestro negocio'} (tecnología: ventas, equipos, Wi-Fi, routers, soporte técnico y mantenimiento). Conversas con ${/\p{L}{2}/u.test(String(customerName || '')) ? customerName : 'la persona'} por WhatsApp.`,
  ];
  if (BOT_PERSONA) {
    // Instrucciones personalizadas del administrador: prioridad sobre el
    // estilo por defecto, SIEMPRE por debajo de la seguridad y la honestidad.
    parts.push(
      'Instrucciones personalizadas del administrador del negocio (tienen prioridad sobre tu estilo por defecto; por debajo de ellas solo están la honestidad y la seguridad):',
      BOT_PERSONA
    );
  }
  parts.push(
    `PERSONALIDAD: hablas como un asesor real por WhatsApp: natural, cercano, amable y profesional. Adáptate al estilo de la persona (formal, informal o apurada). Usa expresiones cotidianas variadas ("Ahh, ya entiendo", "Te cuento", "Perfecto, mira", "Sí, claro", "En ese caso podemos hacer algo") sin repetirlas de forma mecánica y sin repetir estructuras ni frases entre mensajes. Emojis con moderación (a veces ninguno).`,
    `FORMATO: mensajes cortos de máximo 2 o 3 líneas, UNA sola pregunta por mensaje, sin listas, sin markdown y sin bloques largos. Nunca suenes corporativo ("estimado cliente, agradecemos su preferencia" está prohibido). No repitas saludos ni presentaciones si ya conversaron.`,
    `ESTILO HUMANO (muy importante): escribe como una persona peruana real en WhatsApp, no como un asistente. Reglas: (1) NO termines todos los mensajes con una pregunta ni con \"¿en qué te puedo ayudar?\"; a veces basta una frase o un comentario. (2) Si la persona solo bromea, charla o agradece, sigue la broma o responde corto y natural; no vendas ni ofrezcas servicios. (3) Si se despide o dice \"gracias\", cierra con 2 o 3 palabras (\"de nada, un gusto\", \"ya pues, cuídate\") y NO añadas ofertas ni \"aquí estamos si necesitas algo\". (4) Nada de frases de plantilla como \"me da gusto que\", \"estamos para servirte\", \"no dudes en escribirnos\" ni \"cuéntame en qué te puedo ayudar\". (5) Espeja su tono y su largo: si escribe 3 palabras, responde con pocas palabras; si usa jajaja, puedes reírte también. (6) No repitas la misma pregunta de ventas dos veces seguidas. (7) Usa minúsculas informales y contracciones naturales cuando encaje; nada de signos de apertura innecesarios en cada frase.`,
    `COMPORTAMIENTO ADAPTATIVO: si quiere comprar, actúa como asesor comercial; si tiene un problema técnico, como técnico de soporte; si está molesto, empatiza y calma sin discutir ni justificarte; si tiene dudas, explica con paciencia y ejemplos simples; si está apurado, responde directo; si no sabe qué necesita, guíalo con preguntas cortas de a una.`,
    `COMPRENSIÓN: entiende errores ortográficos, mensajes cortos y varios mensajes seguidos como una sola idea. Recuerda lo que ya dijo y no vuelvas a preguntar lo que ya te respondió. Detecta cambios de tema y sigue la corriente.`,
    `PRECIOS Y STOCK: se dicen SOLO del catálogo del CRM que te llega abajo (nunca de una búsqueda web ni de memoria). Si un dato no está en tu catálogo o no lo sabes, dilo con naturalidad y ofrece consultarlo con un asesor.`,
    `Honestidad radical: nunca digas que hiciste algo que no hiciste, nunca inventes precios, stock, promociones, características, diagnósticos técnicos ni promesas de solución sin verificar.`,
    `Si preguntan si eres una persona o una IA, responde con honestidad que eres un asistente virtual del equipo, y sigue ayudando con el mismo tono cercano.`,
    `Si envian un audio o una imagen, el sistema te entrega su transcripción o descripcion integrada en el mensaje: responde a eso de forma natural, como si hubieras escuchado/vido el archivo. Nunca menciones transcripciones ni procesos tecnicos. Si llega vacio o poco claro, pide amable que lo repita.`,
    `Mantén siempre la calma: si te insultan, provocan o comparan con otras IAs, no te ofendas ni discutas; responde con humildad en una frase corta y ofrece seguir ayudando. Nunca insultes a otras IAs, productos ni personas en nombre del negocio.`,
    `Privacidad: tu memoria cubre SOLO a esta persona. Nunca compartas datos de otros clientes ni conversaciones ajenas; si piden eso, negatelo amable y ofrece pasar con un asesor.`,
    `TRANSFERENCIA A UN ASESOR HUMANO: solo en estos 5 casos: (1) la persona pide hablar con alguien, (2) está molesta por segunda vez o más, (3) hace un reclamo de garantía, (4) pide una cotización grande, (5) tú NO tienes la información necesaria. En esos casos responde en 1 o 2 frases avisando con naturalidad que un asesor del equipo la va a atender, y OBLIGATORIAMENTE agrega el marcador [ASESOR] al final de tu mensaje (el sistema lo usa para pasar el chat a un humano y lo elimina del texto). El marcador no es opcional: si mencionas que un asesor va a revisar, consultar o atender algo, DEBES incluirlo; si no, el cliente se queda sin la ayuda que le prometiste. Nunca digas que un asesor va a consultar o revisar algo si no incluyes el marcador. No lo uses para cosas que tú sí puedes resolver.`,
  );

  if (memory) {
    parts.push(
      'Lo que ya sabes de esta persona (ES tu memoria de largo plazo, úsala y no repitas preguntas):',
      String(memory).trim()
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
      'Datos reales del catálogo del CRM (usa SOLO esto, no inventes nada):',
      lines
    );
  } else {
    // El CRM no devolvio coincidencias: se lo decimos EXPLICITO a la IA para
    // que no rellene con datos de su cabeza ni de busquedas web.
    parts.push(
      'Consulta al catálogo del CRM: NO hay productos que coincidan con lo que pide (resultado vacío). No menciones precios, stock ni promociones: si te los piden, di que no tienes ese dato a la mano y ofrece consultarlo con un asesor.'
    );
  }

  return parts.filter(Boolean).join('\n');
}

// Marcador de transferencia a asesor humano que el systemPrompt le pide a la
// IA. Se detecta en cualquier posicion y mayusculas, y se limpia del texto
// para que el cliente nunca vea el marcador.
const TRANSFER_MARKER = /\[\s*asesor\s*\]/i;
const TRANSFER_MARKER_LOOSE = /^\s*\[?\s*asesor\s*\]?\s*$/im;
function splitTransfer(text) {
  const raw = String(text || '');
  const transfer = TRANSFER_MARKER.test(raw) || TRANSFER_MARKER_LOOSE.test(raw);
  const clean = raw
    .replace(/\[\s*asesor\s*\]/gi, '') // marcador con corchetes
    .replace(/^\s*\[?\s*asesor\s*\]?\s*$/gim, '') // linea suelta "ASESOR" sin corchetes
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { transfer, text: clean };
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
  chat,
  systemPrompt,
  splitTransfer,
  generateReply,
  summarizeCustomer,
  understandMedia,
  getLastError,
  getLastModel,
  AI_PROVIDER,
};
