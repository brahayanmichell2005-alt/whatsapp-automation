const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const queueController = require('../controllers/queue.controller');

router.get('/', requireAuth, queueController.list);
router.post('/pause', requireAuth, queueController.pause);
router.post('/resume', requireAuth, queueController.resume);
router.post('/stop', requireAuth, queueController.stop);

module.exports = router;
