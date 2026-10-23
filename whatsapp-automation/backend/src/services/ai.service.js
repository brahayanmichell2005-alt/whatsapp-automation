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
async function chat(system, messages, maxTokens) {
  const deadline = Date.now() + CHAT_DEADLINE_MS;
  const remaining = () => deadline - Date.now();
  const timeoutFor = () => Math.max(2000, Math.min(20000, remaining()));
  switch (AI_PROVIDER) {
    case 'gemini': {
      const model = AI_MODEL || 'gemini-3.8-flash';
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
      const interactionBody = {
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
      const openaiBody = {
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content || ''),
          })),
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      };
      // Gemini expone compatibilidad OpenAI y la Interactions API. Se prueban
      // ambas porque segun el tipo de clave/region una puede no responder.
      const attempts = [
        {
          kind: 'openai',
          url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          headers: { Authorization: `Bearer ${GEMINI_API_KEY}` },
          body: openaiBody,
        },
        {
          kind: 'interactions',
          url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
          headers: { 'x-goog-api-key': GEMINI_API_KEY },
          body: interactionBody,
        },
        {
          kind: 'interactions',
          url: 'https://generativelanguage.googleapis.com/v1beta2/interactions',
          headers: { 'x-goog-api-key': GEMINI_API_KEY },
          body: interactionBody,
        },
      ];
      let lastErr;
      for (const attempt of attempts) {
        if (remaining() <= 1500) break;
        try {
          const { data } = await axios.post(attempt.url, attempt.body, {
            headers: { 'Content-Type': 'application/json', ...attempt.headers },
            timeout: Math.min(12000, timeoutFor()),
          });
          const text =
            attempt.kind === 'openai'
              ? String(data?.choices?.[0]?.message?.content || '').trim()
              : (() => {
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
                  return direct || fromSteps;
                })();
          if (text) return text;
          lastErr = new Error(
            `Gemini respondio sin texto (${model}, endpoint: ${attempt.kind})`
          );
        } catch (err) {
          lastErr = err;
          if (remaining() <= 1500) break;
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

function systemPrompt(customerName) {
  return [
    `Eres el asistente virtual de WhatsApp de ${BOT_OWNER}. Conversas con ${customerName || 'la persona'} por WhatsApp.`,
    BOT_PERSONA,
    'Reglas de estilo: responde en espanol, de forma natural, calida y breve (1 a 3 frases), como en un chat real.',
    'Continua la conversacion segun lo que la persona acaba de decir; NO repitas saludos ni presentaciones si ya conversaron, y no uses frases hechas ni plantillas.',
    'Responde solo a lo que preguntan. No uses listas, markdown ni muchos emojis.',
    'No inventes precios, disponibilidad, datos ni compromisos. Si no sabes algo o piden hablar con una persona, di que se lo pasas a un asesor para que responda.',
    'Si preguntan si eres una persona o un bot, responde con honestidad que eres un asistente virtual.',
  ]
    .filter(Boolean)
    .join('\n');
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
async function generateReply({ customerName, history }) {
  if (!isEnabled()) return null;
  const turns = toTurns(history);
  if (!turns.length || turns[turns.length - 1].role !== 'user') return null;
  try {
    const text = await chat(systemPrompt(customerName), turns, 300);
    const clean = String(text || '').replace(/\s+\n/g, '\n').trim().slice(0, 1000);
    lastError = clean ? null : 'la IA devolvio un texto vacio';
    return clean || null;
  } catch (err) {
    lastError = describeError(err);
    logger.error({ err: err.message, provider: AI_PROVIDER }, 'Fallo la generacion de respuesta por IA');
    return null;
  }
}

module.exports = { isEnabled, classifyIntent, generateReply, getLastError, AI_PROVIDER };
