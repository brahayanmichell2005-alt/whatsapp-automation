// Rutas de reglas de chatbot (protegidas por JWT del panel).
// GET    /api/bot-rules        -> listar
// POST   /api/bot-rules        -> crear
// PUT    /api/bot-rules/:id    -> actualizar
// PATCH  /api/bot-rules/:id    -> activar/desactivar { active }
// DELETE /api/bot-rules/:id    -> eliminar
// POST   /api/bot-rules/test   -> probar un texto contra las reglas (sin enviar)
const express = require('express');
const router = express.Router();
const botRuleController = require('../controllers/botRule.controller');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);
router.get('/', botRuleController.list);
router.post('/test', botRuleController.test);
router.post('/', botRuleController.create);
router.put('/:id', botRuleController.update);
router.patch('/:id', botRuleController.setActive);
router.delete('/:id', botRuleController.remove);

module.exports = router;
