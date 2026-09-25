// Configuracion de la aplicacion Express: middlewares globales y rutas.
// server.js se encarga de arrancar el proceso HTTP; este archivo solo
// define "que es" la app, para que pueda importarse tambien desde los tests.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const path = require('path'); // <-- 1. Añadir esta importación

const env = require('./config/env');
const logger = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const dashboardRoutes = require('./routes/dashboard.routes');
const instanceRoutes = require('./routes/instance.routes');
const webhookRoutes = require('./routes/webhook.routes');
const customerRoutes = require('./routes/customer.routes');
const conversationRoutes = require('./routes/conversation.routes');
const messageRoutes = require('./routes/message.routes');
const queueRoutes = require('./routes/queue.routes');
const automationRoutes = require('./routes/automation.routes');
const scheduleRoutes = require('./routes/schedule.routes');
const authRoutes = require('./routes/auth.routes');
const cronRoutes = require('./routes/cron.routes');

const app = express();

// Detras del proxy de Vercel: sin esto express-rate-limit ve la IP del proxy
// (no la del cliente) y rechaza las peticiones con X-Forwarded-For.
app.set('trust proxy', 1);

// Seguridad basica de cabeceras HTTP
app.use(helmet());

// CORS: si el panel y la API estan en el mismo dominio de Vercel no hace falta.
// Para permitir otros origenes, define CORS_ORIGIN (separados por coma).
app.use(cors(env.CORS_ORIGIN ? { origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()) } : undefined));

// Parseo de JSON en el body de las requests
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging estructurado de cada request
app.use(pinoHttp({ logger }));

// Rate limiting general de la API (proteccion basica, Seccion 28)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// <-- 2. Servir la carpeta public de manera local (index.html, css, js)
app.use(express.static(path.join(__dirname, '../../public')));

// Rutas
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/instance', instanceRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/scheduled-messages', scheduleRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/cron', cronRoutes);

// Nota: Si quieres que la raíz cargue el index.html en local en lugar del JSON, 
// puedes descomentar la siguiente línea o dejar el endpoint de estado:
/*
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});
*/

app.get('/status', (req, res) => {
  res.json({
    name: 'whatsapp-automation-backend',
    status: 'running',
    docs: 'Ver README.md para la lista de endpoints disponibles por entrega.',
  });
});

// 404 y manejo de errores (deben ir al final)
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;