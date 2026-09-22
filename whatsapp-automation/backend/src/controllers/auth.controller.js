const authService = require('../services/auth.service');
const userModel = require('../models/user.model');

async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email y password son requeridos' });
    }

    const result = await authService.login(email, password);
    if (!result) return res.status(401).json({ error: 'Credenciales invalidas' });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

// El logout es stateless en esta version (JWT sin lista de revocacion);
// el cliente simplemente descarta el token. Se deja el endpoint por
// consistencia con la Seccion 27 y como punto de extension futuro
// (revocacion via la tabla `sessions`).
async function logout(req, res) {
  res.json({ ok: true });
}

async function me(req, res, next) {
  try {
    const user = await userModel.findById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, logout, me };
