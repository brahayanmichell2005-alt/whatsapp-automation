function validateCreateScheduledMessage(body) {
  const errors = [];
  if (!body?.customer_id) errors.push('customer_id es requerido');
  if (!body?.phone || typeof body.phone !== 'string') errors.push('phone es requerido');
  if (!body?.message || typeof body.message !== 'string' || !body.message.trim()) {
    errors.push('message es requerido');
  }
  if (!body?.scheduled_at || Number.isNaN(Date.parse(body.scheduled_at))) {
    errors.push('scheduled_at es requerido y debe ser una fecha valida (ISO 8601)');
  } else if (new Date(body.scheduled_at).getTime() <= Date.now()) {
    errors.push('scheduled_at debe ser una fecha futura');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validateCreateScheduledMessage };
