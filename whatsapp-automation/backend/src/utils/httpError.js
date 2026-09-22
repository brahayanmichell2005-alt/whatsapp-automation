// Crea un Error con codigo HTTP. El errorHandler central usa err.status.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = httpError;
