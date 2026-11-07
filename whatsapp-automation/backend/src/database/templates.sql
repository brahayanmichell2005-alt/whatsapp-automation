-- Tabla de plantillas de mensajes (Message Templates) para el panel.
-- Cada plantilla define el texto (con variables {{1}}, {{2}}...), categoria
-- Meta, encabezado, pie y botones interactivos. Al enviar, el backend
-- sustituye las variables y pone el mensaje en la cola de salida real.
CREATE TABLE IF NOT EXISTS message_templates (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,          -- identificador snake_case
  title         TEXT NOT NULL,                 -- titulo descriptivo
  category      TEXT NOT NULL DEFAULT 'UTILITY',   -- MARKETING | UTILITY | AUTHENTICATION
  language      TEXT NOT NULL DEFAULT 'es',
  status        TEXT NOT NULL DEFAULT 'APPROVED',  -- APPROVED | PENDING | DRAFT | REJECTED
  header_type   TEXT NOT NULL DEFAULT 'NONE',      -- NONE | TEXT | IMAGE | DOCUMENT
  header_content TEXT,
  body          TEXT NOT NULL,
  footer        TEXT,
  buttons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  variables     JSONB NOT NULL DEFAULT '[]'::jsonb,
  sample_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
