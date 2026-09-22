// Rutas CRUD de clientes (Seccion 34). Lectura publica; creacion,
// actualizacion y borrado requieren autenticacion (Entrega 8).

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const customerController = require('../controllers/customer.controller');

router.get('/', requireAuth, customerController.list);
router.get('/:id', requireAuth, customerController.getById);
router.post('/', requireAuth, customerController.create);
router.put('/:id', requireAuth, customerController.update);
router.delete('/:id', requireAuth, customerController.remove);

module.exports = router;
