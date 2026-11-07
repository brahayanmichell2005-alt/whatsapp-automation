// Controlador REST de reservas (tabla reservations), para el panel del CRM.
// Lectura protegida con JWT (requireAuth) y cancelacion manual del operador.

const reservationModel = require('../models/reservation.model');
const custModel = require('../models/customer.model');
const logModel = require('../models/automationLog.model');

async function list(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const items = await reservationModel.list({ limit, offset });
    res.json(items);
  } catch (err) {
    next(err);
  }
}

async function listByCustomer(req, res, next) {
  try {
    const customerId = parseInt(req.query.customer_id, 10);
    if (!Number.isFinite(customerId)) {
      return res.status(400).json({ error: 'customer_id es obligatorio' });
    }
    const items = await reservationModel.listByCustomer(customerId);
    res.json(items);
  } catch (err) {
    next(err);
  }
}

// Cancelacion manual desde el panel: la reserva deja de ocupar su horario
// y el cliente puede volver a pedir otra. Se registra en el log.
async function cancel(req, res, next) {
  try {
    const existing = await reservationModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (existing.status !== 'CONFIRMED') {
      return res.status(409).json({ error: `La reserva ya esta en estado ${existing.status}` });
    }
    const cancelled = await reservationModel.cancel(existing.id);
    await logModel.record({
      eventType: 'reservation_cancelled',
      level: 'WARN',
      message: `Reserva N° ${existing.id} cancelada manualmente desde el panel`,
      metadata: {
        customerId: existing.customer_id,
        reservationId: existing.id,
        startAt: existing.start_at,
      },
    });
    res.json(cancelled);
  } catch (err) {
    next(err);
  }
}

// Datos completos para mostrar en el panel (nombre del cliente incluido).
async function listWithCustomers(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const items = await reservationModel.list({ limit });
    const ids = [...new Set(items.map((r) => r.customer_id))];
    const customers = await custModel.listByIds(ids);
    const byId = new Map(customers.map((c) => [c.id, c]));
    res.json(
      items.map((r) => {
        const c = byId.get(r.customer_id);
        return {
          ...r,
          customer_name: c ? c.name : null,
          customer_notes: c ? c.notes || null : null,
        };
      })
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { list, listByCustomer, cancel, listWithCustomers };
