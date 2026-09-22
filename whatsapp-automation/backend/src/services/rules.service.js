// Motor de reglas (Seccion 24). Clasifica el mensaje del cliente en
// PRODUCTO / SERVICIO / INDECISO usando palabras clave, y genera una
// respuesta automatica basica. Es el fallback cuando la IA esta
// desactivada o falla (Seccion 23: "la IA nunca debe enviar por si sola
// un mensaje sin pasar por las reglas de control del sistema").
//
// La clasificacion puede modificarse aqui sin tocar el resto de la
// aplicacion (Seccion 24, ultima linea).

const PRODUCT_KEYWORDS = [
  'comprar', 'precio', 'costo', 'cuanto cuesta', 'laptop', 'producto',
  'stock', 'disponible', 'catalogo', 'modelo', 'garantia',
];

const SERVICE_KEYWORDS = [
  'servicio', 'soporte', 'reparacion', 'mantenimiento', 'instalacion',
  'consulta', 'ayuda', 'problema', 'falla', 'reclamo',
];

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function classify(text) {
  const normalized = normalize(text);
  if (!normalized) {
    return { interestType: 'INDECISO', interestLevel: 'BAJO' };
  }

  const hasProduct = PRODUCT_KEYWORDS.some((kw) => normalized.includes(kw));
  const hasService = SERVICE_KEYWORDS.some((kw) => normalized.includes(kw));

  if (hasProduct && !hasService) return { interestType: 'PRODUCTO', interestLevel: 'ALTO' };
  if (hasService && !hasProduct) return { interestType: 'SERVICIO', interestLevel: 'ALTO' };
  if (hasProduct && hasService) return { interestType: 'PRODUCTO', interestLevel: 'MEDIO' };
  return { interestType: 'INDECISO', interestLevel: 'BAJO' };
}

function generateReply(classification, customerName) {
  const greeting = customerName ? `Hola ${customerName}` : 'Hola';

  switch (classification.interestType) {
    case 'PRODUCTO':
      return `${greeting}, gracias por tu interes. Un asesor te contactara en breve con informacion de precios y disponibilidad.`;
    case 'SERVICIO':
      return `${greeting}, gracias por contactarnos. Hemos registrado tu consulta de servicio y te responderemos a la brevedad.`;
    default:
      return `${greeting}, gracias por escribirnos. Cuentanos un poco mas: ¿buscas informacion sobre un producto o un servicio?`;
  }
}

// Comandos de opt-in/opt-out reconocidos textualmente (Seccion 16).
function detectOptCommand(text) {
  const normalized = normalize(text).trim();
  if (normalized === 'quiero recibir mensajes') return 'OPT_IN';
  if (normalized === 'dejar de recibir mensajes') return 'OPT_OUT';
  return null;
}

module.exports = { classify, generateReply, detectOptCommand };
