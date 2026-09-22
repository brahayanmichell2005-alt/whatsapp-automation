// Rutas de mensajes (Seccion 34). Soporta filtrar por conversation_id
// via query string: GET /api/messages?conversation_id=5

const express = require('express');
const router = express.Router();
const messageController = require('../controllers/message.controller');
const { requireAuth } = require('../middleware/requireAuth');

router.get('/', requireAuth, messageController.list);
router.get('/:id', requireAuth, messageController.getById);

module.exports = router;
