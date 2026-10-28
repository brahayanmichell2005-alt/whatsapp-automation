// Validacion de la configuracion de tiempos de respuesta.
// Se usa tanto en la API como en los servicios para que un valor fuera de
// rango no pueda llegar nunca a PostgreSQL. Los limites son de seguridad
// operativa del CRM, no limites oficiales de WhatsApp.

const LIMITS = {
  minDelaySeconds: { min: 0, max: 600 },
  maxDelaySeconds: { min: 0, max: 900 },
  groupingWindowSeconds: { min: 0, max: 120 },
  maxConcurrentResponses: { min: 1, max: 10 },
  alertThreshold: { min: 1, max: 100 },
  priority: { min: 0, max: 10 },
};

const GLOBAL_FIELDS = [
  'enabled',
  'minDelaySeconds',
  'maxDelaySeconds',
  'groupingWindowSeconds',
  'maxConcurrentResponses',
  'alertThreshold',
];

const CUSTOMER_FIELDS = [
  'enabled',
  'minDelaySeconds',
  'maxDelaySeconds',
  'randomVariation',
  'priority',
  'paused',
];

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

function checkRange(value, field, errors) {
  const rule = LIMITS[field];
  if (!rule) return;
  if (value === null) return;
  if (!Number.isInteger(value)) {
    errors.push(`${field} debe ser un numero entero`);
    return;
  }
  if (value < rule.min || value > rule.max) {
    errors.push(`${field} debe estar entre ${rule.min} y ${rule.max}`);
  }
}

function normalizeBoolean(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return null;
}

// Devuelve { valid, errors, values }. `partial` permite actualizar solo
// algunos campos (por ejemplo pausar un cliente sin reenviar los tiempos).
function validateGlobalResponseSettings(body = {}, { partial = false } = {}) {
  const errors = [];
  const values = {};

  for (const field of GLOBAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      if (!partial) errors.push(`${field} es requerido`);
      continue;
    }

    if (field === 'enabled') {
      const normalized = normalizeBoolean(body.enabled);
      if (normalized === null) errors.push('enabled debe ser booleano');
      else values.enabled = normalized;
      continue;
    }

    const parsed = toInt(body[field]);
    if (parsed === null) {
      errors.push(`${field} es requerido y debe ser un numero entero`);
      continue;
    }
    checkRange(parsed, field, errors);
    values[field] = parsed;
  }

  if (
    Number.isInteger(values.minDelaySeconds) &&
    Number.isInteger(values.maxDelaySeconds) &&
    values.maxDelaySeconds < values.minDelaySeconds
  ) {
    errors.push('maxDelaySeconds debe ser mayor o igual que minDelaySeconds');
  }

  return { valid: errors.length === 0, errors, values };
}

function validateCustomerResponseSettings(body = {}, { partial = false } = {}) {
  const errors = [];
  const values = {};

  for (const field of CUSTOMER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      if (!partial) errors.push(`${field} es requerido`);
      continue;
    }

    if (field === 'enabled' || field === 'randomVariation' || field === 'paused') {
      const normalized = normalizeBoolean(body[field]);
      if (normalized === null) errors.push(`${field} debe ser booleano`);
      else values[field] = normalized;
      continue;
    }

    const parsed = toInt(body[field]);
    if (parsed === null) {
      errors.push(`${field} es requerido y debe ser un numero entero`);
      continue;
    }
    checkRange(parsed, field, errors);
    values[field] = parsed;
  }

  if (
    Number.isInteger(values.minDelaySeconds) &&
    Number.isInteger(values.maxDelaySeconds) &&
    values.maxDelaySeconds < values.minDelaySeconds
  ) {
    errors.push('maxDelaySeconds debe ser mayor o igual que minDelaySeconds');
  }

  return { valid: errors.length === 0, errors, values };
}

module.exports = {
  LIMITS,
  validateGlobalResponseSettings,
  validateCustomerResponseSettings,
};
