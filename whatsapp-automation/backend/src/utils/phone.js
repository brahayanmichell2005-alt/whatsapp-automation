// Utilidades de telefono. Los telefonos se guardan SIEMPRE como digitos en
// formato internacional, sin "+", espacios ni guiones (ej. 51999888777),
// que es como los usa Evolution API (`number`) y como esta definido
// customers.phone (UNIQUE).

const PHONE_REGEX = /^\d{8,15}$/; // E.164 permite hasta 15 digitos

// Devuelve solo los digitos si el resultado es un telefono valido; si no, null.
function normalizePhone(input) {
  if (input === undefined || input === null) return null;
  const digits = String(input).replace(/\D/g, '');
  return PHONE_REGEX.test(digits) ? digits : null;
}

// Extrae el telefono de un JID de WhatsApp: "51999888777@s.whatsapp.net"
// (o "51999888777:12@s.whatsapp.net" cuando incluye sufijo de dispositivo).
// Devuelve null para grupos, listas de difusion, JIDs @lid, etc.
function phoneFromJid(jid) {
  if (typeof jid !== 'string') return null;
  const [user, server] = jid.split('@');
  if (server !== 's.whatsapp.net' && server !== 'c.us') return null;
  const base = (user || '').split(':')[0];
  if (!/^\d+$/.test(base)) return null;
  return normalizePhone(base);
}

module.exports = { normalizePhone, phoneFromJid, PHONE_REGEX };
