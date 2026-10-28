// Restringe funciones administrativas (configuracion global, detencion de
// emergencia, reintentos manuales) al rol ADMIN. El rol viene firmado en el
// JWT y lo coloca requireAuth en req.user; nunca se acepta desde el body.

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Autenticacion requerida' });
  }
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Se requiere rol ADMIN para esta accion' });
  }
  return next();
}

module.exports = { requireAdmin };
