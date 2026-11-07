// Rutas del gestor de plantillas (protegidas por JWT del panel).
// GET    /api/templates          -> listar
// POST   /api/templates          -> crear
// PUT    /api/templates/:id      -> actualizar
// DELETE /api/templates/:id      -> eliminar
// POST   /api/templates/:id/send -> despachar a la cola de salida real
const express = require('express');
const router = express.Router();
const templateController = require('../controllers/template.controller');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);
router.get('/', templateController.list);
router.post('/', templateController.create);
router.put('/:id', templateController.update);
router.delete('/:id', templateController.remove);
router.post('/:id/send', templateController.send);

module.exports = router;
