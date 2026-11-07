// Rutas de seguimientos (recordatorios del dueño). Todo requiere sesion.

const express = require('express');
const router = express.Router();
const followUpController = require('../controllers/followUp.controller');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);
router.get('/', followUpController.list);
router.post('/', followUpController.create);
router.patch('/:id/done', followUpController.markDone);
router.delete('/:id', followUpController.remove);

module.exports = router;
