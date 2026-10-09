// Controller de la instancia de WhatsApp (Seccion 22 - Conexion mediante QR).
// Expone lo necesario para que el panel muestre CONECTADO/DESCONECTADO/
// CONECTANDO/ERROR y permita generar el QR de vinculacion.

const evolutionService = require('../services/evolution.service');
const logModel = require('../models/automationLog.model');
const logger = require('../utils/logger');

async function getStatus(req, res, next) {
  try {
    const status = await evolutionService.checkConnection();
    res.json(status);
  } catch (err) {
    next(err);
  }
}

async function createInstance(req, res, next) {
  try {
    const data = await evolutionService.createInstance();
    await logModel.record({
      eventType: 'instance_create',
      level: 'INFO',
      message: 'Instancia de WhatsApp creada/solicitada en Evolution API',
    });
    res.status(201).json(data);
  } catch (err) {
    logger.error({ err: err.message }, 'Error creando la instancia en Evolution API');
    await logModel.record({
      eventType: 'instance_create',
      level: 'ERROR',
      message: `Error creando instancia: ${err.message}`,
    });
    next(err);
  }
}

async function getQrCode(req, res, next) {
  try {
    // ?number=51910000000 -> codigo de vinculacion en vez de QR.
    let number;
    if (req.query.number !== undefined && String(req.query.number).trim() !== '') {
      number = String(req.query.number).replace(/\D/g, '');
      if (number.length < 8 || number.length > 15) {
        return res
          .status(400)
          .json({ error: 'Numero invalido: usa solo digitos con codigo de pais (8 a 15 digitos)' });
      }
    }
    const data = await evolutionService.getQrCode({ number });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const data = await evolutionService.logoutInstance();
    await logModel.record({
      eventType: 'instance_logout',
      level: 'INFO',
      message: 'Sesion de WhatsApp cerrada manualmente desde el panel',
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, createInstance, getQrCode, logout };
