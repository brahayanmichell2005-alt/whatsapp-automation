// Lee limit/offset de la query string con valores por defecto y tope.
// La validacion estricta (400) la hace express-validator; esto solo
// garantiza numeros seguros para el modelo.
function getPagination(req, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  return { limit, offset };
}

module.exports = { getPagination };
