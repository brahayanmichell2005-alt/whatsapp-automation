// Punto de entrada de Vercel. Toda peticion a /api/* llega aqui (ver
// "rewrites" en vercel.json) y la atiende la app Express del backend.
// El panel web (carpeta public/) lo sirve el CDN de Vercel directamente.

const app = require('../backend/src/app');
const { ensureBootstrapped } = require('../backend/src/bootstrap');

module.exports = async (req, res) => {
  await ensureBootstrapped();
  return app(req, res);
};
