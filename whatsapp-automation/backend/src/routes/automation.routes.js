const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const automationController = require('../controllers/automation.controller');

router.get('/status', automationController.getStatus);
router.post('/activate', requireAuth, automationController.activate);
router.post('/pause', requireAuth, automationController.pause);
router.post('/stop', requireAuth, automationController.stop);
router.post('/resume', requireAuth, automationController.resume);

module.exports = router;
