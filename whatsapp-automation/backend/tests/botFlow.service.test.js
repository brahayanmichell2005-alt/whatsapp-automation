const flow = require('../src/services/botFlow.service');
const reservationModel = require('../src/models/reservation.model');

// Fecha fija para probar el parsing sin depender de la zona horaria:
// miercoles 12 de noviembre de 2026.
const HOY = { year: 2026, month: 11, day: 12, minuteOfDay: 14 * 60 };

describe('botFlow.service - parseTimeText', () => {
  test('entiende horas con a. m. / p. m. escritas de varias formas', () => {
    expect(flow.parseTimeText('a las 3 pm')).toEqual({ hour: 15, minute: 0, marker: true });
    expect(flow.parseTimeText('para la 3 de la tarde')).toEqual({ hour: 15, minute: 0, marker: true });
    expect(flow.parseTimeText('8 a. m.')).toEqual({ hour: 8, minute: 0, marker: true });
    expect(flow.parseTimeText('3 de la mañana')).toEqual({ hour: 3, minute: 0, marker: true });
  });

  test('entiende formato 24h y horas con minutos', () => {
    expect(flow.parseTimeText('15:30')).toEqual({ hour: 15, minute: 30, marker: false });
    expect(flow.parseTimeText('9:45 am')).toEqual({ hour: 9, minute: 45, marker: true });
    expect(flow.parseTimeText('20h')).toEqual({ hour: 20, minute: 0, marker: false });
  });

  test('sin marcador, las horas 1-7 se entienden de la tarde', () => {
    expect(flow.parseTimeText('a las 3')).toEqual({ hour: 15, minute: 0, marker: false });
    expect(flow.parseTimeText('a las 7')).toEqual({ hour: 19, minute: 0, marker: false });
    expect(flow.parseTimeText('a las 20')).toEqual({ hour: 20, minute: 0, marker: false });
  });

  test('devuelve null si no hay hora', () => {
    expect(flow.parseTimeText('quiero una cita el viernes')).toBeNull();
  });
});

describe('botFlow.service - isTimeInRange (09:00 a 20:00)', () => {
  test('acepta los limites del horario', () => {
    expect(flow.isTimeInRange({ hour: 9, minute: 0, marker: false })).toBe(true);
    expect(flow.isTimeInRange({ hour: 20, minute: 0, marker: false })).toBe(true);
  });

  test('rechaza horas fuera del horario', () => {
    expect(flow.isTimeInRange({ hour: 8, minute: 0, marker: false })).toBe(false);
    expect(flow.isTimeInRange({ hour: 21, minute: 0, marker: false })).toBe(false);
  });
});

describe('botFlow.service - parseDateText', () => {
  test('entiende hoy, manana y pasado manana', () => {
    expect(flow.parseDateText('hoy', HOY).date).toEqual({ year: 2026, month: 11, day: 12 });
    expect(flow.parseDateText('mañana', HOY).date).toEqual({ year: 2026, month: 11, day: 13 });
    expect(flow.parseDateText('pasado mañana', HOY).date).toEqual({ year: 2026, month: 11, day: 14 });
  });

  test('entiende dia/mes numerico y con anio', () => {
    expect(flow.parseDateText('el 25/12', HOY).date).toEqual({ year: 2026, month: 12, day: 25 });
    expect(flow.parseDateText('25-12-2027', HOY).date).toEqual({ year: 2027, month: 12, day: 25 });
  });

  test('entiende "12 de noviembre" y avanza el anio si ya paso', () => {
    expect(flow.parseDateText('30 de noviembre', HOY).date).toEqual({ year: 2026, month: 11, day: 30 });
    // Ya paso este anio (el 1 de noviembre): propone el proximo.
    expect(flow.parseDateText('5 de noviembre', HOY).date).toEqual({ year: 2027, month: 11, day: 5 });
  });

  test('entiende dias de la semana (proxima ocurrencia)', () => {
    // 12 de noviembre de 2026 es jueves; el viernes cae 13.
    expect(flow.parseDateText('viernes', HOY).date).toEqual({ year: 2026, month: 11, day: 13 });
  });

  test('devuelve null si no hay fecha', () => {
    expect(flow.parseDateText('quiero reservar', HOY)).toBeNull();
  });
});

describe('botFlow.service - looksLikeName', () => {
  test('acepta nombres y nombres con apellidos', () => {
    expect(flow.looksLikeName('María José')).toBe(true);
    expect(flow.looksLikeName('José García López')).toBe(true);
  });

  test('rechaza respuestas y consultas que no son un nombre', () => {
    expect(flow.looksLikeName('quiero una cita')).toBe(false);
    expect(flow.looksLikeName('cuanto cuesta un laptop?')).toBe(false);
    expect(flow.looksLikeName('123')).toBe(false);
    expect(flow.looksLikeName('gracias')).toBe(false);
    expect(flow.looksLikeName('')).toBe(false);
  });
});

describe('botFlow.service - detectReservationIntent', () => {
  test('detecta pedidos de reserva o cita', () => {
    expect(flow.detectReservationIntent('quisiera hacer una reservación')).toBe(true);
    expect(flow.detectReservationIntent('quiero agendar una cita')).toBe(true);
    expect(flow.detectReservationIntent('can i reserve a table')).toBe(true);
    expect(flow.detectReservationIntent('hola, buenos dias')).toBe(false);
  });
});

describe('botFlow.service - formatTimeLabel y formatDateLabel', () => {
  test('formatea la hora con a. m. / p. m.', () => {
    expect(flow.formatTimeLabel({ hour: 9, minute: 0 })).toBe('9:00 a. m.');
    expect(flow.formatTimeLabel({ hour: 15, minute: 30 })).toBe('3:30 p. m.');
    expect(flow.formatTimeLabel({ hour: 20, minute: 0 })).toBe('8:00 p. m.');
    expect(flow.formatTimeLabel({ hour: 12, minute: 0 })).toBe('12:00 p. m.');
  });

  test('formatea la fecha en espanol', () => {
    expect(flow.formatDateLabel({ year: 2026, month: 11, day: 13 })).toBe('viernes 13 de noviembre de 2026');
  });
});

describe('botFlow.service - toStartAtIso (reserva -> timestamp real)', () => {
  test('convierte la fecha y hora locales del negocio a UTC', () => {
    // 5:00 p. m. hora de Lima (UTC-5) = 22:00 UTC
    const iso = reservationModel.toStartAtIso(
      { year: 2026, month: 11, day: 5 },
      { hour: 17, minute: 0 }
    );
    expect(iso).toBe('2026-11-05T22:00:00.000Z');
  });

  test('devuelve null si falta la fecha o la hora', () => {
    expect(reservationModel.toStartAtIso(null, { hour: 15, minute: 0 })).toBeNull();
    expect(
      reservationModel.toStartAtIso(
        { year: 2026, month: 11, day: 5 },
        null
      )
    ).toBeNull();
  });
});

describe('botFlow.service - isSlotAvailable', () => {
  const context = (date, time) => ({
    date: { date, source: 'x' },
    time,
  });

  test('dentro del horario y fecha futura: disponible', () => {
    const slot = context({ year: 2026, month: 11, day: 20 }, { hour: 15, minute: 0, marker: false });
    expect(flow.isSlotAvailable(slot, new Date('2026-11-12T20:00:00Z'))).toBe(true);
  });

  test('fecha pasada: no disponible', () => {
    const slot = context({ year: 2026, month: 11, day: 1 }, { hour: 15, minute: 0, marker: false });
    expect(flow.isSlotAvailable(slot, new Date('2026-11-12T20:00:00Z'))).toBe(false);
  });

  test('hoy con hora que ya paso: no disponible', () => {
    // HOY.minuteOfDay = 14:00 (en la zona del negocio); 13:00 ya paso.
    const slot = context({ year: 2026, month: 11, day: 12 }, { hour: 13, minute: 0, marker: false });
    expect(
      flow.isSlotAvailable(slot, new Date('2026-11-12T14:00:00-06:00'))
    ).toBe(false);
  });

  test('fuera del horario de atencion: no disponible', () => {
    const slot = context({ year: 2026, month: 11, day: 20 }, { hour: 21, minute: 0, marker: false });
    expect(flow.isSlotAvailable(slot, new Date('2026-11-12T20:00:00Z'))).toBe(false);
  });
});
