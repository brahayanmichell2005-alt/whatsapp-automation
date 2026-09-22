// DELETE aqui cancela el mensaje programado (no borra el registro),
// para mantener trazabilidad en la tabla (Seccion 17 - estado CANCELLED).

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const controller = require('../controllers/scheduledMessage.controller');

router.get('/', requireAuth, controller.list);
router.post('/', requireAuth, controller.create);
router.put('/:id', requireAuth, controller.update);
router.delete('/:id', requireAuth, controller.remove);

module.exports = router;
