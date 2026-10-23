const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/requireAuth');
const extensionController = require('../controllers/extension.controller');

const router = express.Router();
const replyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/reply', requireAuth, replyLimiter, extensionController.generateReply);

module.exports = router;
