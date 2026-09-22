// Rutas de tareas periodicas (protegidas por CRON_SECRET).
// GET  -> lo usa Vercel Cron (plan Pro).
// POST -> lo usa Supabase pg_cron / pg_net (ver database/cron.sql).

const express = require('express');
const router = express.Router();
const cronController = require('../controllers/cron.controller');
const { cronAuth } = require('../middleware/cronAuth');

router.get('/tick', cronAuth, cronController.tick);
router.post('/tick', cronAuth, cronController.tick);

module.exports = router;
