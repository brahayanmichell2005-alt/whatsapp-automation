// Middleware que protege las rutas administrativas (Seccion 26 - "Solicitar
// autenticacion para estas operaciones"). Espera un header
// "Authorization: Bearer <token>".

const authService = require('../services/auth.service');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Autenticacion requerida' });
  }

  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }
}

module.exports = { requireAuth };
