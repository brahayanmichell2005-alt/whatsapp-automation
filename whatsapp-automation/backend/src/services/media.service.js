// Descifra los archivos multimedia de WhatsApp (notas de voz, imagenes,
// stickers) SIN depender de rutas de Evolution API. Los mensajes ya traen
// lo necesario: la URL del archivo cifrado en el CDN de WhatsApp y la
// mediaKey. El esquema (mismo que Baileys):
//   - HKDF-SHA256 sobre la mediaKey con etiqueta por tipo de archivo
//   - IV = primeros 16 bytes, clave AES-256-CBC = siguientes 32
//   - El archivo del CDN = ciphertext + HMAC-SHA256 truncado a 10 bytes
// Si el descifrado falla se devuelve null y el llamador responde con
// elegancia (el bot nunca se queda mudo).

const crypto = require('crypto');
const logger = require('../utils/logger');

const HKDF_INFO = {
  AUDIO: 'WhatsApp Audio Keys',
  IMAGE: 'WhatsApp Image Keys',
  STICKER: 'WhatsApp Image Keys',
  VIDEO: 'WhatsApp Video Keys',
  DOCUMENT: 'WhatsApp Document Keys',
};

// Extrae la informacion de media de un mensaje crudo de Baileys/Evolution.
// Devuelve null si el mensaje no trae archivo descargable.
function extractMedia(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  const candidatos = [
    ['AUDIO', rawMessage.audioMessage],
    ['IMAGE', rawMessage.imageMessage],
    ['STICKER', rawMessage.stickerMessage],
    ['VIDEO', rawMessage.videoMessage],
    ['DOCUMENT', rawMessage.documentMessage],
  ];
  for (const [kind, m] of candidatos) {
    if (!m) continue;
    const url = m.url || null;
    const mediaKey = m.mediakey || m.mediaKey || null;
    if (!url || !mediaKey) return null;
    return {
      kind,
      url,
      mediaKey,
      mimetype: m.mimetype || (kind === 'AUDIO' ? 'audio/ogg' : kind === 'STICKER' ? 'image/webp' : null),
      seconds: m.seconds || null,
      fileName: m.fileName || m.filename || null,
    };
  }
  return null;
}

function hkdfExpand(mediaKey, info, length) {
  const salt = Buffer.alloc(32, 0);
  const prk = crypto.createHmac('sha256', salt).update(mediaKey).digest();
  const okm = [];
  let t = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(okm).length < length) {
    t = crypto
      .createHmac('sha256', prk)
      .update(Buffer.concat([t, Buffer.from(info), Buffer.from([counter])]))
      .digest();
    okm.push(t);
    counter += 1;
  }
  return Buffer.concat(okm).slice(0, length);
}

// Descarga y descifra el archivo. Devuelve { buffer, mimetype } o null.
async function decryptMedia({ kind, url, mediaKey }) {
  try {
    const key = Buffer.from(mediaKey, 'base64');
    const info = HKDF_INFO[kind] || 'WhatsApp Image Keys';
    const okm = hkdfExpand(key, Buffer.from(info), 112);
    const iv = okm.slice(0, 16);
    const cipherKey = okm.slice(16, 48);

    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ kind, status: res.status }, 'No se pudo descargar el archivo del CDN de WhatsApp');
      return null;
    }
    let enc = Buffer.from(await res.arrayBuffer());
    // WhatsApp agrega un MAC de 10 bytes al final del ciphertext.
    if (enc.length <= 10) return null;
    enc = enc.slice(0, enc.length - 10);
    if (enc.length % 16 !== 0) {
      logger.warn({ kind, bytes: enc.length }, 'El archivo descargado no tiene longitud valida para descifrar');
      return null;
    }

    const dec = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    dec.setAutoPadding(false);
    let out = Buffer.concat([dec.update(enc), dec.final()]);
    // Padding PKCS7 al final.
    const pad = out[out.length - 1];
    if (pad >= 1 && pad <= 16) out = out.slice(0, out.length - pad);
    if (!out.length) return null;
    return { buffer: out };
  } catch (err) {
    logger.warn({ kind, err: err.message }, 'Fallo el descifrado del archivo multimedia');
    return null;
  }
}

module.exports = { extractMedia, decryptMedia };
