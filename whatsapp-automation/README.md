# WhatsApp Automation — Vercel + Supabase

Sistema de atención automática por WhatsApp: recibe mensajes por webhook, clasifica al cliente, encola respuestas y las envía respetando horario, consentimiento (opt-in/opt-out), límites e intervalos.

| Pieza | Dónde vive | Costo inicial |
|---|---|---|
| Panel web (`public/`) | **Vercel** (CDN) | gratis |
| API Node.js/Express (`api/` + `backend/`) | **Vercel** (función serverless) | gratis |
| Base de datos PostgreSQL | **Supabase** | gratis |
| Tareas de fondo (enviar la cola) | **Supabase `pg_cron`** → llama a Vercel cada minuto | gratis |
| Conexión con WhatsApp (Evolution API) | **Servidor propio** (ver aviso) | depende |

> ⚠️ **Evolution API no puede correr en Vercel ni en Supabase.** Mantiene una conexión permanente con WhatsApp, y Vercel solo ofrece funciones que viven unos segundos. Necesitas alojarla aparte (un VPS pequeño, Railway, Render, Fly.io…, con Docker). Este proyecto solo necesita su URL y su API key. Mientras tanto puedes probar todo lo demás con el simulador (`npm run simulate:webhook`).

```
WhatsApp ⇄ Evolution API ──webhook──▶ Vercel (API) ⇄ Supabase (PostgreSQL)
                 ▲                        ▲                  │
                 └────── envío ───────────┤                  │
                                          └── cada minuto ── Supabase pg_cron
```

## Estructura

```
api/index.js            Punto de entrada de Vercel (toda petición /api/*)
public/                 Panel web estático
backend/src/            Código del backend (rutas, controladores, modelos, servicios, worker)
backend/checks/         Verificaciones que no necesitan base de datos (npm run check)
backend/tests/          Pruebas Jest (npm test)
database/schema.sql     Tablas para Supabase (ejecutar una vez)
database/cron.sql       Programa el worker cada minuto en Supabase
vercel.json             Configuración de Vercel
```

---

## Despliegue paso a paso

### 1. Supabase (base de datos)
1. Crea un proyecto en [supabase.com](https://supabase.com). Guarda la contraseña de la base de datos.
2. **SQL Editor → New query**, pega todo `database/schema.sql` y pulsa **Run**. Crea las tablas y activa la seguridad RLS.
3. Pulsa **Connect** (arriba) y copia la cadena **Transaction pooler** (puerto `6543`). Se ve así:
   `postgresql://postgres.<ref>:[TU-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres`
   Reemplaza `[TU-PASSWORD]` por tu contraseña. Si tiene caracteres como `@ : / # ?`, codifícalos (`@` → `%40`).

### 2. GitHub
Sube esta carpeta a un repositorio. **No subas `.env`** (el `.gitignore` ya lo excluye).

### 3. Vercel (backend + panel)
1. **Add New → Project** e importa el repositorio. Framework Preset: **Other**. Deja Build Command vacío.
2. En **Environment Variables** agrega (ver la tabla completa más abajo):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | la cadena Transaction pooler del paso 1 |
   | `JWT_SECRET` | aleatorio largo (ver comando abajo) |
   | `CRON_SECRET` | aleatorio largo, distinto |
   | `WEBHOOK_SECRET` | aleatorio largo, distinto |
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | tu acceso al panel |
   | `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` | los de tu Evolution API (pueden ir después) |

   Generar un secreto: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   **No copies `NODE_ENV`**: Vercel ya lo maneja.
3. **Deploy**.
4. Comprueba `https://TU-PROYECTO.vercel.app/api/dashboard/health`: debe responder `"database": "UP"`. Luego abre `https://TU-PROYECTO.vercel.app`, inicia sesión con `ADMIN_EMAIL`/`ADMIN_PASSWORD` (el usuario se crea en la primera petición).

### 4. Cron en Supabase (procesa la cola cada minuto)
En el plan gratuito de Vercel los Cron Jobs solo pueden ejecutarse **una vez al día**, así que no sirven para enviar mensajes. Supabase puede llamar a tu backend cada minuto sin costo:

1. Abre `database/cron.sql`, reemplaza `https://TU-PROYECTO.vercel.app` y el `CRON_SECRET` (el mismo de Vercel).
2. Pégalo en el **SQL Editor** y ejecútalo.
3. Verifica en el SQL Editor:
   ```sql
   select * from cron.job;
   select status_code, content, error_msg from net._http_response order by created desc limit 5;
   ```
   `status_code = 200` es correcto. `401` = el secreto no coincide. `503` = falta `CRON_SECRET` en Vercel.

> Si algún día pasas a Vercel Pro, puedes usar su cron nativo agregando en `vercel.json`: `"crons": [{ "path": "/api/cron/tick", "schedule": "* * * * *" }]` (Vercel envía solo la cabecera con `CRON_SECRET`).

### 5. Evolution API → tu backend
En tu Evolution API, configura el webhook de la instancia:
- **URL:** `https://TU-PROYECTO.vercel.app/api/webhooks/whatsapp`
- **Eventos:** `MESSAGES_UPSERT`, `CONNECTION_UPDATE`, `QRCODE_UPDATED`
- **Cabecera:** `x-webhook-token: <tu WEBHOOK_SECRET>` (si tu versión no permite cabeceras personalizadas, el webhook queda protegido solo por no ser adivinable; en ese caso deja `WEBHOOK_SECRET` vacío).

Luego, desde el panel, genera el QR y vincula WhatsApp.

### 6. Prueba de punta a punta (sin WhatsApp)
```bash
BACKEND_URL=https://TU-PROYECTO.vercel.app WEBHOOK_SECRET=xxxx ADMIN_EMAIL=tu@correo ADMIN_PASSWORD=xxxx npm run simulate:webhook
```
En PowerShell: `$env:BACKEND_URL="https://..."; $env:WEBHOOK_SECRET="..."; npm run simulate:webhook`.
Debe crear un cliente y dejar una respuesta `PENDING` en la cola. Se enviará en el siguiente minuto **solo si** estás dentro del horario de atención y WhatsApp está conectado.

---

## Desarrollo local

```bash
npm install
copy .env.example .env      # y completa DATABASE_URL (puedes usar tu proyecto Supabase o uno de pruebas)
npm run dev                 # API en http://localhost:3000   (incluye el scheduler de mensajes programados)
npm run worker              # (otra terminal) worker de envío en bucle
npm run panel               # (otra terminal) panel en http://localhost:8080
```
El panel detecta `:8080` y apunta a `http://localhost:3000` automáticamente.

Verificaciones:
- `npm run check` — 128 comprobaciones **sin base de datos ni instalar nada extra**: valida cada consulta SQL, el worker, los límites, la protección del cron y la conexión.
- `npm test` — pruebas Jest (requieren `npm install`).
- `npm run smoke` — ejercita los modelos contra tu base real (crea datos de prueba).

---

## Cómo funciona el trabajo de fondo
No hay procesos permanentes. Cada minuto, `pg_cron` llama a `POST /api/cron/tick`, que:
1. mueve a la cola los mensajes programados cuya hora llegó;
2. ejecuta el worker durante ~45 s: envía pendientes respetando automatización activa, horario, opt-out, límites por minuto/hora/día, conexión de WhatsApp y el intervalo `MIN_DELAY_SECONDS`–`MAX_DELAY_SECONDS` (el momento del último envío se guarda en la base para respetarlo entre llamadas).

Un candado en la base evita que dos ejecuciones se pisen, y los mensajes que queden `PROCESSING` más de 5 minutos (por un corte) vuelven a `PENDING`.

Consecuencia práctica: con intervalos de 10–30 s salen unos 2–3 mensajes por minuto. Para más volumen, reduce `MIN/MAX_DELAY_SECONDS` con responsabilidad.

## API

| Ruta | Acceso | Descripción |
|---|---|---|
| `GET /api/dashboard/health` | público | Estado de backend, base de datos y WhatsApp |
| `GET /api/dashboard/logs` | login | Bitácora de eventos |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | login | Sesión del panel |
| `GET/POST/PUT/DELETE /api/customers` | login | Clientes |
| `GET/PUT /api/conversations` | login | Conversaciones |
| `GET /api/messages` | login | Mensajes |
| `GET /api/queue` · `POST /api/queue/pause\|resume\|stop` | login | Cola de envío |
| `GET/POST/PUT/DELETE /api/scheduled-messages` | login | Mensajes programados |
| `GET /api/automation/status` · `POST …/activate\|pause\|stop\|resume` | estado público, acciones con login | Interruptor global |
| `GET /api/instance/status` · `POST /create` · `GET /qrcode` · `POST /logout` | estado público, resto con login | Instancia de WhatsApp |
| `POST /api/webhooks/whatsapp` | `x-webhook-token` | Recibe eventos de Evolution API |
| `GET\|POST /api/cron/tick` | `Authorization: Bearer <CRON_SECRET>` | Ejecuta scheduler + worker |

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DATABASE_URL` | sí | Cadena Transaction pooler de Supabase |
| `JWT_SECRET` | sí (producción) | Firma de sesiones del panel |
| `CRON_SECRET` | sí | Protege `/api/cron/tick` (sin él responde 503) |
| `WEBHOOK_SECRET` | recomendada | Protege el webhook (vacío = abierto) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | sí | Administrador inicial (en producción no hay valores por defecto) |
| `EVOLUTION_API_URL` / `_KEY` / `EVOLUTION_INSTANCE` | para enviar | Conexión con Evolution API |
| `START_TIME`, `END_TIME`, `TIMEZONE` | no | Horario de atención (08:00–20:00, America/Lima) |
| `MIN_DELAY_SECONDS`, `MAX_DELAY_SECONDS` | no | Intervalo entre envíos (10–30) |
| `MAX_MESSAGES_PER_MINUTE/HOUR/DAY`, `MAX_CONCURRENT_SENDS`, `MAX_RETRIES` | no | Límites |
| `AI_PROVIDER`, `AI_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | no | IA opcional (`ollama` requiere un servidor propio) |
| `DB_POOL_MAX`, `DB_SSL`, `CRON_BUDGET_MS`, `CORS_ORIGIN`, `LOG_LEVEL` | no | Ajustes finos (ver `.env.example`) |

## Seguridad
- Todas las tablas tienen **RLS activado sin políticas**: la API pública de Supabase (con la `anon key`) no puede leer ni escribir tus datos. Solo tu backend, conectado con el rol `postgres`, accede.
- Las rutas que devuelven datos de clientes, conversaciones, mensajes o la cola **exigen login**.
- Nunca subas `.env` a GitHub ni compartas `DATABASE_URL`. Si alguna credencial se expuso, cámbiala (Supabase → Settings → Database → Reset password; regenera los secretos en Vercel).
- Usa `JWT_SECRET`, `CRON_SECRET` y `WEBHOOK_SECRET` largos y distintos entre sí.

## Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| `Tenant or user not found` | Usuario o región incorrectos en `DATABASE_URL`. Vuelve a copiar la cadena desde **Connect**. |
| `self-signed certificate` | Ya se maneja en `config/database.js`. Verifica que no definiste `DB_SSL=false`. |
| `ENOTFOUND` / `ENETUNREACH` | Usaste la conexión *directa* (solo IPv6). Usa la cadena **Transaction pooler**. |
| `health` responde `database: DOWN` | Revisa `DATABASE_URL` en Vercel y **redeploya** (los cambios de variables no aplican a despliegues ya hechos). |
| Login falla con credenciales correctas | El admin se crea una sola vez, con los valores de `ADMIN_EMAIL`/`ADMIN_PASSWORD` de ese momento. Si los cambiaste después, borra esa fila en Supabase (**Table Editor → users**) y abre el panel: se recreará con los valores actuales. |
| Los mensajes se quedan `PENDING` | Revisa: horario de atención, WhatsApp `CONNECTED`, automatización `ACTIVE`, y que el cron devuelva 200 (`net._http_response`). |
| Error de deploy: *Hobby accounts are limited to daily Cron Jobs* | Agregaste `crons` con frecuencia menor a diaria en `vercel.json`. En el plan Hobby elimínalo y usa `database/cron.sql`. |
| `EVOLUTION_API_URL no esta configurado` en logs | Falta configurar Evolution API; es un aviso, no impide el resto. |
