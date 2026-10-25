// El 404 "Application not found" de Railway significa que el servicio de
// Evolution API ya no existe, no que falte la instancia. Estos tests fijan ese
// comportamiento para que el panel no intente crear una instancia contra un
// host muerto y muestre un error accionable.

const fallbackError = {
  message: 'Request failed with status code 404',
  response: {
    status: 404,
    statusText: 'Not Found',
    headers: { 'x-railway-fallback': '1' },
    data: {
      status: 'error',
      code: 404,
      message: 'Application not found',
      request_id: 'test-request',
    },
  },
};

describe('evolution.service cuando el host de Evolution API no existe', () => {
  const originalEnv = process.env;
  let createMock;
  let getMock;
  let postMock;
  let dbQueryMock;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      EVOLUTION_API_URL: 'https://evolution-api-production-15ed.up.railway.app',
      EVOLUTION_API_KEY: 'test-key',
      EVOLUTION_INSTANCE: 'whatsapp-bot',
    };
    getMock = jest.fn().mockRejectedValue(fallbackError);
    postMock = jest.fn();
    createMock = jest.fn(() => ({ get: getMock, post: postMock }));
    dbQueryMock = jest.fn().mockResolvedValue({ rows: [] });
    jest.doMock('../src/config/database', () => ({
      pool: { query: dbQueryMock },
    }));
    jest.doMock('axios', () => ({
      create: createMock,
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.dontMock('axios');
    jest.dontMock('../src/config/database');
  });

  test('checkConnection devuelve ERROR con un motivo claro y no "not_created"', async () => {
    const service = require('../src/services/evolution.service');
    const result = await service.checkConnection();

    expect(result.status).toBe('ERROR');
    expect(result.code).toBe('EVOLUTION_UPSTREAM_DOWN');
    expect(result.reason).toMatch(/no esta disponible/i);
    expect(result.reason).toMatch(/Application not found/i);
    expect(result.reason).not.toMatch(/instancia.*no existe/i);
  });

  test('getQrCode no intenta crear la instancia contra un host caido', async () => {
    const service = require('../src/services/evolution.service');

    await expect(service.getQrCode({})).rejects.toMatchObject({
      status: 503,
      code: 'EVOLUTION_UPSTREAM_DOWN',
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  test('usa evolution_api_url de system_settings en vez de la URL muerta', async () => {
    dbQueryMock.mockResolvedValue({ rows: [{ value: 'https://nuevo-host.example.com' }] });
    getMock.mockResolvedValue({ data: { instance: { state: 'open' } } });

    const service = require('../src/services/evolution.service');
    const result = await service.checkConnection();

    expect(result.status).toBe('CONNECTED');
    expect(createMock).toHaveBeenCalled();
    expect(createMock.mock.calls[0][0].baseURL).toBe('https://nuevo-host.example.com');
  });
});
