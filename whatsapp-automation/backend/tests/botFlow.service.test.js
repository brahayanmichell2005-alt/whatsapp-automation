const flow = require('../src/services/botFlow.service');

describe('botFlow.service - looksLikeName', () => {
  test('acepta nombres y nombres con apellidos', () => {
    expect(flow.looksLikeName('María José')).toBe(true);
    expect(flow.looksLikeName('José García López')).toBe(true);
  });

  test('rechaza respuestas y consultas que no son un nombre', () => {
    expect(flow.looksLikeName('quiero una cita')).toBe(false);
    expect(flow.looksLikeName('cuanto cuesta un laptop?')).toBe(false);
    expect(flow.looksLikeName('123')).toBe(false);
    expect(flow.looksLikeName('gracias')).toBe(false);
    expect(flow.looksLikeName('')).toBe(false);
  });
});
