// Prueba el CRUD de clientes a nivel HTTP con supertest, mockeando el
// modelo (no requiere base de datos) y la autenticacion (no requiere JWT real,
// se prueba por separado en auth.service.test.js).

jest.mock('../src/models/customer.model');
jest.mock('../src/middleware/requireAuth', () => ({
  requireAuth: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const customerModel = require('../src/models/customer.model');
const customerRoutes = require('../src/routes/customer.routes');
const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/customers', customerRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/customers', () => {
  test('devuelve la lista de clientes', async () => {
    customerModel.list.mockResolvedValue([{ id: 1, phone: '51999000111' }]);
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('GET /api/customers/:id', () => {
  test('devuelve 404 si el cliente no existe', async () => {
    customerModel.findById.mockResolvedValue(null);
    const res = await request(app).get('/api/customers/999');
    expect(res.status).toBe(404);
  });

  test('devuelve el cliente si existe', async () => {
    customerModel.findById.mockResolvedValue({ id: 1, phone: '51999000111' });
    const res = await request(app).get('/api/customers/1');
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('51999000111');
  });
});

describe('POST /api/customers', () => {
  test('rechaza un telefono invalido', async () => {
    const res = await request(app).post('/api/customers').send({ phone: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('rechaza un telefono duplicado', async () => {
    customerModel.findByPhone.mockResolvedValue({ id: 1, phone: '51999000111' });
    const res = await request(app).post('/api/customers').send({ phone: '51999000111' });
    expect(res.status).toBe(409);
  });

  test('crea el cliente cuando los datos son validos', async () => {
    customerModel.findByPhone.mockResolvedValue(null);
    customerModel.create.mockResolvedValue({ id: 2, phone: '51988000222' });

    const res = await request(app).post('/api/customers').send({ phone: '51988000222' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(2);
  });
});

describe('DELETE /api/customers/:id', () => {
  test('devuelve 404 si el cliente no existe', async () => {
    customerModel.findById.mockResolvedValue(null);
    const res = await request(app).delete('/api/customers/999');
    expect(res.status).toBe(404);
  });

  test('elimina el cliente si existe', async () => {
    customerModel.findById.mockResolvedValue({ id: 1 });
    customerModel.remove.mockResolvedValue();
    const res = await request(app).delete('/api/customers/1');
    expect(res.status).toBe(204);
  });
});
