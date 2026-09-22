// Ejecuta una lista de reglas de express-validator y responde 400 con el
// detalle por campo si alguna falla. Uso: router.post('/', validate(rules), handler)

const { validationResult } = require('express-validator');

function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const errors = validationResult(req);
      if (errors.isEmpty()) return next();
      return res.status(400).json({
        error: 'Datos invalidos',
        details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
      });
    },
  ];
}

module.exports = validate;
