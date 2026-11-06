// Verifica el marcador de transferencia a asesor humano de la IA: el texto
// que ve el cliente nunca debe incluir [ASESOR] y el procesador debe poder
// saber que la conversacion pasa a modo HUMAN.
//
// Ejecutar:  npm run check

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { setEnv, load } = require('./_harness');

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  TIMEZONE: 'UTC',
  START_TIME: '00:00',
  END_TIME: '24:00',
};

describe('Transferencia a asesor humano (marcador [ASESOR])', () => {
  test('detecta el marcador en cualquier posicion y lo elimina del texto', () => {
    setEnv(BASE_ENV);
    const { splitTransfer } = load('services/ai.service.js');

    const cases = [
      'Te paso con un asesor. [ASESOR]',
      '[asesor] Te paso con un asesor.',
      'Te paso con alguien\n[ Asesor ]',
      'te paso con un asesor\nASESOR',
    ];
    for (const raw of cases) {
      const split = splitTransfer(raw);
      assert.equal(split.transfer, true, raw);
      assert.equal(/[[\]]/.test(split.text), false, `quedaron corchetes en: ${split.text}`);
      assert.equal(/^\s*asesor\s*$/im.test(split.text), false, `quedo una linea ASESOR en: ${split.text}`);
      assert.match(split.text, /te paso/i);
    }
  });

  test('un mensaje normal no se marca como transferencia', () => {
    setEnv(BASE_ENV);
    const { splitTransfer } = load('services/ai.service.js');
    const split = splitTransfer('Claro, te cuento los precios del catalogo.');
    assert.equal(split.transfer, false);
    assert.equal(split.text, 'Claro, te cuento los precios del catalogo.');
  });
});
