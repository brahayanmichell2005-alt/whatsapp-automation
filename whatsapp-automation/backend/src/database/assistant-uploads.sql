-- Subida de archivos GRANDES para el chat del asistente del panel.
-- Vercel limita cada request a 4.5 MB, asi que los archivos grandes viajan
-- por partes (chunks ~3 MB) y se reensamblan aqui. Sin limite practico
-- hasta 15 MB (tope que soporta el analisis multimodal de Gemini).
-- Las filas son EFIMERAS: se borran al usarse o a las 2 horas.

CREATE TABLE IF NOT EXISTS assistant_uploads (
  upload_id text NOT NULL,
  chunk_index int NOT NULL,
  total_chunks int NOT NULL,
  name text,
  mimetype text,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (upload_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_assistant_uploads_created ON assistant_uploads (created_at);
