// Controller del catalogo de productos (pestaña Catálogo del panel).
// La IA lee esta misma tabla para responder precios y stock, asi que lo que
// se guarda aqui sale vivo en las conversaciones de WhatsApp.

const productModel = require('../models/product.model');

function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, max) : null;
}

// La miniatura se guarda como data URL comprimida (o como enlace http).
// Se limita el tamano para no reventar la fila ni la respuesta del API.
const MAX_IMAGE_CHARS = 1500000;

function parseImage(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  const s = String(v).trim();
  if (!s) return { ok: true, value: null };
  if (s.length > MAX_IMAGE_CHARS) {
    return { ok: false, error: 'La imagen es demasiado grande. Usa una foto mas liviana.' };
  }
  const dataUrl = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s);
  const enlace = /^https?:\/\/\S+$/i.test(s);
  if (!dataUrl && !enlace) {
    return { ok: false, error: 'La imagen debe ser un archivo de imagen o un enlace valido' };
  }
  return { ok: true, value: s };
}

async function list(req, res, next) {
  try {
    const items = await productModel.list();
    res.json(items);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const name = cleanText(req.body.name, 150);
    if (!name) return res.status(400).json({ error: 'El nombre del producto es obligatorio' });
    const image = parseImage(req.body.image_url);
    if (!image.ok) return res.status(400).json({ error: image.error });
    const item = await productModel.create({
      name,
      price: cleanText(req.body.price, 50),
      cost: cleanText(req.body.cost, 50),
      image_url: image.value || null,
      description: cleanText(req.body.description, 2000),
      stock: cleanText(req.body.stock, 50),
      active: req.body.active === undefined ? true : req.body.active === true,
    });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const existing = await productModel.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });
    const fields = {};
    if (req.body.name !== undefined) {
      const name = cleanText(req.body.name, 150);
      if (!name) return res.status(400).json({ error: 'El nombre no puede quedar vacio' });
      fields.name = name;
    }
    if (req.body.price !== undefined) fields.price = cleanText(req.body.price, 50);
    if (req.body.cost !== undefined) fields.cost = cleanText(req.body.cost, 50);
    if (req.body.image_url !== undefined) {
      const image = parseImage(req.body.image_url);
      if (!image.ok) return res.status(400).json({ error: image.error });
      fields.image_url = image.value;
    }
    if (req.body.description !== undefined) fields.description = cleanText(req.body.description, 2000);
    if (req.body.stock !== undefined) fields.stock = cleanText(req.body.stock, 50);
    if (req.body.active !== undefined) fields.active = req.body.active === true;
    const item = await productModel.update(req.params.id, fields);
    res.json(item);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const ok = await productModel.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Producto no encontrado' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove };
