// Endpoints de estado general del sistema, usados por el panel web (Seccion 25).
// Reporta backend, base de datos (Supabase/PostgreSQL) y el estado de
// conexion de WhatsApp via Evolution API.

const express = require('express');
const router = express.Router();
const database = require('../config/database');
const evolutionService = require('../services/evolution.service');
const logModel = require('../models/automationLog.model');
const { pool } = require('../config/database');
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
    whatsapp_reason: evolutionStatus.reason || null,
    whatsapp_code: evolutionStatus.code || null,
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

// Estadisticas REALES del dashboard Pro Suite. Todo se calcula de la base
// de datos: nada de porcentajes inventados. Si un dato no existe, va en 0.
router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const q = (text, params) => pool.query(text, params);

    const [sentRow, recvRow, activeChatsRow, queueRow, campaignsRow, contactsRow, weekRow, respRow] = await Promise.all([
      // Enviados: mensajes salientes registrados
      q("SELECT COUNT(*)::int AS n FROM messages WHERE direction = 'OUTBOUND'"),
      // Recibidos: mensajes entrantes
      q("SELECT COUNT(*)::int AS n FROM messages WHERE direction = 'INBOUND'"),
      // Chats activos: conversaciones con algun mensaje en las ultimas 24h
      q(`SELECT COUNT(DISTINCT conversation_id)::int AS n FROM messages WHERE created_at >= NOW() - INTERVAL '24 hours'`),
      // Cola de salida: pendientes de enviar
      q("SELECT COUNT(*)::int AS n FROM message_queue WHERE status IN ('PENDING', 'PROCESSING')"),
      // Campanas: total y en curso
      q("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'SENDING')::int AS active FROM campaigns"),
      // Contactos activos
      q("SELECT COUNT(*)::int AS n FROM customers WHERE status = 'ACTIVE'"),
      // Serie semanal real (vista creada en pro-suite.sql)
      q('SELECT to_char(day, \'YYYY-MM-DD\') AS day, sent, received FROM v_weekly_activity ORDER BY day'),
      // Tasa de respuesta real: % de conversaciones con mensaje del cliente
      // que tambien tienen respuesta nuestra (ultimos 7 dias).
      q(`SELECT
           COUNT(DISTINCT conversation_id) FILTER (WHERE direction = 'INBOUND')::int AS inbound_chats,
           COUNT(DISTINCT conversation_id) FILTER (WHERE direction = 'OUTBOUND')::int AS replied_chats
         FROM messages
         WHERE created_at >= NOW() - INTERVAL '7 days'`),
    ]);

    const sent = sentRow.rows[0].n;
    const received = recvRow.rows[0].n;
    const week = weekRow.rows;
    const weekSent = week.reduce((s, d) => s + Number(d.sent || 0), 0);
    const weekReceived = week.reduce((s, d) => s + Number(d.received || 0), 0);
    // % de conversaciones atendidas (con mensaje entrante y nuestra respuesta)
    const inboundChats = respRow.rows[0].inbound_chats || 0;
    const repliedChats = respRow.rows[0].replied_chats || 0;

    res.json({
      totals: {
        sent,
        received,
        responseRate: inboundChats > 0 ? Math.round((repliedChats / inboundChats) * 1000) / 10 : null,
      },
      activeChats24h: activeChatsRow.rows[0].n,
      queuePending: queueRow.rows[0].n,
      campaigns: { total: campaignsRow.rows[0].total, active: campaignsRow.rows[0].active },
      contactsActive: contactsRow.rows[0].n,
      week, // [{ day: 'YYYY-MM-DD', sent, received }]
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
