// Rutas de campanas masivas (protegidas por JWT del panel).
// GET    /api/campaigns       -> listar con progreso real
// POST   /api/campaigns       -> crear + encolar a la audiencia
// GET    /api/campaigns/:id   -> detalle con progreso
// DELETE /api/campaigns/:id   -> eliminar (cancela pendientes)
const express = require('express');
const router = express.Router();
const campaignController = require('../controllers/campaign.controller');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);
router.get('/', campaignController.list);
router.post('/', campaignController.create);
router.get('/:id', campaignController.getById);
router.delete('/:id', campaignController.remove);

module.exports = router;
