// Capa de IA (Seccion 23). Se activa solo si AI_PROVIDER esta configurado:
//   none | gemini | openai | anthropic | ollama
// Hace dos cosas: clasificar el interes del cliente y redactar respuestas
// conversacionales a partir del historial. Nunca envia nada por si sola:
// quien encola el envio es messageIntake.service.js.

const axios = require('axios');
const logger = require('../utils/logger');

const AI_PROVIDER = (process.env.AI_PROVIDER || 'none').toLowerCase();
const AI_MODEL = process.env.AI_MODEL || '';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const BOT_OWNER = process.env.BOT_OWNER || 'Michell';
const BOT_PERSONA = process.env.BOT_PERSONA || '';

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
  return AI_PROVIDER !== 'none' && AI_PROVIDER !== '';
}

// messages: [{ role: 'user' | 'assistant', content }]  (empieza y termina en 'user')
async function chat(system, messages, maxTokens) {
  const timeout = 20000;
  switch (AI_PROVIDER) {
    case 'gemini': {
      const model = encodeURIComponent(AI_MODEL || 'gemini-2.5-flash');
      const body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
      };
      // Claves "AQ." = Vertex AI (modo express); "AIza..." = Google AI Studio.
      const vertex = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`;
      const studio = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const urls = GEMINI_API_KEY.startsWith('AQ.') ? [vertex, studio] : [studio, vertex];
      let lastErr;
      for (const url of urls) {
        try {
          const { data } = await axios.post(url, body, { headers: { 'x-goog-api-key': GEMINI_API_KEY }, timeout });
          const parts = data?.candidates?.[0]?.content?.parts || [];
          const text = parts.map((p) => p.text || '').join('').trim();
          if (text) return text;
          lastErr = new Error(`Gemini respondio sin texto (finishReason: ${data?.candidates?.[0]?.finishReason || 'desconocido'})`);
        } catch (err) {
          lastErr = err;
          const st = err.response && err.response.status;
          if (![400, 401, 403, 404].includes(st)) break;
        }
      }
      throw lastErr;
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
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout }
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
        { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout }
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
        { timeout }
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
