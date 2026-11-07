// Reservas/citas capturadas por el bot (PLANTILLAS-CRM-BOT.md).
// El panel lista, filtra por cliente y cancela; el bot confirma.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const controller = require('../controllers/reservation.controller');

router.get('/', requireAuth, controller.listWithCustomers);
router.get('/by-customer', requireAuth, controller.listByCustomer);
router.post('/:id/cancel', requireAuth, controller.cancel);

module.exports = router;
