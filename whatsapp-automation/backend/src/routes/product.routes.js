// Rutas del catalogo de productos. Todo requiere sesion del panel.

const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);
router.get('/', productController.list);
router.post('/', productController.create);
router.put('/:id', productController.update);
router.delete('/:id', productController.remove);

module.exports = router;
