// Verifica el tratamiento de los mensajes de "ver una vez":
//   - se detectan los tres sobres de Baileys y el flag directo;
//   - NUNCA se extrae url/mediaKey ni se descarga el archivo;
//   - se guardan como OTHER + media_kind VIEW_ONCE (sin migrar el CHECK);
//   - la respuesta al cliente pide reenviarlo como mensaje normal.
//
// Ejecutar:  npm run check

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load, inject, freshSrc } = require('./_harness');

const parser = load('utils/evolutionEventParser');
const media = load('services/media.service');
const { buildViewOnceReply } = load('services/messageIntake.service');
const legacyParser = load('services/evolutionEventParser');

const MEDIA_KEY = Buffer.alloc(32, 7).toString('base64');

function payload(message) {
  return {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '51999000111@s.whatsapp.net', fromMe: false, id: 'VO-1' },
      pushName: 'Cliente Prueba',
      message,
      messageTimestamp: 1710000000,
    },
  };
}

function image(extra = {}) {
  return {
    url: 'https://mmg.whatsapp.net/v/t62/archivo',
    mediaKey: MEDIA_KEY,
    mimetype: 'image/jpeg',
    caption: 'texto que no debe guardarse',
    ...extra,
  };
}

describe('parser: mensajes "ver una vez"', () => {
  for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    test(`${wrapper}: se detecta y no expone media`, () => {
      const parsed = parser.parseMessageUpsert(payload({ [wrapper]: { message: { imageMessage: image() } } }));

      assert.equal(parsed.messageType, 'OTHER');
      assert.equal(parsed.content, null);
      assert.equal(parsed.media, null, 'no debe extraer url ni mediaKey');
      assert.deepEqual(parsed.viewOnce, { subtype: 'IMAGE', wrapper });
    });
  }

  test('reconoce video y audio dentro del sobre', () => {
    const video = parser.parseMessageUpsert(
      payload({ viewOnceMessageV2: { message: { videoMessage: image({ mimetype: 'video/mp4' }) } } })
    );
    assert.equal(video.viewOnce.subtype, 'VIDEO');

    const audio = parser.parseMessageUpsert(
      payload({ viewOnceMessageV2Extension: { message: { audioMessage: { url: 'https://x', mediaKey: MEDIA_KEY } } } })
    );
    assert.equal(audio.viewOnce.subtype, 'AUDIO');
    assert.equal(audio.media, null);
  });

  test('detecta el flag viewOnce sin sobre', () => {
    const parsed = parser.parseMessageUpsert(payload({ imageMessage: image({ viewOnce: true }) }));
    assert.equal(parsed.messageType, 'OTHER');
    assert.equal(parsed.media, null);
    assert.deepEqual(parsed.viewOnce, { subtype: 'IMAGE', wrapper: null });
  });

  test('detecta viewOnce dentro de ephemeralMessage', () => {
    const parsed = parser.parseMessageUpsert(
      payload({
        ephemeralMessage: {
          message: { viewOnceMessageV2: { message: { imageMessage: image() } } },
        },
      })
    );
    assert.equal(parsed.media, null);
    assert.equal(parsed.viewOnce.subtype, 'IMAGE');
  });

  test('un mensaje normal sigue extrayendo su archivo', () => {
    const parsed = parser.parseMessageUpsert(payload({ imageMessage: image() }));
    assert.equal(parsed.messageType, 'IMAGE');
    assert.equal(parsed.media.kind, 'IMAGE');
    assert.equal(parsed.media.url, image().url);
    assert.equal(parsed.viewOnce, null);
  });

  test('extractMedia nunca devuelve un archivo marcado viewOnce', () => {
    assert.equal(media.extractMedia({ imageMessage: image({ viewOnce: true }) }), null);
    assert.equal(
      media.extractMedia({ viewOnceMessageV2: { message: { imageMessage: image() } } }),
      null,
      'el sobre no se trata como archivo normal'
    );
  });

  test('extractMedia conserva fileLength para el aviso de 16 MB', () => {
    const result = media.extractMedia({ videoMessage: { ...image(), mimetype: 'video/mp4', fileLength: 20 * 1024 * 1024 } });
    assert.equal(result.fileLength, 20 * 1024 * 1024);
  });

  test('el parser heredado ignora los "ver una vez"', () => {
    const result = legacyParser.extractContent({ viewOnceMessageV2: { message: { imageMessage: image() } } });
    assert.deepEqual(result, { ignored: 'view_once' });
  });
});

describe('respuesta al cliente', () => {
  test('pide reenviar como mensaje normal y no usa el fallback generico', () => {
    const text = buildViewOnceReply('Ana', 'VIDEO');
    assert.match(text, /Ana/);
    assert.match(text, /ver una vez/);
    assert.match(text, /mensaje normal/);
    assert.doesNotMatch(text, /no pude abrir/);
  });

  test('funciona sin nombre y con tipos desconocidos', () => {
    const text = buildViewOnceReply(null, 'OTRO');
    assert.match(text, /^Hola,/);
    assert.match(text, /archivo/);
  });
});

describe('intake: registra el aviso sin descargar el archivo', () => {
  test('guarda OTHER + VIEW_ONCE, no descifra y pide reenvio', async () => {
    freshSrc();
    const calls = { decrypt: 0, enqueue: [], logs: [], created: null };

    inject('models/customer.model', {
      findOrCreateByPhone: async () => ({ id: 1, phone: '51999000111', name: 'Ana', ai_paused: false }),
      isUsableName: () => true,
      touchLastMessage: async () => {},
    });
    inject('models/communicationPreference.model', {
      ensureForCustomer: async () => ({ opted_out: false }),
    });
    inject('models/conversation.model', {
      findOrCreateOpenByCustomer: async () => ({ id: 10, status: 'OPEN' }),
      touchLastMessage: async () => {},
    });
    inject('models/message.model', {
      findByExternalId: async () => null,
      create: async (data) => {
        calls.created = data;
        return { id: 100 };
      },
    });
    inject('models/automationLog.model', {
      record: async (entry) => {
        calls.logs.push(entry);
      },
    });
    inject('models/messageQueue.model', {
      cancelPendingByCustomer: async () => {},
      enqueue: async (item) => {
        calls.enqueue.push(item);
        return { id: 1 };
      },
    });
    inject('services/assistant.service', {
      effectiveMode: async () => ({ mode: 'AVAILABLE' }),
    });
    inject('services/media.service', {
      decryptMedia: async () => {
        calls.decrypt += 1;
        return null;
      },
      extractMedia: () => null,
    });
    inject('workers/message.worker', { tick: async () => ({}) });

    const intake = load('services/messageIntake.service');
    await intake.handleInboundMessage({
      isGroup: false,
      fromMe: false,
      phone: '51999000111',
      pushName: 'Ana',
      externalMessageId: 'VO-1',
      messageType: 'OTHER',
      content: null,
      media: null,
      viewOnce: { subtype: 'VIDEO', wrapper: 'viewOnceMessageV2' },
    });

    assert.equal(calls.decrypt, 0, 'no debe descargar ni descifrar el archivo');
    assert.equal(calls.created.messageType, 'OTHER');
    assert.equal(calls.created.media, null);
    assert.equal(calls.created.mediaKind, 'VIEW_ONCE');
    assert.equal(calls.created.mediaData, null);
    assert.equal(calls.created.mediaMeta.viewOnce, true);
    assert.equal(calls.created.mediaMeta.subtype, 'VIDEO');

    const reply = calls.enqueue.map((x) => x.message).join('\n');
    assert.match(reply, /ver una vez/);
    assert.match(reply, /mensaje normal/);
    assert.doesNotMatch(reply, /no pude abrir/);

    assert.ok(calls.logs.some((l) => l.eventType === 'view_once_received'));
    assert.ok(calls.logs.some((l) => l.eventType === 'view_once_reply_queued'));
  });
});
