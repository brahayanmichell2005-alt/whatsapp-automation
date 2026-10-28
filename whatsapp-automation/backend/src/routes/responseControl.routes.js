// Rutas de control de respuestas automaticas.
//
// GET    /api/response-control                 estado, metricas y alertas
// PUT    /api/response-control                 configuracion global (ADMIN)
// POST   /api/response-control/pause           pausar (ADMIN)
// POST   /api/response-control/resume          reanudar (ADMIN)
// POST   /api/response-control/stop            detencion de emergencia (ADMIN)
// GET    /api/response-control/jobs            trabajos de respuesta
// POST   /api/response-control/jobs/:id/retry  reintentar fallo confirmado (ADMIN)
// GET    /api/response-control/history         historial de cambios
// GET    /api/response-control/customers/:customerId
// PUT    /api/response-control/customers/:customerId
// DELETE /api/response-control/customers/:customerId  volver a valores globales
// POST   /api/response-control/customers/:customerId/state  pausar/activar
// POST   /api/response-control/conversations/:id/takeover   atencion humana
// POST   /api/response-control/conversations/:id/release    reactivar bot

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const controller = require('../controllers/responseControl.controller');

router.get('/', requireAuth, controller.getStatus);
router.put('/', requireAuth, requireAdmin, controller.updateSettings);
router.post('/pause', requireAuth, requireAdmin, controller.pause);
router.post('/resume', requireAuth, requireAdmin, controller.resume);
router.post('/stop', requireAuth, requireAdmin, controller.stop);

router.get('/jobs', requireAuth, controller.listJobs);
router.post('/jobs/:id/retry', requireAuth, requireAdmin, controller.retryJob);
router.get('/history', requireAuth, controller.history);

router.get('/customers/:customerId', requireAuth, controller.getCustomer);
router.put('/customers/:customerId', requireAuth, controller.updateCustomer);
router.delete('/customers/:customerId', requireAuth, controller.resetCustomer);
router.post('/customers/:customerId/state', requireAuth, controller.setCustomerState);

router.post('/conversations/:id/takeover', requireAuth, controller.takeOver);
router.post('/conversations/:id/release', requireAuth, controller.release);

module.exports = router;
