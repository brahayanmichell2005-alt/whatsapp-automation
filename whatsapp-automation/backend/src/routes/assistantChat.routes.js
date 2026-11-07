// Chat del asistente integrado en el panel. Protegido por JWT del panel:
// todas las capacidades (busqueda web, datos del sistema, envio de
// WhatsApp) se ejecutan en el backend, nunca en el navegador.

const express = require('express');
const router = express.Router();
const assistantChatController = require('../controllers/assistantChat.controller');
const { requireAuth } = require('../middleware/requireAuth');

router.post('/chat', requireAuth, assistantChatController.chat);
// Subida por partes de archivos grandes (sin limite practico hasta 15 MB).
router.post('/upload', requireAuth, assistantChatController.upload);

module.exports = router;
