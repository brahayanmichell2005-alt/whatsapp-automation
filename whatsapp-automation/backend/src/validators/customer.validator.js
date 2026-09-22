// Validacion de entrada para el CRUD de clientes (Seccion 28 - Validacion
// de entrada). Reglas simples y explicitas, sin dependencias externas.

const VALID_INTEREST_TYPES = ['PRODUCTO', 'SERVICIO', 'INDECISO'];
const VALID_STATUSES = ['ACTIVE', 'BLOCKED', 'ARCHIVED'];

function validateCreateCustomer(body) {
  const errors = [];
  if (!body?.phone || typeof body.phone !== 'string' || !/^\d{8,15}$/.test(body.phone)) {
    errors.push('phone es requerido y debe ser numerico (8 a 15 digitos, sin "+")');
  }
  if (body?.email && !/^\S+@\S+\.\S+$/.test(body.email)) {
    errors.push('email tiene un formato invalido');
  }
  return { valid: errors.length === 0, errors };
}

function validateUpdateCustomer(body) {
  const errors = [];
  if (body?.email && !/^\S+@\S+\.\S+$/.test(body.email)) {
    errors.push('email tiene un formato invalido');
  }
  if (body?.status && !VALID_STATUSES.includes(body.status)) {
    errors.push(`status debe ser uno de: ${VALID_STATUSES.join(', ')}`);
  }
  if (body?.interest_type && !VALID_INTEREST_TYPES.includes(body.interest_type)) {
    errors.push(`interest_type debe ser uno de: ${VALID_INTEREST_TYPES.join(', ')}`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validateCreateCustomer, validateUpdateCustomer };
