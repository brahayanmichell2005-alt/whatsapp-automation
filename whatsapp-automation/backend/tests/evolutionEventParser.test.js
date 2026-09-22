const parser = require('../src/utils/evolutionEventParser');

describe('evolutionEventParser', () => {
  test('isKnownEvent reconoce eventos soportados e ignora el resto', () => {
    expect(parser.isKnownEvent('messages.upsert')).toBe(true);
    expect(parser.isKnownEvent('connection.update')).toBe(true);
    expect(parser.isKnownEvent('presence.update')).toBe(false);
  });

  test('extractPhoneFromJid extrae el numero sin el sufijo', () => {
    expect(parser.extractPhoneFromJid('51999000111@s.whatsapp.net')).toBe('51999000111');
    expect(parser.extractPhoneFromJid(null)).toBeNull();
  });

  test('isGroupJid distingue chats individuales de grupos', () => {
    expect(parser.isGroupJid('123456@g.us')).toBe(true);
    expect(parser.isGroupJid('51999000111@s.whatsapp.net')).toBe(false);
  });

  test('detectMessageType detecta texto simple', () => {
    expect(parser.detectMessageType({ conversation: 'hola' })).toBe('TEXT');
  });

  test('detectMessageType detecta texto extendido', () => {
    expect(parser.detectMessageType({ extendedTextMessage: { text: 'hola' } })).toBe('TEXT');
  });

  test('detectMessageType detecta imagenes', () => {
    expect(parser.detectMessageType({ imageMessage: {} })).toBe('IMAGE');
  });

  test('detectMessageType devuelve OTHER si no reconoce el tipo', () => {
    expect(parser.detectMessageType({ stickerMessage: {} })).toBe('OTHER');
    expect(parser.detectMessageType(null)).toBe('OTHER');
  });

  test('extractTextContent extrae conversation o extendedTextMessage', () => {
    expect(parser.extractTextContent({ conversation: 'hola' })).toBe('hola');
    expect(parser.extractTextContent({ extendedTextMessage: { text: 'hola 2' } })).toBe('hola 2');
    expect(parser.extractTextContent({})).toBeNull();
  });

  test('parseMessageUpsert normaliza un evento completo', () => {
    const payload = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: '51999000111@s.whatsapp.net', fromMe: false, id: 'ABC123' },
        pushName: 'Cliente Prueba',
        message: { conversation: 'Hola, quiero informacion' },
        messageTimestamp: 1710000000,
      },
    };

    const result = parser.parseMessageUpsert(payload);

    expect(result).toEqual({
      fromMe: false,
      isGroup: false,
      phone: '51999000111',
      pushName: 'Cliente Prueba',
      externalMessageId: 'ABC123',
      messageType: 'TEXT',
      content: 'Hola, quiero informacion',
      timestamp: 1710000000,
    });
  });

  test('parseMessageUpsert devuelve null si no hay data', () => {
    expect(parser.parseMessageUpsert({ event: 'messages.upsert' })).toBeNull();
  });

  test('parseConnectionUpdate normaliza el estado de conexion', () => {
    const result = parser.parseConnectionUpdate({ data: { state: 'open' } });
    expect(result.state).toBe('open');
  });
});
