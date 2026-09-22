// Ruta del webhook de WhatsApp.
// Debe registrarse en Evolution API como la URL de webhook de la instancia:
//   https://TU-PROYECTO.vercel.app/api/webhooks/whatsapp
// Si defines WEBHOOK_SECRET, Evolution API debe enviarlo en la cabecera
// `x-webhook-token` (ver middleware/webhookAuth.js). Como esta URL es publica
// en internet, se recomienda definirlo siempre en produccion.

const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');
const { webhookAuth } = require('../middleware/webhookAuth');

router.post('/whatsapp', webhookAuth, webhookController.receiveWhatsappEvent);

module.exports = router;
