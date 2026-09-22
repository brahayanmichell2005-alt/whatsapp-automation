// Simula eventos de Evolution API contra tu backend (local o en Vercel), sin
// necesitar WhatsApp. Sirve para comprobar de punta a punta:
//   Vercel -> webhook -> Supabase -> respuesta encolada.
//
// Uso (Node 18+):
//   BACKEND_URL=https://tu-proyecto.vercel.app WEBHOOK_SECRET=xxxx node backend/scripts/simulate-webhook.js
//
// En PowerShell:
//   $env:BACKEND_URL="https://tu-proyecto.vercel.app"; $env:WEBHOOK_SECRET="xxxx"; node backend/scripts/simulate-webhook.js
//
// Variables (todas opcionales):
//   BACKEND_URL         por defecto http://localhost:3000
//   WEBHOOK_SECRET      el mismo de Vercel (se envia en la cabecera x-webhook-token)
//   EVOLUTION_INSTANCE  debe coincidir con la del servidor si la definiste alli
//   SIM_PHONE           telefono ficticio, por defecto 51999000111
//   ADMIN_EMAIL / ADMIN_PASSWORD   para leer al final el cliente y la cola
//                       (las rutas de lectura requieren iniciar sesion)

const BASE = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
const SECRET = process.env.WEBHOOK_SECRET || '';
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'whatsapp-automation';
const PHONE = process.env.SIM_PHONE || '51999000111';
const RUN = Date.now().toString(36); // ids unicos por ejecucion

function payload(id, message, { key = {}, pushName = 'Cliente Simulado' } = {}) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: `SIM-${RUN}-${id}`, ...key },
      pushName,
      message,
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}

async function post(body) {
  const headers = { 'Content-Type': 'application/json' };
  if (SECRET) headers['x-webhook-token'] = SECRET;
  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let token = null;

async function login() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.token) token = body.token;
  else console.log(`(No se pudo iniciar sesion: HTTP ${res.status} ${body.error || ''})`);
}

async function get(path) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${BASE}${path}`, { headers });
  return res.json();
}

function show(title, r) {
  console.log(`${title.padEnd(46)} -> HTTP ${r.status}  ${JSON.stringify(r.body)}`);
}

async function main() {
  console.log(`Backend: ${BASE}\nInstancia: ${INSTANCE} | secreto: ${SECRET ? 'si' : 'no'}\n`);

  const health = await get('/api/dashboard/health');
  console.log('Salud:', JSON.stringify(health), '\n');

  show('1. Primer mensaje (cliente nuevo)', await post(payload('1', { conversation: 'Hola, quiero informacion' })));
  show('2. Segundo mensaje (misma conversacion)', await post(payload('2', { extendedTextMessage: { text: 'Cuanto cuesta?' } })));
  show('3. Imagen con texto', await post(payload('3', { imageMessage: { caption: 'Asi lo quiero' } })));
  show('4. Reenvio del mensaje 2 (duplicado)', await post(payload('2', { conversation: 'Cuanto cuesta?' })));
  show('5. Mensaje de un grupo (se ignora)', await post(payload('5', { conversation: 'hola grupo' }, { key: { remoteJid: '120363000000@g.us' } })));
  show('6. Mensaje propio fromMe (se ignora)', await post(payload('6', { conversation: 'respuesta nuestra' }, { key: { fromMe: true } })));
  show('7. Evento desconocido (se ignora)', await post({ event: 'evento.raro', instance: INSTANCE, data: {} }));

  console.log('\n--- Estado resultante ---');
  await login();
  if (!token) {
    console.log('Define ADMIN_EMAIL y ADMIN_PASSWORD para ver aqui el cliente y la cola (o mira el panel).');
    return;
  }
  const customers = await get('/api/customers?limit=200');
  const customer = Array.isArray(customers) ? customers.find((c) => c.phone === PHONE) : null;
  console.log('Cliente:', customer ? `#${customer.id} ${customer.phone} "${customer.name}" interes=${customer.interest_type}/${customer.interest_level}` : 'NO ENCONTRADO');

  const queue = await get('/api/queue?limit=5');
  console.log('\nUltimos mensajes en la cola de envio (deberian aparecer respuestas automaticas):');
  (Array.isArray(queue) ? queue : []).forEach((q) => console.log(`   #${q.id} ${q.status} -> ${q.phone}: "${String(q.message).slice(0, 60)}"`));

  console.log('\nSi la cola esta PENDING, el cron de Supabase la procesara en el siguiente minuto');
  console.log('(solo envia dentro del horario de atencion y con WhatsApp conectado).');
}

main().catch((err) => {
  console.error('Fallo la simulacion:', err.message);
  process.exit(1);
});
