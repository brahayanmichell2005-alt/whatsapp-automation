-- Almacenamiento de multimedia del chat en la BD (Entrega 34).
-- Antes solo se guardaba la URL cifrada del CDN de WhatsApp + llave, que
-- VENCEN a las horas: los archivos viejos dejaban de verse. Ahora los bytes
-- descifrados se guardan al llegar el mensaje.
--   media_data  bytea  -> archivo descifrado (max ~16 MB)
--   media_meta  jsonb  -> datos para la UI: { seconds, fileName }
--   media_url   text   -> URL cifrada del CDN de WhatsApp (vence en horas)
--   media_key   text   -> llave para descifrar media_url
--   media_mime  text   -> tipo MIME real del archivo (image/png, audio/ogg...)
--   media_kind  text   -> tipo para la UI: IMAGE, AUDIO, VIDEO, DOCUMENT,
--                         STICKER, CONTACT, POLL, EVENT, CALL
-- Columnas anulables sin default: cambio instantaneo, sin reescribir la tabla.
-- Sin tablas nuevas; el archivo se sirve SOLO por el endpoint autenticado
-- /api/messages/:id/media (nunca URL publica).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_data bytea;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_meta jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_kind TEXT;
