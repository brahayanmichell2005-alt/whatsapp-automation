// Rutas de mensajes (Seccion 34). Soporta filtrar por conversation_id
// via query string: GET /api/messages?conversation_id=5
// El chat en vivo agrega: envio del panel (POST /), sugerencias y resumen
// de IA, archivo multimedia descifrado y borrado.
//
// El orden importa: /suggestions y /summary van ANTES de /:id para que la
// ruta dinamica no se los capture.

const express = require('express');
const router = express.Router();
const messageController = require('../controllers/message.controller');
const { requireAuth } = require('../middleware/requireAuth');
const authService = require('../services/auth.service');

// Para <img>/<audio> el navegador no manda cabeceras, asi que la ruta de
// media tambien acepta el token por query string: /:id/media?token=...
async function requireAuthFlexible(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = bearer || String(req.query.token || '');
  if (!token) {
    return res.status(401).json({ error: 'Autenticacion requerida' });
  }
  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesion invalida o vencida' });
  }
}

router.get('/', requireAuth, messageController.list);
router.post('/', requireAuth, messageController.send);
router.get('/suggestions', requireAuth, messageController.suggestions);
router.get('/summary', requireAuth, messageController.summary);
router.get('/:id/media', requireAuthFlexible, messageController.media);
router.get('/:id', requireAuth, messageController.getById);
router.delete('/:id', requireAuth, messageController.remove);

module.exports = router;
