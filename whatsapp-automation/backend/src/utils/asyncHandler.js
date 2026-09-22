// Express 4 no captura las promesas rechazadas de los handlers async.
// Este wrapper las envia al errorHandler central via next(err).
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
