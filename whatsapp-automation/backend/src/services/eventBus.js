// Bus de eventos interno. Punto de enganche para las entregas siguientes:
// el webhook (Entrega 4) publica "message.received" DESPUES de guardar el
// mensaje en MySQL, y el motor de reglas / IA (Entrega 5) se suscribe aqui
// sin que el webhook tenga que conocerlo.
//
// Usar SIEMPRE subscribe() en vez de bus.on(): envuelve el handler para que
// un error (sincrono o una promesa rechazada) se registre en el log en vez de
// tumbar el proceso con un "unhandled rejection".

const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const bus = new EventEmitter();

const EVENTS = {
  MESSAGE_RECEIVED: 'message.received',
};

function subscribe(event, handler) {
  bus.on(event, (payload) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => logger.error({ err, event }, 'Error en un suscriptor del bus de eventos'));
  });
}

function publish(event, payload) {
  bus.emit(event, payload);
}

module.exports = { EVENTS, subscribe, publish };
