// Rutas de conexion/instancia de WhatsApp via Evolution API (Entrega 3).
// El estado es publico (lo usa el healthcheck del panel); crear instancia
// y cerrar sesion requieren autenticacion (Entrega 8).

const express = require('express');
const router = express.Router();
const instanceController = require('../controllers/instance.controller');
const { requireAuth } = require('../middleware/requireAuth');

// GET  /api/instance/status  -> CONNECTED | DISCONNECTED | CONNECTING | ERROR
router.get('/status', instanceController.getStatus);

// POST /api/instance/create  -> crea la instancia en Evolution API
router.post('/create', requireAuth, instanceController.createInstance);

// GET  /api/instance/qrcode  -> devuelve el QR para vincular WhatsApp
router.get('/qrcode', requireAuth, instanceController.getQrCode);

// POST /api/instance/logout  -> cierra la sesion de WhatsApp vinculada
router.post('/logout', requireAuth, instanceController.logout);

module.exports = router;
