const parser = require('../src/utils/evolutionEventParser');

describe('evolutionEventParser', () => {
  test('isKnownEvent reconoce eventos soportados e ignora el resto', () => {
    expect(parser.isKnownEvent('messages.upsert')).toBe(true);
    expect(parser.isKnownEvent('connection.update')).toBe(true);
    expect(parser.isKnownEvent('presence.update')).toBe(false);
  });

  test('extractPhoneFromJid extrae el numero sin el sufijo', () => {
    expect(parser.extractPhoneFromJid('51999000111@s.whatsapp.net')).toBe('51999000111');
    expect(parser.extractPhoneFromJid('51999000111:12@s.whatsapp.net')).toBe('51999000111');
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
      remoteJid: null,
      pushName: 'Cliente Prueba',
      externalMessageId: 'ABC123',
      messageType: 'TEXT',
      content: 'Hola, quiero informacion',
      media: null,
      viewOnce: null,
      timestamp: 1710000000,
    });
  });

  test('parseMessageUpsert marca "ver una vez" sin extraer la media', () => {
    const result = parser.parseMessageUpsert({
      data: {
        key: { remoteJid: '51999000111@s.whatsapp.net', fromMe: false, id: 'VO-1' },
        message: {
          viewOnceMessageV2: {
            message: {
              imageMessage: {
                url: 'https://mmg.whatsapp.net/x',
                mediaKey: Buffer.alloc(32, 1).toString('base64'),
                viewOnce: true,
              },
            },
          },
        },
      },
    });

    expect(result.messageType).toBe('OTHER');
    expect(result.content).toBeNull();
    expect(result.media).toBeNull();
    expect(result.viewOnce).toEqual({ subtype: 'IMAGE', wrapper: 'viewOnceMessageV2' });
  });

  test('parseMessageUpsert usa remoteJidAlt cuando el principal es @lid', () => {
    const result = parser.parseMessageUpsert({
      data: {
        key: {
          remoteJid: '123456789@lid',
          remoteJidAlt: '51999000111@s.whatsapp.net',
          fromMe: false,
          id: 'LID1',
        },
        message: { conversation: 'hola' },
      },
    });

    expect(result.phone).toBe('51999000111');
    expect(result.remoteJid).toBeNull();
    expect(result.isGroup).toBe(false);
  });

  test('parseMessageUpsert conserva el JID @lid cuando no hay telefono alternativo', () => {
    const result = parser.parseMessageUpsert({
      data: {
        key: {
          remoteJid: '50625601605844@lid',
          fromMe: false,
          id: 'LID2',
        },
        pushName: 'Dominik',
        message: { conversation: 'Hola' },
      },
    });

    expect(result.phone).toBe('50625601605844');
    expect(result.remoteJid).toBe('50625601605844@lid');
    expect(result.isGroup).toBe(false);
  });

  test('parseMessageUpsert no convierte un grupo en privado aunque traiga remoteJidAlt', () => {
    const result = parser.parseMessageUpsert({
      data: {
        key: {
          remoteJid: '120363000000000000@g.us',
          remoteJidAlt: '51999000111@s.whatsapp.net',
          fromMe: false,
          id: 'GROUP1',
        },
        message: { conversation: 'hola grupo' },
      },
    });

    expect(result.isGroup).toBe(true);
    expect(result.phone).toBe('120363000000000000');
  });

  test('parseMessageUpsert devuelve null si no hay data', () => {
    expect(parser.parseMessageUpsert({ event: 'messages.upsert' })).toBeNull();
  });

  test('parseConnectionUpdate normaliza el estado de conexion', () => {
    const result = parser.parseConnectionUpdate({ data: { state: 'open' } });
    expect(result.state).toBe('open');
  });

  test('parseMessagesUpdate traduce los ACK de WhatsApp a estados del panel', () => {
    const updates = parser.parseMessagesUpdate({
      data: [
        { keyId: 'ABC123', fromMe: true, status: 'SERVER_ACK' },
        { keyId: 'ABC123', fromMe: true, status: 'DELIVERY_ACK' },
        { keyId: 'ABC123', fromMe: true, status: 'READ' },
        { keyId: 'ABC123', fromMe: true, status: 'ERROR' },
      ],
    });
    expect(updates).toEqual([
      { externalMessageId: 'ABC123', status: 'SENT' },
      { externalMessageId: 'ABC123', status: 'DELIVERED' },
      { externalMessageId: 'ABC123', status: 'READ' },
      { externalMessageId: 'ABC123', status: 'FAILED' },
    ]);
  });

  test('parseMessagesUpdate acepta el estado numerico y el key anidado', () => {
    const updates = parser.parseMessagesUpdate({
      data: [
        { key: { id: 'XYZ', fromMe: true }, status: 3 },
        { key: { id: 'XYZ', fromMe: true }, status: 4 },
      ],
    });
    expect(updates).toEqual([
      { externalMessageId: 'XYZ', status: 'DELIVERED' },
      { externalMessageId: 'XYZ', status: 'READ' },
    ]);
  });

  test('parseMessagesUpdate ignora estados de mensajes entrantes y pendientes', () => {
    const updates = parser.parseMessagesUpdate({
      data: [
        { key: { id: 'IN1', fromMe: false }, status: 'READ' },
        { key: { id: 'OUT1', fromMe: true }, status: 'PENDING' },
        { key: { id: 'OUT2', fromMe: true }, status: 'DESCONOCIDO' },
      ],
    });
    expect(updates).toEqual([]);
  });
});
