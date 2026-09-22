const { query } = require('express-validator');

const STATUSES = ['OPEN', 'PENDING', 'HUMAN', 'CLOSED'];

const listConversationRules = [
  query('status').optional().isIn(STATUSES).withMessage(`status debe ser: ${STATUSES.join(', ')}`),
];

module.exports = { listConversationRules };
