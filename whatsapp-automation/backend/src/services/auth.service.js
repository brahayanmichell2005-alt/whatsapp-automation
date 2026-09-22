// Logica de autenticacion (Seccion 27). Nunca se guardan contrasenas en
// texto plano: se usa bcrypt para el hash y JWT para las sesiones del panel.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const userModel = require('../models/user.model');

const SALT_ROUNDS = 10;
const TOKEN_EXPIRES_IN = '8h';

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, env.JWT_SECRET, {
    expiresIn: TOKEN_EXPIRES_IN,
  });
}

function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

async function login(email, password) {
  const user = await userModel.findByEmail(email);
  if (!user || !user.active) return null;

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return null;

  const token = signToken(user);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

// Crea el usuario administrador inicial a partir de ADMIN_EMAIL/ADMIN_PASSWORD
// si todavia no existe ningun usuario con ese correo (se llama al arrancar).
async function ensureAdminUser() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return null;

  const existing = await userModel.findByEmail(env.ADMIN_EMAIL);
  if (existing) return existing;

  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  return userModel.create({
    name: 'Administrador',
    email: env.ADMIN_EMAIL,
    passwordHash,
    role: 'ADMIN',
  });
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, login, ensureAdminUser };
