// Carga y valida las variables de entorno del sistema.
// Todo el resto del backend debe leer configuracion desde aqui,
// nunca directamente de process.env, para tener un unico punto de verdad.
//
// En Vercel las variables se definen en: Project -> Settings -> Environment
// Variables. En local, en un archivo .env (ver .env.example).

const path = require('path');

// Se aceptan las dos ubicaciones para no romper instalaciones existentes:
//   .env en la raiz del proyecto (lo que indican el README y .env.example)
//   backend/.env (ubicacion que usaban versiones anteriores)
// dotenv no sobrescribe variables ya definidas, asi que la raiz tiene prioridad.
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

// Un despliegue en Vercel (produccion o preview) SIEMPRE se trata como produccion,
// aunque alguien haya copiado NODE_ENV=development desde su .env local.
// (`vercel dev` en tu PC define VERCEL_ENV=development y queda como desarrollo.)
const onVercelDeploy = process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'development';
const NODE_ENV = onVercelDeploy ? 'production' : process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const DEFAULT_JWT_SECRET = 'change-me-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;

// Fallar cerrado: en produccion nunca se firman tokens con un secreto por defecto.
if (isProd && JWT_SECRET === DEFAULT_JWT_SECRET) {
  throw new Error('Falta la variable de entorno JWT_SECRET (obligatoria en produccion).');
}

const DATABASE_URL = process.env.DATABASE_URL || '';

// En Vercel, si no se definio WEBHOOK_URL, se deriva el dominio estable de
// produccion. Asi la instancia de Evolution puede registrar/renovar su webhook
// sin depender de una variable manual (y sin usar la URL efimera del deploy).
const vercelHost = String(
  process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || ''
)
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '')
  .trim();
const WEBHOOK_URL = (
  process.env.WEBHOOK_URL ||
  (vercelHost ? `https://${vercelHost}/api/webhooks/whatsapp` : '')
)
  .trim()
  .replace(/\/+$/, '');

const env = {
  NODE_ENV,
  PORT: toInt(process.env.PORT, 3000),

  // --- Base de datos: Supabase (PostgreSQL) ---
  // Usa la cadena "Transaction pooler" (puerto 6543) de Supabase.
  DATABASE_URL,
  // SSL activo por defecto, salvo que apuntes a un Postgres local.
  DB_SSL: toBool(process.env.DB_SSL, !/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)),
  // Conexiones por instancia serverless (Supabase recomienda pocas).
  DB_POOL_MAX: toInt(process.env.DB_POOL_MAX, 3),

  // Se quitan barras finales: si queda "https://host/" y luego se concatena
  // "/instance/..." el resultado es "host//instance/..." (doble slash), que
  // muchos proxies delante de Evolution API responden con 404.
  EVOLUTION_API_URL: (process.env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, ''),
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY || '',
  EVOLUTION_INSTANCE: (process.env.EVOLUTION_INSTANCE || '').trim(),

  WEBHOOK_URL,
  // Secreto compartido con Evolution API (cabecera x-webhook-token). Vacio = webhook abierto
  // en desarrollo; en produccion se rechaza (falla cerrado) para evitar mensajes falsos.
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',

  // --- IA opcional (Seccion 23) ---
  AI_PROVIDER: (process.env.AI_PROVIDER || 'none').trim().toLowerCase(),
  AI_MODEL: (process.env.AI_MODEL || '').trim(),
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://ollama:11434',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  BOT_OWNER: process.env.BOT_OWNER || 'Michell',
  BOT_PERSONA: process.env.BOT_PERSONA || '',

  // Secreto que debe presentar quien llame a /api/cron/tick (Supabase pg_cron o Vercel Cron).
  CRON_SECRET: process.env.CRON_SECRET || '',
  // Tiempo maximo (ms) que una llamada de cron dedica a enviar mensajes.
  // Debe ser menor que maxDuration de la funcion en vercel.json (60 s).
  CRON_BUDGET_MS: toInt(process.env.CRON_BUDGET_MS, 45000),

  // Origenes permitidos por CORS, separados por coma. Vacio = cualquiera.
  // No hace falta si el panel y la API viven en el mismo dominio de Vercel.
  CORS_ORIGIN: process.env.CORS_ORIGIN || '',

  START_TIME: process.env.START_TIME || '08:00',
  END_TIME: process.env.END_TIME || '20:00',
  TIMEZONE: process.env.TIMEZONE || 'America/Lima',

  MIN_DELAY_SECONDS: toInt(process.env.MIN_DELAY_SECONDS, 10),
  MAX_DELAY_SECONDS: toInt(process.env.MAX_DELAY_SECONDS, 30),

  MAX_MESSAGES_PER_MINUTE: toInt(process.env.MAX_MESSAGES_PER_MINUTE, 20),
  MAX_MESSAGES_PER_HOUR: toInt(process.env.MAX_MESSAGES_PER_HOUR, 200),
  MAX_MESSAGES_PER_DAY: toInt(process.env.MAX_MESSAGES_PER_DAY, 1000),
  MAX_CONCURRENT_SENDS: toInt(process.env.MAX_CONCURRENT_SENDS, 3),

  MAX_RETRIES: toInt(process.env.MAX_RETRIES, 3),

  PAUSE_QUEUE: toBool(process.env.PAUSE_QUEUE, false),

  JWT_SECRET,
  // En produccion NO hay credenciales de admin por defecto: si no las defines,
  // simplemente no se crea el administrador inicial.
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || (isProd ? '' : 'admin@example.com'),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || (isProd ? '' : 'change-me'),
};

module.exports = env;