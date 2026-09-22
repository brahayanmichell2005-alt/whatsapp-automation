// Rutas de conversaciones (Seccion 34).

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const conversationController = require('../controllers/conversation.controller');

router.get('/', requireAuth, conversationController.list);
router.get('/:id', requireAuth, conversationController.getById);
router.put('/:id', requireAuth, conversationController.update);

module.exports = router;
