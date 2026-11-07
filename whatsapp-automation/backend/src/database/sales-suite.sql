-- Suite de ventas (inspirado en CRM tipo Kanban, hecho en el panel propio):
--   1. Etapa de embudo por cliente (funnel_stage): NUEVO -> NEGOCIANDO -> CERRADO.
--   2. Notas rapidas por cliente (notes), editables desde el chat.
--   3. Pausar la IA por cliente (ai_paused): clientes VIP que prefieren trato
--      humano; la IA nunca les responde automaticamente.
--   4. Anclar conversaciones (pinned): quedan primeras en la bandeja.
--   5. Seguimientos / recordatorios (follow_ups): "llamarle manana 10am" o
--      retomar un chat tibio. El panel los muestra; avisar al dueño.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS funnel_stage TEXT NOT NULL DEFAULT 'NUEVO';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_customers_funnel ON customers (funnel_stage);

-- Seguimientos. done=TRUE guarda cuando se completo; los vencidos (remind_at
-- pasado y done=FALSE) son los que el panel marca en rojo.
CREATE TABLE IF NOT EXISTS follow_ups (
  id serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id int,
  remind_at timestamptz NOT NULL,
  note text,
  done boolean NOT NULL DEFAULT FALSE,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups (done, remind_at);
