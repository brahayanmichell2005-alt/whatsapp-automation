const { validateWebhookPayload } = require('../src/validators/webhook.validator');

describe('webhook.validator', () => {
  test('rechaza un body vacio', () => {
    expect(validateWebhookPayload(null).valid).toBe(false);
    expect(validateWebhookPayload(undefined).valid).toBe(false);
  });

  test('rechaza un body sin el campo event', () => {
    const result = validateWebhookPayload({ instance: 'whatsapp-automation' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/event/);
  });

  test('acepta un payload minimo valido', () => {
    const result = validateWebhookPayload({ event: 'messages.upsert' });
    expect(result.valid).toBe(true);
  });

  test('acepta un payload con instance que coincide (o sin EVOLUTION_INSTANCE configurado)', () => {
    const result = validateWebhookPayload({ event: 'messages.upsert', instance: 'cualquier-cosa' });
    expect(result.valid).toBe(true);
  });
});
