-- =====================================================================
-- WhatsApp Automation Pro Suite: campanas masivas + reglas de chatbot.
-- Todo es REAL: las campanas encolan en message_queue (con campaign_id
-- para seguir el progreso) y las reglas responden antes que la IA.
-- =====================================================================

-- ---------- Campanas masivas ----------
CREATE TABLE IF NOT EXISTS campaigns (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT', 'SENDING', 'COMPLETED')),
  audience      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- filtro usado
  total         INTEGER NOT NULL DEFAULT 0,           -- destinatarios encolados
  sent          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_campaigns_created ON campaigns (created_at DESC);

-- Vinculo de cada item de cola con su campana (para el progreso en vivo).
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id);

-- ---------- Reglas de chatbot (palabras clave -> respuesta) ----------
CREATE TABLE IF NOT EXISTS bot_rules (
  id              SERIAL PRIMARY KEY,
  trigger_type    TEXT NOT NULL DEFAULT 'CONTAINS'
                  CHECK (trigger_type IN ('CONTAINS', 'EXACT')),
  keyword         TEXT NOT NULL,
  reply           TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  priority        INTEGER NOT NULL DEFAULT 100,   -- menor = gana antes
  times_triggered INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_rules_active ON bot_rules (active, priority);

-- ---------- Vista de estadisticas del dashboard (datos reales) ----------
-- Serie de 7 dias: enviados (OUTBOUND) vs recibidos (INBOUND) por dia.
CREATE OR REPLACE VIEW v_weekly_activity AS
SELECT
  d.day::date                                   AS day,
  COALESCE(sent.n, 0)::int                      AS sent,
  COALESCE(recv.n, 0)::int                      AS received
FROM generate_series(
  (CURRENT_DATE - INTERVAL '6 days'),
  CURRENT_DATE,
  INTERVAL '1 day'
) AS d(day)
LEFT JOIN (
  SELECT created_at::date AS day, COUNT(*) AS n
  FROM messages
  WHERE direction = 'OUTBOUND' AND created_at >= CURRENT_DATE - INTERVAL '6 days'
  GROUP BY 1
) AS sent ON sent.day = d.day::date
LEFT JOIN (
  SELECT created_at::date AS day, COUNT(*) AS n
  FROM messages
  WHERE direction = 'INBOUND' AND created_at >= CURRENT_DATE - INTERVAL '6 days'
  GROUP BY 1
) AS recv ON recv.day = d.day::date;
