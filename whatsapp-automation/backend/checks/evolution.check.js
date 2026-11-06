// Verifica el manejo de errores de Evolution API: los fallos de Prisma (su
// base de datos) se resumen en un mensaje accionable y el resto conserva el
// detalle del conector.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { setEnv, fakeAxios, fakePg, load } = require('./_harness');

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  TIMEZONE: 'UTC',
  START_TIME: '00:00',
  END_TIME: '24:00',
  EVOLUTION_API_URL: 'https://evolution.test',
  EVOLUTION_API_KEY: 'test-key',
  EVOLUTION_INSTANCE: 'test-instance',
};

function loadService() {
  setEnv(BASE_ENV);
  fakeAxios.reset();
  fakePg.reset();
  return load('services/evolution.service.js');
}

function upstreamError(status, data) {
  const err = new Error('Request failed with status code ' + status);
  err.response = { status, data };
  return err;
}

describe('Errores de Evolution API', () => {
  test('un fallo de Prisma se resume y no muestra el codigo minificado', async () => {
    const service = loadService();
    fakeAxios.handlers.post = async () => {
      throw upstreamError(
        500,
        'Invalid `this.prismaRepository.contact.findMany()` invocation in\n' +
          '/evolution/dist/main.js:275:967\n\n  272 `),i.url&&(n+=`URL:${i.url}'
      );
    };

    await assert.rejects(
      () => service.sendTextMessage('51999999999', 'hola'),
      (err) => {
        assert.match(err.message, /no pudo consultar su base de datos/i);
        assert.equal(/prismaRepository/.test(err.message), false, 'no debe filtrar el stack minificado');
        assert.equal(err.upstreamStatus, 500);
        assert.equal(err.status, 502);
        return true;
      }
    );
  });

  test('un 4xx conserva el mensaje del conector', async () => {
    const service = loadService();
    fakeAxios.handlers.post = async () => {
      throw upstreamError(400, { message: 'numero invalido' });
    };

    await assert.rejects(
      () => service.sendTextMessage('51999999999', 'hola'),
      (err) => {
        assert.match(err.message, /HTTP 400/);
        assert.match(err.message, /numero invalido/);
        assert.equal(err.upstreamStatus, 400);
        return true;
      }
    );
  });

  test('un cuerpo de error sin campos conocidos no queda como [object Object]', async () => {
    const service = loadService();
    fakeAxios.handlers.post = async () => {
      throw upstreamError(400, { detalle: 'x' });
    };

    await assert.rejects(
      () => service.sendTextMessage('51999999999', 'hola'),
      (err) => {
        assert.equal(err.message.includes('[object Object]'), false);
        assert.match(err.message, /detalle/);
        return true;
      }
    );
  });

  test('un envio correcto devuelve el id externo', async () => {
    const service = loadService();
    fakeAxios.handlers.post = async () => ({ data: { key: { id: 'ABC123' } } });

    const result = await service.sendTextMessage('51999999999', 'hola');
    assert.equal(result.externalMessageId, 'ABC123');
  });
});
