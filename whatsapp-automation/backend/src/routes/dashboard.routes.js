// Endpoints de estado general del sistema, usados por el panel web (Seccion 25).
// Reporta backend, base de datos (Supabase/PostgreSQL) y el estado de
// conexion de WhatsApp via Evolution API.

const express = require('express');
const router = express.Router();
const database = require('../config/database');
const evolutionService = require('../services/evolution.service');
const logModel = require('../models/automationLog.model');
const { requireAuth } = require('../middleware/requireAuth');

router.get('/health', async (req, res) => {
  const [databaseOk, evolutionStatus] = await Promise.all([
    database.checkConnection(),
    evolutionService.checkConnection(),
  ]);

  const status = {
    backend: 'UP',
    database: databaseOk ? 'UP' : 'DOWN',
    whatsapp: evolutionStatus.status,
    timestamp: new Date().toISOString(),
  };

  const httpStatus = databaseOk ? 200 : 503;
  res.status(httpStatus).json(status);
});

// Bitacora de eventos/errores para el panel (Seccion 25 - "Errores").
router.get('/logs', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const level = req.query.level || null;
    const eventType = req.query.event_type || null;
    const logs = await logModel.list({ level, eventType, limit });
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
