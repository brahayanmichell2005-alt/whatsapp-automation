const { query, param } = require('express-validator');

const idParam = [param('id').isInt({ min: 1 }).withMessage('id invalido').toInt()];

const paginationRules = [
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit debe estar entre 1 y 200'),
  query('offset').optional().isInt({ min: 0 }).withMessage('offset debe ser un entero >= 0'),
];

module.exports = { idParam, paginationRules };
