# Módulo avanzado: Chat en vivo con IA multimodal

Documentación del módulo de panel de control con chat en vivo, asistente de
IA multimodal y gestión de operadores. Implementado **sobre** la
infraestructura existente (Evolution API + Supabase + Vercel + Gemini), sin
sustituir servicios funcionales.

## 1. Arquitectura

| Componente | Tecnología | Ubicación |
|---|---|---|
| Frontend del panel | Vanilla JS (sin build) | `public/` |
| Backend y API | Express en Vercel Functions (60s) | `backend/src/` |
| Mensajería | Evolution API v2 (Railway) | `backend/src/services/evolution.service.js` |
| Tiempo real | Polling incremental (`since_id`, 5s) — Vercel serverless no soporta WebSockets | `public/js/app.js` |
| Multimedia | Descifrado propio AES-256-CBC (HKDF) de URLs del CDN de WhatsApp | `backend/src/services/media.service.js` |
| IA y transcripción | Gemini (texto, audio, imagen, sticker) | `backend/src/services/ai.service.js` |
| Base de datos | Supabase Postgres | `backend/src/config/database.js` |
| Cola asíncrona | `message_queue` + worker por cron (Supabase pg_cron → `/api/cron/tick`) | `backend/src/workers/message.worker.js` |
| Auditoría | Tabla `automation_logs` | `backend/src/models/automationLog.model.js` |

La recepción de mensajes nunca se bloquea: el webhook registra el mensaje y
responde; la IA, la transcripción y el envío corren en cola/worker.

## 2. Instalación y configuración

1. **Migración** (ya aplicada): columnas de multimedia en `messages`:
   ```sql
   ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
   ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_key TEXT;
   ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
   ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_kind TEXT;
   ```
2. **Variables de entorno (Vercel, producción)**: `DATABASE_URL`,
   `JWT_SECRET`, `GEMINI_API_KEY`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`,
   `EVOLUTION_INSTANCE`, `TIMEZONE=America/Lima`, `START_TIME=00:00`,
   `END_TIME=23:59`, `WEBHOOK_TOKEN`, `CRON_SECRET`.
3. **Deploy**: `vercel deploy --prod` desde la raíz del proyecto.
4. **Webhook**: apuntar Evolution (`MESSAGES_UPSERT`,
   `CONNECTION_UPDATE`, `QRCODE_UPDATED`) a `POST /api/webhooks/whatsapp`
   con el token compartido.

## 3. Funcionalidades

### Chat en vivo (pestaña "Chat en vivo")
- **3 columnas**: lista de conversaciones | chat | panel del asistente.
- **Lista**: nombre, teléfono, vista previa, hora, no leídos (insignia),
  modo de atención (🙋 humano / ✔️ cerrada) y buscador.
- **Chat**: burbujas diferenciadas, marcas de tiempo, borrado por mensaje,
  **multimedia inline**: imágenes, stickers (carga diferida) y notas de voz
  (reproductor), todo servido descifrado por `GET /api/messages/:id/media`.
- **Barra de escritura**: el operador envía como él (cancela la respuesta
  pendiente de la IA para evitar contradicciones).
- **Panel del asistente**: resumen de la conversación por IA y contexto.
- **Notificaciones**: insignia de no leídos en la pestaña, estado de
  conexión de WhatsApp en la barra del chat.
- **Tiempos reales**: actualización incremental cada 5s solo con mensajes
  nuevos (`since_id`); tras una desconexión se recupera del historial en BD
  (la BD es la fuente de verdad); dedup por `id` de mensaje.

### Asistente por conversación
- Cada conversación mantiene su propio contexto (historial + memoria de
  largo plazo del cliente en `customers.ai_profile`).
- **Sugerir** (✨): la IA propone una respuesta; se muestra en una caja
  marcada *"propuesta, no enviada"* con Enviar/Descartar. Solo entra a la
  barra de escritura cuando el operador la aprueba.
- **Resumen** (📄): resumen de la conversación para el operador.

### Modos de funcionamiento
- **Global** (pestaña Estado): Activar / Pausar / Detener / Reanudar.
  > ⚠️ Si el bot "no responde", revisa que el estado global no esté en
  > `STOPPED` (el worker descarta todos los envíos). El botón *Reanudar*
  > de la pestaña Cola NO reactiva la automatización: usa *Activar* en
  > pestaña Estado.
- **Por conversación** (selector del chat):
  - `OPEN` (🤖 Automático): la IA responde.
  - `HUMAN` (🙋 Humano): pausa la IA de esa conversación; el operador
    responde desde la barra. El webhook registra
    `auto_reply_skipped: conversacion en atencion humana`.
  - `CLOSED` (✔️ Cerrada).

### Multimodal
- **Audios**: descifrado + transcripción Gemini (es-419). El bot responde
  al contenido de forma natural; si no se entiende (`INAUDIBLE`) lo dice
  con elegancia. La transcripción queda en el mensaje como
  `[La persona envio una nota de voz que dice]: ...`.
- **Imágenes**: descifrado + visión Gemini (descripción + OCR cuando hay
  texto). Sin inventar detalles.
- **Stickers**: descifrado + descripción de la IA; se muestran como imagen
  WEBP en el panel. Se guarda `media_kind='STICKER'` (el tipo en BD es
  `OTHER` por el CHECK de la tabla).
- **Documentos**: se registran; el texto de PDFs se leerá cuando el
  mensaje traiga caption (extensible).

### Borrado
- `DELETE /api/messages/:id` borra del panel y, si el mensaje salió del
  bot, intenta el *delete for everyone* en WhatsApp (cliente listo que
  prueba las variantes del endpoint). **Nota**: la versión actual de
  Evolution API (2.3.7) no expone la ruta de borrado; en cuanto el
  servidor la incluya, funcionará sin cambios de código.

## 4. API nueva

| Método y ruta | Uso |
|---|---|
| `POST /api/messages` | Enviar del operador `{conversation_id, text}` |
| `GET /api/messages?conversation_id=X&since_id=Y` | Polling incremental (solo `id > Y`) |
| `GET /api/messages/:id/media?token=…` | Archivo descifrado (Bearer o `?token=`) |
| `GET /api/messages/suggestions?conversation_id=X` | Respuesta sugerida (NO se envía) |
| `GET /api/messages/summary?conversation_id=X` | Resumen de la conversación |
| `DELETE /api/messages/:id` | Borrar del panel (+ WhatsApp si aplica) |
| `PUT /api/conversations/:id` `{status}` | Cambiar modo (OPEN/HUMAN/CLOSED) |

## 5. Seguridad

- Todas las rutas requieren JWT (`Bearer`); la ruta de media también
  acepta `?token=` para `<img>/<audio>`. Nunca expone la BD ni el CDN.
- El contenido de mensajes/archivos se trata como dato no confiable: todo
  lo que se pinta pasa por `esc()` (anti-XSS) y las instrucciones dentro
  de un audio/imagen son solo contenido, nunca órdenes para el sistema.
- Límites: mensajes ≤ 4096 caracteres por envío del panel; rate limits
  existentes del worker para los envíos automáticos.
- Auditoría: cada acción relevante queda en `automation_logs`
  (`panel_send`, `message_deleted`, `human_takeover`, `auto_reply_skipped`…).

## 6. Criterios de aceptación (verificados)

1. ✅ Mensajes de texto aparecen en tiempo real (polling 5s, E2E).
2. ✅ Audios se transcriben (Gemini; probado con nota de voz real).
3. ✅ Imágenes se muestran (1200×1600 real) y se analizan.
4. ✅ Stickers se visualizan (WEBP real) y se describen con incertidumbre.
5. ✅ Contexto por conversación (historial + memoria en BD).
6. ✅ Sin duplicados (dedup por `external_message_id` + `since_id`).
7. ✅ Errores visibles y recuperables (poll reintenta; cola reintenta).
8. ✅ Permisos: 401 sin token en `/media` (probado).
9. ✅ Modo HUMAN detiene el envío automático (E2E: `auto_reply_skipped`).
10. ✅ Propuestas vs. enviados: caja de sugerencia marcada; el envío real
    solo por barra o IA automática.
11. ✅ Backend + BD reales (Vercel + Supabase).
12. ✅ Esta documentación.

## 7. Pruebas manuales rápidas

```bash
# Login
curl -s -X POST https://<host>/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@botlocal.test","password":"***"}'

# Enviar como operador
curl -s -X POST https://<host>/api/messages -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' \
  -d '{"conversation_id":8,"text":"Hola, te escribe el operador"}'

# Sugerencia / resumen / media
curl -s "https://<host>/api/messages/suggestions?conversation_id=8" -H "Authorization: Bearer $T"
curl -s "https://<host>/api/messages/summary?conversation_id=8" -H "Authorization: Bearer $T"
curl -s -o img.jpg "https://<host>/api/messages/51/media?token=$T"

# Modo humano (pausa IA en esa conversacion)
curl -s -X PUT https://<host>/api/conversations/8 -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"status":"HUMAN"}'
```

## 8. Limitaciones conocidas (honestas)

- No hay WebSockets: Vercel serverless no los soporta; el equivalente es
  polling incremental cada 5s (verificado sin duplicados).
- Borrar en WhatsApp para todos requiere que el servidor Evolution exponga
  la ruta (hoy 2.3.7 no la trae); el código ya la usa automáticamente.
- Animaciones de stickers: se muestran estáticas (primer fotograma); el
  análisis de la IA es sobre la imagen.
- El reproductor de audio carga el archivo al dar play (`preload="none"`).
