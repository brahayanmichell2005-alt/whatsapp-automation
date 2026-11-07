# Módulo: Asistente virtual "Nova" integrado en el panel

Documentación del asistente de propósito general integrado en el panel de
Vercel: personaje flotante + ventana de chat conectada a Gemini y a las
herramientas reales del backend. Implementado **sobre** la infraestructura
existente (Evolution API + Supabase + Vercel + Gemini), sin sustituir
servicios funcionales.

> Este módulo **reemplaza** al antiguo sistema de "comandos por auto-chat"
> (el dueño escribía comandos en su propio chat de WhatsApp). Ese sistema
> fue eliminado por completo: el dueño ahora controla el asistente desde el
> panel. El resumen diario por WhatsApp también se eliminó; se consulta en
> el chat de Nova.

## 1. Arquitectura

| Componente | Tecnología | Ubicación |
|---|---|---|
| Personaje flotante + chat | Vanilla JS (sin build), integrado en el panel de una sola página | `public/js/assistant.js`, `public/index.html`, `public/css/style.css` |
| Endpoint del chat | `POST /api/assistant/chat` (JWT `requireAuth`) | `backend/src/controllers/assistantChat.controller.js` |
| IA | Gemini vía `aiService.chat` (texto + Google Search grounding) | `backend/src/services/ai.service.js` |
| Análisis de archivos | `aiService.understandMedia` (mismo motor multimodal de WhatsApp: imagen/audio) | `backend/src/services/ai.service.js` |
| Datos del sistema | Consultas reales a Supabase (`systemStats`, `buildDailySummary`) | `backend/src/services/assistant.service.js` |
| Envío de WhatsApp | Evolution API (solo con confirmación del dueño) | `backend/src/services/evolution.service.js` |
| Auditoría | `automation_logs` (`assistant_whatsapp_sent`, `assistant_action_proposed`) | `backend/src/models/automationLog.model.js` |

- Sin claves API en el frontend: `GEMINI_API_KEY` vive solo en el servidor
  (secreto de Vercel). El navegador solo habla con `/api/assistant/chat`
  usando el JWT del panel.
- Sin procesos permanentes en memoria: todo es stateless (Vercel
  Functions). El historial del chat vive en `localStorage`
  (clave `wa_assistant_history`, últimos 80 mensajes) y se envía como
  contexto en cada petición.
- Sin WebSockets: la ventana de chat es request/response; no lo necesita.

## 2. El personaje flotante

- **FAB** (botón flotante) en la esquina inferior derecha: círculo con
  gradiente azul→violeta y el emoji 🤖.
- Animaciones sutiles: flotación vertical, anillo de pulso, rotación al
  pasar el cursor; se respetan las preferencias del sistema
  (`prefers-reduced-motion: reduce` desactiva todas).
- **Punto verde parpadeante** cuando llega una respuesta o error con el
  chat minimizado (indicador discreto).
- El panel es una sola página: el chat **conserva su estado** al navegar
  entre pestañas y **sobrevive recargas** vía `localStorage`.

### Ventana de chat

- Cabecera: avatar, nombre "Nova", estado (Procesando... / Asistente del
  panel), botones minimizar (—) y cerrar (✕).
- Historial con burbujas diferenciadas y **Markdown seguro** (renderizador
  propio `mdLite`: todo se escapa antes de transformar; soporta bloques de
  código, código inline, negritas, itálicas, listas, títulos, enlaces
  http/https).
- Indicador de procesamiento con puntos animados; entrada y botón enviar
  bloqueados mientras se espera respuesta.
- Mensajes de error claros en burbuja roja (429, sin conexión, etc.).
- Adjuntos 📎: imagen o audio hasta **3 MB** (límite del body de Vercel
  ~4.5 MB) → base64 → analizados por el backend con Gemini multimodal.
- Responsive: en pantallas ≤480px la ventana ocupa casi toda la pantalla
  (hoja completa).

## 3. Endpoint `POST /api/assistant/chat`

Protegido por JWT (`requireAuth`). Cuerpo JSON:

```json
{ "message": "texto", "history": [{"role":"user|assistant","content":"..."}], "attachment": {"name","mimetype","data(base64)"} }
```

Confirmación de un envío propuesto:

```json
{ "confirm": { "telefono": "51999888999", "texto": "mensaje" } }
```

Respuestas:

- Normal: `{ "reply": "texto markdown", "pendingAction": null }`
- Con envío propuesto: `{ "reply": "...", "pendingAction": { "telefono", "texto" } }` —
  **nunca se ejecuta solo**; el frontend muestra la barra de confirmación.
- Confirmado: `{ "reply": "✅ Enviado a ...", "actionExecuted": true }` y se
  registra en `automation_logs` (`assistant_whatsapp_sent`).
- Errores: `400` sin mensaje / sin teléfono+texto, `401` sin token,
  `429` límite de ritmo del proveedor de IA (mensaje amable),
  `502` fallo del proveedor, `503` IA sin configurar o WhatsApp desconectado.

### Protocolo interno IA ↔ backend

| Marcador | Uso |
|---|---|
| `BUSCAR: <consulta>` | La IA pide búsqueda web; el backend hace una 2ª llamada con Google Search grounding real. |
| `[ENVIAR_WHATSAPP]\n{"telefono","texto"}` | La IA **propone** un envío; el backend lo extrae, lo registra como propuesto y lo devuelve como `pendingAction`. |

### Herramientas reales (lo único que puede hacer)

1. **Búsqueda web** (Google Search grounding): solo si la frase la pide
   explícitamente, o si la IA responde con el marcador `BUSCAR:`.
2. **Datos vivos del sistema**: estadísticas reales de la BD (clientes,
   conversaciones abiertas, mensajes 24h, cola, programados, modo del
   asistente) siempre van en el prompt del sistema; el **resumen de
   actividad de 24h** se inyecta cuando la petición lo pide
   (resumen/reporte/actividad).
3. **Enviar WhatsApp**: propuesta + confirmación explícita del dueño
   (acción sensible; jamás se ejecuta sola).
4. **Analizar imagen/audio adjunto** (≤3 MB): contexto multimodal real.

### Lo que NO puede hacer (y lo dice honestamente)

- No ejecuta código ni modifica archivos del servidor.
- No entra a otras aplicaciones ni cuentas externas.
- No borra mensajes de WhatsApp (la versión de Evolution API desplegada no
  tiene ruta de revoke).

El prompt del sistema le prohíbe fingir capacidades: si algo no está
integrado, debe decirlo y proponer alternativas.

## 4. Variables de entorno

**No se requiere ninguna variable nueva.** Reutiliza las existentes:

| Variable | Uso en este módulo |
|---|---|
| `GEMINI_API_KEY` | Chat, búsqueda web, análisis de adjuntos (solo servidor). |
| `DATABASE_URL` | Estadísticas y resumen reales. |
| `JWT_SECRET` | Valida la sesión del panel (`requireAuth`). |
| `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` / `EVOLUTION_INSTANCE` | Envío confirmado de WhatsApp. |

## 5. Límites y degradación elegante

- **Cuota de búsqueda web**: el grounding de Google Search en el nivel
  gratuito de Gemini tiene cuota diaria; al agotarse (HTTP 429) el
  asistente **no falla**: reintenta sin búsqueda, responde con su
  conocimiento general y añade una nota honesta de que puede no estar
  actualizado. Si además el propio chat alcanza el límite de RPM, el
  frontend muestra un mensaje claro pidiendo reintentar en unos segundos.
- **Adjuntos ≤3 MB** (limite del body de Vercel); solo imagen/audio por
  ahora. Más grandes: error claro.
- **Historial**: últimos 14 turnos como contexto (recortado a 4000
  caracteres por mensaje); en `localStorage` se guardan los últimos 80.
- **Mensajes ≤6000 caracteres**.
- Envíos de WhatsApp dependen de Evolution API: errores pasajeros de
  Railway (HTTP 500 Prisma) se reintentan desde la UI.

## 6. Cambios relacionados (auto-chat eliminado)

| Archivo | Cambio |
|---|---|
| `backend/src/services/messageIntake.service.js` | Ya no procesa comandos del dueño en su chat personal. |
| `backend/src/controllers/cron.controller.js` | `dailyTick` eliminado del tick (el resumen ahora es herramienta de Nova). |
| `backend/src/services/assistant.service.js` | Reescrito: `getSettings`, `effectiveMode`, `buildDailySummary` (herramienta), `systemStats` (nuevo). Sin `parseOwnerCommand`, `executeOwnerCommand`, `sendToContact`, `sendToOwner`, `dailyTick`. |

## 7. Checklist de aceptación (verificado en producción)

- [x] El personaje aparece en el panel (una sola página: persiste en todas las pestañas).
- [x] Clic abre el chat (el FAB se oculta), minimizar/cerrar lo devuelven con punto verde si hay novedades.
- [x] Solicitudes reales al backend: respuesta con datos vivos ("32 clientes registrados..."), Markdown renderizado.
- [x] Envío propuesto por la IA → barra de confirmación → Confirmar → envío real por WhatsApp + registro en auditoría.
- [x] Confirmación **nunca** se ejecuta sin el dueño (verificado: `pendingAction` sin ejecutar).
- [x] Errores: 400 sin mensaje, 401 sin token, 429 con mensaje amable, búsqueda sin cuota degrada con nota honesta.
- [x] Historial persiste en `localStorage` tras recargas.
- [x] Sin claves API en el frontend (revisado: `assistant.js` solo usa `apiFetch` con JWT).
- [x] Desplegado en Vercel: `https://whatsapp-automation-peach.vercel.app`.

Pendiente visual: verificación manual en pantallas muy pequeñas (los
estilos ≤480px están escritos pero no verificados en dispositivo real).
