-- =====================================================================
-- Migracion: cola persistente de respuestas automaticas con tiempos por
-- cliente, agrupacion de mensajes, concurrencia global y atencion humana.
--
-- Es aditiva: no borra tablas ni datos existentes. Se puede ejecutar mas de
-- una vez en Supabase (idempotente). Aplicar antes de desplegar el backend
-- que usa las columnas nuevas.
--
-- Supabase Dashboard -> SQL Editor -> New query -> pegar todo -> Run.
-- =====================================================================

BEGIN;

-- La base ya define esta funcion para el resto de tablas. Se repite aqui
-- (idempotente) para que la migracion tambien funcione en una base nueva.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- message_queue: idempotencia de envio y vinculo con el trabajo logico.
-- UNCERTAIN = el conector no confirmo si el mensaje llego; no se reintenta.
-- ---------------------------------------------------------------------
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200),
  ADD COLUMN IF NOT EXISTS response_job_id INTEGER,
  ADD COLUMN IF NOT EXISTS response_generation INTEGER,
  ADD COLUMN IF NOT EXISTS uncertain_at TIMESTAMPTZ;

ALTER TABLE message_queue DROP CONSTRAINT IF EXISTS message_queue_status_check;
ALTER TABLE message_queue
  ADD CONSTRAINT message_queue_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'PAUSED', 'UNCERTAIN'));

-- ---------------------------------------------------------------------
-- conversations: control de atencion humana. El bot queda desactivado para
-- esa conversacion hasta que un usuario lo reactive manualmente.
-- ---------------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS human_taken_over_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_taken_over_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS human_takeover_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_bot_enabled
  ON conversations (bot_enabled);

-- ---------------------------------------------------------------------
-- response_settings: fila unica (id = 1) con la configuracion global.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  min_delay_seconds INTEGER NOT NULL DEFAULT 5
    CHECK (min_delay_seconds >= 0 AND min_delay_seconds <= 600),
  max_delay_seconds INTEGER NOT NULL DEFAULT 15
    CHECK (max_delay_seconds >= 0 AND max_delay_seconds <= 900),
  grouping_window_seconds INTEGER NOT NULL DEFAULT 4
    CHECK (grouping_window_seconds >= 0 AND grouping_window_seconds <= 120),
  max_concurrent_responses INTEGER NOT NULL DEFAULT 2
    CHECK (max_concurrent_responses >= 1 AND max_concurrent_responses <= 10),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PAUSED', 'STOPPED')),
  alert_threshold INTEGER NOT NULL DEFAULT 5
    CHECK (alert_threshold >= 1 AND alert_threshold <= 100),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_response_settings_delay_range
    CHECK (max_delay_seconds >= min_delay_seconds)
);

INSERT INTO response_settings
  (id, enabled, min_delay_seconds, max_delay_seconds, grouping_window_seconds,
   max_concurrent_responses, status, alert_threshold)
VALUES (1, TRUE, 5, 15, 4, 2, 'ACTIVE', 5)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- customer_response_settings: configuracion individual. Sin fila = se usan
-- los valores globales.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_response_settings (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  min_delay_seconds INTEGER NOT NULL DEFAULT 5
    CHECK (min_delay_seconds >= 0 AND min_delay_seconds <= 600),
  max_delay_seconds INTEGER NOT NULL DEFAULT 15
    CHECK (max_delay_seconds >= 0 AND max_delay_seconds <= 900),
  random_variation BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 0
    CHECK (priority >= 0 AND priority <= 10),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  last_auto_reply_at TIMESTAMPTZ,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_customer_response_delay_range
    CHECK (max_delay_seconds >= min_delay_seconds)
);

CREATE INDEX IF NOT EXISTS idx_customer_response_paused
  ON customer_response_settings (paused);

-- ---------------------------------------------------------------------
-- response_jobs: cola persistente. Un solo trabajo abierto por conversacion.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response_jobs (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  latest_inbound_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'QUEUED', 'SENT', 'FAILED', 'CANCELLED', 'PAUSED', 'UNCERTAIN')),
  priority INTEGER NOT NULL DEFAULT 0
    CHECK (priority >= 0 AND priority <= 10),
  generation INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  due_at TIMESTAMPTZ NOT NULL,
  locked_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  reply_text TEXT,
  queue_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_response_jobs_idempotency_key UNIQUE (idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_response_jobs_open_conversation
  ON response_jobs (conversation_id)
  WHERE status IN ('PENDING', 'PROCESSING', 'PAUSED', 'QUEUED');

CREATE INDEX IF NOT EXISTS idx_response_jobs_status_due
  ON response_jobs (status, due_at);
CREATE INDEX IF NOT EXISTS idx_response_jobs_customer
  ON response_jobs (customer_id);
CREATE INDEX IF NOT EXISTS idx_response_jobs_queue
  ON response_jobs (queue_id);

-- Vinculo de vuelta desde la cola de envio al trabajo que la origino.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_message_queue_response_job'
  ) THEN
    ALTER TABLE message_queue
      ADD CONSTRAINT fk_message_queue_response_job
      FOREIGN KEY (response_job_id) REFERENCES response_jobs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_queue_idempotency_key
  ON message_queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- response_settings_history: quien cambio que, cuando, y por que.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response_settings_history (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'CUSTOMER', 'CONVERSATION', 'SYSTEM')),
  action TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  previous_value JSONB,
  next_value JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_response_history_created
  ON response_settings_history (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_response_history_customer
  ON response_settings_history (customer_id);

-- ---------------------------------------------------------------------
-- Triggers de updated_at
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_response_settings_updated ON response_settings;
CREATE TRIGGER trg_response_settings_updated BEFORE UPDATE ON response_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_customer_response_settings_updated ON customer_response_settings;
CREATE TRIGGER trg_customer_response_settings_updated BEFORE UPDATE ON customer_response_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_response_jobs_updated ON response_jobs;
CREATE TRIGGER trg_response_jobs_updated BEFORE UPDATE ON response_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- RLS: el backend usa el rol postgres y no se ve afectado; esto bloquea la
-- API REST publica de Supabase (anon key).
-- ---------------------------------------------------------------------
ALTER TABLE response_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_response_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_jobs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE response_settings_history   ENABLE ROW LEVEL SECURITY;

COMMIT;
