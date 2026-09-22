const rulesService = require('../src/services/rules.service');

describe('rules.service - classify', () => {
  test('clasifica mensajes de intencion de compra como PRODUCTO', () => {
    const result = rulesService.classify('Quiero comprar una laptop, cuanto cuesta?');
    expect(result.interestType).toBe('PRODUCTO');
  });

  test('clasifica consultas de soporte como SERVICIO', () => {
    const result = rulesService.classify('Tengo un problema con la instalacion, necesito soporte');
    expect(result.interestType).toBe('SERVICIO');
  });

  test('clasifica mensajes ambiguos como INDECISO', () => {
    const result = rulesService.classify('Hola, quisiera informacion');
    expect(result.interestType).toBe('INDECISO');
  });

  test('clasifica texto vacio como INDECISO con interes bajo', () => {
    const result = rulesService.classify('');
    expect(result).toEqual({ interestType: 'INDECISO', interestLevel: 'BAJO' });
  });

  test('ignora acentos y mayusculas', () => {
    const result = rulesService.classify('¿CUÁNTO CUESTA el producto?');
    expect(result.interestType).toBe('PRODUCTO');
  });
});

describe('rules.service - generateReply', () => {
  test('incluye el nombre del cliente cuando esta disponible', () => {
    const reply = rulesService.generateReply({ interestType: 'PRODUCTO' }, 'Ana');
    expect(reply).toMatch(/^Hola Ana/);
  });

  test('usa saludo generico cuando no hay nombre', () => {
    const reply = rulesService.generateReply({ interestType: 'SERVICIO' }, null);
    expect(reply).toMatch(/^Hola,/);
  });
});

describe('rules.service - detectOptCommand', () => {
  test('detecta el comando de opt-out exacto', () => {
    expect(rulesService.detectOptCommand('Dejar de recibir mensajes')).toBe('OPT_OUT');
  });

  test('detecta el comando de opt-in exacto', () => {
    expect(rulesService.detectOptCommand('quiero recibir mensajes')).toBe('OPT_IN');
  });

  test('devuelve null para mensajes que no son comandos', () => {
    expect(rulesService.detectOptCommand('Hola, como estas?')).toBeNull();
  });
});
