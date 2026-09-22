const { validateCreateScheduledMessage } = require('../src/validators/scheduledMessage.validator');

describe('scheduledMessage.validator', () => {
  test('rechaza si faltan campos requeridos', () => {
    const result = validateCreateScheduledMessage({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('rechaza una fecha invalida', () => {
    const result = validateCreateScheduledMessage({
      customer_id: 1,
      phone: '51999000111',
      message: 'Hola',
      scheduled_at: 'no-es-una-fecha',
    });
    expect(result.valid).toBe(false);
  });

  test('rechaza una fecha en el pasado', () => {
    const result = validateCreateScheduledMessage({
      customer_id: 1,
      phone: '51999000111',
      message: 'Hola',
      scheduled_at: '2020-01-01T00:00:00Z',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/futura/);
  });

  test('acepta datos validos con fecha futura', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = validateCreateScheduledMessage({
      customer_id: 1,
      phone: '51999000111',
      message: 'Hola',
      scheduled_at: future,
    });
    expect(result.valid).toBe(true);
  });
});
