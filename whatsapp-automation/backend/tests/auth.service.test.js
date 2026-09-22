jest.mock('../src/models/user.model');

const userModel = require('../src/models/user.model');
const authService = require('../src/services/auth.service');

describe('auth.service - password hashing', () => {
  test('el hash nunca es igual al password en texto plano', async () => {
    const hash = await authService.hashPassword('mi_password_seguro');
    expect(hash).not.toBe('mi_password_seguro');
  });

  test('verifyPassword valida correctamente un password correcto e incorrecto', async () => {
    const hash = await authService.hashPassword('mi_password_seguro');
    expect(await authService.verifyPassword('mi_password_seguro', hash)).toBe(true);
    expect(await authService.verifyPassword('otro_password', hash)).toBe(false);
  });
});

describe('auth.service - JWT', () => {
  test('signToken genera un token verificable con los datos del usuario', () => {
    const token = authService.signToken({ id: 1, email: 'admin@example.com', role: 'ADMIN' });
    const decoded = authService.verifyToken(token);
    expect(decoded.sub).toBe(1);
    expect(decoded.email).toBe('admin@example.com');
    expect(decoded.role).toBe('ADMIN');
  });

  test('verifyToken lanza un error con un token invalido', () => {
    expect(() => authService.verifyToken('token-invalido')).toThrow();
  });
});

describe('auth.service - login', () => {
  test('devuelve null si el usuario no existe', async () => {
    userModel.findByEmail.mockResolvedValue(null);
    const result = await authService.login('no-existe@example.com', 'cualquier-cosa');
    expect(result).toBeNull();
  });

  test('devuelve null si el password es incorrecto', async () => {
    const passwordHash = await authService.hashPassword('correcto123');
    userModel.findByEmail.mockResolvedValue({
      id: 1,
      email: 'admin@example.com',
      password_hash: passwordHash,
      active: 1,
      role: 'ADMIN',
    });
    const result = await authService.login('admin@example.com', 'incorrecto');
    expect(result).toBeNull();
  });

  test('devuelve token y datos del usuario con credenciales correctas', async () => {
    const passwordHash = await authService.hashPassword('correcto123');
    userModel.findByEmail.mockResolvedValue({
      id: 1,
      name: 'Admin',
      email: 'admin@example.com',
      password_hash: passwordHash,
      active: 1,
      role: 'ADMIN',
    });

    const result = await authService.login('admin@example.com', 'correcto123');

    expect(result).not.toBeNull();
    expect(result.token).toEqual(expect.any(String));
    expect(result.user.email).toBe('admin@example.com');
  });
});
