// Modelo de acceso a datos para la tabla `users`.
// La logica de autenticacion (hash de password, JWT) esta en auth.service.js;
// aqui solo van las operaciones contra la tabla.

const { pool } = require('../config/database');

async function findByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function create({ name, email, passwordHash, role = 'AGENT' }) {
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, email, passwordHash, role]
  );
  return rows[0];
}

async function list() {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at DESC, id DESC'
  );
  return rows;
}

module.exports = { findByEmail, findById, create, list };
