// Script de verificacion manual del CRUD de los modelos contra tu base REAL
// en Supabase. Necesita DATABASE_URL (en .env o en la terminal):
//   npm run smoke
// Crea datos de prueba (cliente 51999000111, un mensaje, un log...). Si lo
// ejecutas contra produccion, luego puedes borrar ese cliente desde el panel.
//
// Ejercita: customers, conversations, messages, message_queue,
// scheduled_messages, communication_preferences, automation_logs,
// system_settings. No usa datos reales de WhatsApp, solo valores de prueba.

const customerModel = require('../src/models/customer.model');
const conversationModel = require('../src/models/conversation.model');
const messageModel = require('../src/models/message.model');
const queueModel = require('../src/models/messageQueue.model');
const scheduledModel = require('../src/models/scheduledMessage.model');
const prefsModel = require('../src/models/communicationPreference.model');
const logModel = require('../src/models/automationLog.model');
const settingsModel = require('../src/models/systemSetting.model');
const { pool } = require('../src/config/database');

const TEST_PHONE = '51999000111';

async function main() {
  console.log('--- system_settings ---');
  console.log('automation_status =', await settingsModel.get('automation_status'));
  await settingsModel.set('smoke_test_key', 'ok');
  console.log('smoke_test_key =', await settingsModel.get('smoke_test_key'));

  console.log('\n--- customers (CRUD) ---');
  const customer = await customerModel.findOrCreateByPhone(TEST_PHONE, 'Cliente de prueba');
  console.log('cliente creado/encontrado:', customer.id, customer.phone);
  await customerModel.updateClassification(customer.id, {
    interestType: 'PRODUCTO',
    interestLevel: 'ALTO',
  });
  const updated = await customerModel.findById(customer.id);
  console.log('clasificacion actualizada:', updated.interest_type, updated.interest_level);

  console.log('\n--- communication_preferences ---');
  await prefsModel.optIn(customer.id);
  console.log('preferencias:', await prefsModel.findByCustomer(customer.id));

  console.log('\n--- conversations ---');
  const conversation = await conversationModel.findOrCreateOpenByCustomer(customer.id);
  console.log('conversacion abierta:', conversation.id, conversation.status);

  console.log('\n--- messages ---');
  const inboundMessage = await messageModel.create({
    conversationId: conversation.id,
    customerId: customer.id,
    direction: 'INBOUND',
    content: 'Hola, quiero informacion',
    externalMessageId: `smoke-test-${Date.now()}`,
  });
  console.log('mensaje entrante registrado:', inboundMessage.id);
  await conversationModel.touchLastMessage(conversation.id);
  await customerModel.touchLastMessage(customer.id);

  console.log('\n--- message_queue ---');
  const queued = await queueModel.enqueue({
    customerId: customer.id,
    phone: customer.phone,
    message: 'Gracias por tu mensaje, en breve te contactamos.',
  });
  console.log('mensaje encolado:', queued.id, queued.status);
  await queueModel.markSent(queued.id);
  console.log('mensaje marcado como enviado');

  console.log('\n--- scheduled_messages ---');
  const scheduled = await scheduledModel.create({
    customerId: customer.id,
    phone: customer.phone,
    message: 'Recordatorio de seguimiento',
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  console.log('mensaje programado creado:', scheduled.id, scheduled.scheduled_at);
  await scheduledModel.cancel(scheduled.id);
  console.log('mensaje programado cancelado');

  console.log('\n--- automation_logs ---');
  await logModel.record({
    eventType: 'smoke_test',
    level: 'INFO',
    message: 'Prueba de CRUD ejecutada correctamente',
    metadata: { customerId: customer.id },
  });
  const logs = await logModel.list({ eventType: 'smoke_test', limit: 1 });
  console.log('ultimo log registrado:', logs[0]?.message);

  console.log('\nTodo el CRUD basico funciono correctamente.');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fallo el smoke test:', err);
  process.exit(1);
});
