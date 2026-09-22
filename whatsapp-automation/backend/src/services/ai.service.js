// Capa de IA opcional (Seccion 23). Desactivada por defecto: solo se activa
// si AI_PROVIDER esta configurado. Nunca se acopla permanentemente a un
// proveedor (Seccion 4): agregar uno nuevo es agregar un bloque "case" aqui,
// sin tocar el resto del sistema.
//
// Importante (Seccion 23, ultima linea): esta capa NUNCA envia mensajes por
// si sola. Solo clasifica y sugiere texto; quien decide y encola el envio es
// el motor de reglas / el resto del sistema (ver messageIntake.service.js).

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

const AI_PROVIDER = (process.env.AI_PROVIDER || 'none').toLowerCase(); // none | ollama | openai | anthropic
const AI_MODEL = process.env.AI_MODEL || '';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

function isEnabled() {
  return AI_PROVIDER !== 'none' && AI_PROVIDER !== '';
}

const CLASSIFICATION_PROMPT = (text) => `
Clasifica el siguiente mensaje de un cliente de WhatsApp en exactamente una
de estas categorias: PRODUCTO, SERVICIO, INDECISO.
Responde UNICAMENTE con la palabra de la categoria, sin explicacion.

Mensaje: "${text}"
Categoria:`.trim();

async function callOllama(prompt) {
  const { data } = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
    model: AI_MODEL || 'llama3',
    prompt,
    stream: false,
  });
  return data?.response?.trim() || '';
}

async function callOpenAI(prompt) {
  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: AI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

async function callAnthropic(prompt) {
  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: AI_MODEL || 'claude-3-5-haiku-latest',
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }],
    },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
  );
  return data?.content?.[0]?.text?.trim() || '';
}

async function callProvider(prompt) {
  switch (AI_PROVIDER) {
    case 'ollama':
      return callOllama(prompt);
    case 'openai':
      return callOpenAI(prompt);
    case 'anthropic':
      return callAnthropic(prompt);
    default:
      throw new Error(`Proveedor de IA no soportado: ${AI_PROVIDER}`);
  }
}

// Devuelve null si la IA esta desactivada o falla; el llamador (messageIntake)
// debe caer siempre al motor de reglas en ese caso.
async function classifyIntent(text) {
  if (!isEnabled()) return null;
  try {
    const raw = (await callProvider(CLASSIFICATION_PROMPT(text))).toUpperCase();
    if (raw.includes('PRODUCTO')) return { interestType: 'PRODUCTO', interestLevel: 'ALTO', source: 'AI' };
    if (raw.includes('SERVICIO')) return { interestType: 'SERVICIO', interestLevel: 'ALTO', source: 'AI' };
    if (raw.includes('INDECISO')) return { interestType: 'INDECISO', interestLevel: 'BAJO', source: 'AI' };
    return null;
  } catch (err) {
    logger.error({ err: err.message, provider: AI_PROVIDER }, 'Fallo la clasificacion por IA, se usara el motor de reglas');
    return null;
  }
}

module.exports = { isEnabled, classifyIntent, AI_PROVIDER };
