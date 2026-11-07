// Panel administrativo (Entrega 9). Vanilla JS, sin build step:
// login con JWT (guardado en memoria + localStorage para persistir la
// sesion entre recargas), navegacion por pestañas, y una seccion por
// entidad (clientes, conversaciones, cola, programados, logs).

const API_BASE = window.location.origin.includes(':8080')
  ? window.location.origin.replace(':8080', ':3000')
  : window.location.origin;

const TOKEN_STORAGE_KEY = 'wa_admin_token';

// Escapa todo dato que venga de WhatsApp o de la base de datos antes de
// pintarlo con innerHTML. Sin esto, el nombre de un cliente (pushName) o el
// texto de un mensaje podrian inyectar HTML/JS en el panel (XSS almacenado).
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Función para obtener siempre el token fresco del almacenamiento local
function getAuthToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || null;
}

// ---------------------------------------------------------------------
// Fetch autenticado
// ---------------------------------------------------------------------
async function apiFetch(path, options = {}) {
  const currentToken = getAuthToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    logout();
    throw new Error('Sesion expirada, vuelve a iniciar sesion');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------
function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  refreshAll();
}

function showLogin() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function logout() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  showLogin();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    showApp();
  } catch (err) {
    errorEl.textContent = err.message || 'No se pudo iniciar sesion';
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    // ignorar: igual cerramos sesion localmente
  }
  logout();
});

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
  });
});

// ---------------------------------------------------------------------
// Estado / healthcheck
// ---------------------------------------------------------------------
async function fetchHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/dashboard/health`);
    const data = await res.json();
    updateBadge('backend', data.backend === 'UP');
    updateBadge('database', data.database === 'UP');
    updateWhatsappBadge(data.whatsapp);
  } catch (err) {
    updateBadge('backend', false);
    updateBadge('database', false);
    updateWhatsappBadge('ERROR');
  }
}

// Una vez por sesion: se asegura de que Evolution API envie los mensajes al backend.
let webhookEnsured = false;
async function ensureWebhookOnce() {
  if (webhookEnsured || !getAuthToken()) return;
  webhookEnsured = true;
  try {
    await apiFetch('/api/instance/webhook', { method: 'POST' });
  } catch (err) {
    webhookEnsured = false; // se reintenta en el siguiente chequeo de estado
  }
}

function updateWhatsappBadge(rawStatus) {
  const el = document.getElementById('status-whatsapp');
  if (!el) return;
  const labels = { CONNECTED: 'CONECTADO', DISCONNECTED: 'DESVINCULADO', CONNECTING: 'CONECTANDO', ERROR: 'ERROR' };
  el.textContent = labels[rawStatus] || 'ERROR';
  el.classList.remove('up', 'down');
  el.classList.add(rawStatus === 'CONNECTED' ? 'up' : 'down');
  // Sincroniza el bloque de conexion del sidebar Pro Suite y el topbar
  const conn = document.getElementById('sb-conn');
  const connDot = document.getElementById('sb-conn-dot');
  const connText = document.getElementById('sb-conn-text');
  const connLabel = document.getElementById('sb-conn-label');
  if (conn && connDot && connText) {
    const on = rawStatus === 'CONNECTED';
    conn.classList.toggle('on', on);
    conn.classList.toggle('off', !on);
    connText.textContent = on
      ? 'WhatsApp Conectado'
      : rawStatus === 'CONNECTING' ? 'Conectando...' : 'Sesión Desconectada';
    if (connLabel) connLabel.textContent = on ? 'Activo' : 'Vincular';
  }
  const topInstance = document.getElementById('top-instance');
  if (topInstance) {
    topInstance.textContent = rawStatus === 'CONNECTED'
      ? 'conectada'
      : rawStatus === 'CONNECTING' ? 'conectando…' : 'sin sesión';
  }
  const dc = document.getElementById('btn-disconnect');
  if (dc) dc.hidden = rawStatus !== 'CONNECTED';
  if (rawStatus === 'CONNECTED') ensureWebhookOnce();
}

// PostgreSQL devuelve fechas ISO (2026-09-19T14:30:00.000Z): se muestran en hora local.
function fmtDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('es-PE');
}

function updateBadge(service, isUp) {
  const el = document.getElementById(`status-${service}`);
  if (!el) return;
  el.textContent = isUp ? 'CONECTADO' : 'DESCONECTADO';
  el.classList.remove('up', 'down');
  el.classList.add(isUp ? 'up' : 'down');
}

let waPollTimer = null;

function setWaMessage(text, extraNode) {
  const container = document.getElementById('qr-container');
  container.textContent = '';
  if (text) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = text;
    container.appendChild(p);
  }
  if (extraNode) container.appendChild(extraNode);
}

function stopWaPolling() {
  if (waPollTimer) clearInterval(waPollTimer);
  waPollTimer = null;
}

// Consulta el estado REAL de Evolution API cada 5 s (maximo 3 minutos).
function startWaPolling() {
  stopWaPolling();
  let tries = 0;
  waPollTimer = setInterval(async () => {
    tries += 1;
    try {
      const res = await fetch(`${API_BASE}/api/instance/status`);
      const data = await res.json();
      updateWhatsappBadge(data.status);
      if (data.status === 'CONNECTED') {
        stopWaPolling();
        setWaMessage('WhatsApp conectado');
        return;
      }
    } catch (err) {
      /* se reintenta en el siguiente ciclo */
    }
    if (tries >= 36) {
      stopWaPolling();
      setWaMessage('Tiempo agotado. Genera un codigo nuevo e intentalo otra vez.');
    }
  }, 5000);
}

async function connectWhatsapp() {
  const btnQr = document.getElementById('btn-qr');
  const path = '/api/instance/qrcode';
  btnQr.disabled = true;
  setWaMessage('Conectando...');
  updateWhatsappBadge('CONNECTING');

  try {
    const data = await apiFetch(path);
    if (data.status === 'CONNECTED') {
      setWaMessage('WhatsApp conectado');
      updateWhatsappBadge('CONNECTED');
      return;
    }
    if (data.pairingCode) {
      const code = String(data.pairingCode).replace(/(.{4})(?=.)/, '$1-');
      const big = document.createElement('div');
      big.textContent = code;
      big.style.cssText = 'font-size:2rem;letter-spacing:.2em;font-weight:700;margin:12px 0';
      setWaMessage('En WhatsApp: Dispositivos vinculados > Vincular con el numero de telefono. Escribe este codigo:', big);
      startWaPolling();
    } else if (data.base64) {
      const img = document.createElement('img');
      img.alt = 'Codigo QR de WhatsApp';
      img.src = data.base64.startsWith('data:') ? data.base64 : `data:image/png;base64,${data.base64}`;
      setWaMessage('Escanea este QR desde WhatsApp > Dispositivos vinculados > Vincular un dispositivo.', img);
      startWaPolling();
    } else {
      setWaMessage('Evolution API aun esta preparando la sesion. Espera unos segundos y vuelve a pulsar el boton.');
    }
  } catch (err) {
    updateWhatsappBadge('ERROR');
    setWaMessage(`No se pudo conectar: ${err.message}`);
  } finally {
    
    btnQr.disabled = false;
  }
}

async function disconnectWhatsapp() {
  if (!window.confirm('Desconectar WhatsApp de este panel?')) return;
  stopWaPolling();
  try {
    await apiFetch('/api/instance/logout', { method: 'POST' });
    setWaMessage('WhatsApp desconectado.');
  } catch (err) {
    setWaMessage(`No se pudo desconectar: ${err.message}`);
  }
  fetchHealth();
}


document.getElementById('btn-qr')?.addEventListener('click', () => connectWhatsapp());
document.getElementById('btn-disconnect')?.addEventListener('click', disconnectWhatsapp);

// ---------------------------------------------------------------------
// Control de automatizacion
// ---------------------------------------------------------------------
async function fetchAutomationStatus() {
  const topMode = document.getElementById('top-mode');
  try {
    const data = await apiFetch('/api/automation/status');
    document.getElementById('automation-status').textContent = data.status;
    // Topbar: modo real de la automatizacion (ACTIVE/PAUSED/STOPPED)
    if (topMode) {
      topMode.textContent =
        data.status === 'ACTIVE' ? 'AUTO' : data.status === 'PAUSED' ? 'PAUSA' : data.status;
      topMode.className = data.status === 'ACTIVE' ? 'on' : data.status === 'PAUSED' ? 'warn' : '';
    }
  } catch (err) {
    document.getElementById('automation-status').textContent = 'ERROR';
    if (topMode) {
      topMode.textContent = 'sin conexión';
      topMode.className = 'warn';
    }
  }
}

document.querySelectorAll('[data-automation]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await apiFetch(`/api/automation/${btn.dataset.automation}`, { method: 'POST' });
      fetchAutomationStatus();
    } catch (err) {
      alert(err.message);
    }
  });
});

// ---------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------
async function loadCustomers() {
  const tbody = document.querySelector('#table-customers tbody');
  tbody.innerHTML = '<tr><td colspan="7">Cargando...</td></tr>';
  try {
    const customers = await apiFetch('/api/customers?limit=200');
    // Badge de contactos del sidebar Pro Suite
    const contactsBadge = document.getElementById('contacts-count-badge');
    if (contactsBadge) {
      contactsBadge.textContent = String(customers.length);
      contactsBadge.hidden = customers.length === 0;
    }
    tbody.innerHTML = customers
      .map(
        (c) => `<tr>
          <td>${esc(c.id)}</td>
          <td>${esc(c.phone)}</td>
          <td>${esc(c.name || '-')}</td>
          <td>${esc(c.status)}</td>
          <td>${esc(c.interest_type || '-')}</td>
          <td>${esc(fmtDate(c.last_message_at))}</td>
          <td>
            <select class="stage-mini" data-stage-customer="${esc(c.id)}" title="Etapa de embudo">
              <option value="NUEVO"${c.funnel_stage === 'NUEVO' ? ' selected' : ''}>🆕 Nuevo</option>
              <option value="NEGOCIANDO"${c.funnel_stage === 'NEGOCIANDO' ? ' selected' : ''}>🤝 Negociando</option>
              <option value="CERRADO"${c.funnel_stage === 'CERRADO' ? ' selected' : ''}>🏆 Cerrado</option>
            </select>
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="7">Sin clientes todavia.</td></tr>';
    tbody.querySelectorAll('[data-stage-customer]').forEach((sel) => {
      sel.addEventListener('change', () => setCustomerStage(Number(sel.dataset.stageCustomer), sel.value));
    });
    renderFunnelBoard(customers);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7">Error: ${esc(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------
async function loadConversations() {
  const tbody = document.querySelector('#table-conversations tbody');
  tbody.innerHTML = '<tr><td colspan="5">Cargando...</td></tr>';
  try {
    const conversations = await apiFetch('/api/conversations?limit=100');
    tbody.innerHTML = conversations
      .map(
        (c) => `<tr>
          <td>${esc(c.id)}</td>
          <td>${esc(c.customer_id)}</td>
          <td>${esc(c.status)}</td>
          <td>${esc(fmtDate(c.last_message_at))}</td>
          <td>
            ${c.status !== 'CLOSED' ? `<button class="btn btn-secondary" data-close-conversation="${esc(c.id)}">Cerrar</button>` : '-'}
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5">Sin conversaciones todavia.</td></tr>';

    tbody.querySelectorAll('[data-close-conversation]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/conversations/${btn.dataset.closeConversation}`, {
            method: 'PUT',
            body: JSON.stringify({ status: 'CLOSED' }),
          });
          loadConversations();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5">Error: ${esc(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------
// Cola de mensajes
// ---------------------------------------------------------------------
async function loadQueue() {
  const tbody = document.querySelector('#table-queue tbody');
  tbody.innerHTML = '<tr><td colspan="5">Cargando...</td></tr>';
  try {
    const items = await apiFetch('/api/queue?limit=100');
    // Badge ambar de la pestana Cola: mensajes aun pendientes de envio
    const pending = items.filter((q) => q.status === 'PENDING' || q.status === 'PROCESSING').length;
    const colaBadge = document.getElementById('cola-count-badge');
    if (colaBadge) {
      colaBadge.textContent = String(pending);
      colaBadge.hidden = pending === 0;
    }
    // Caja de cola del sidebar Pro Suite
    const sbNum = document.getElementById('sb-queue-num');
    if (sbNum) sbNum.textContent = String(pending);
    const sbFill = document.getElementById('sb-queue-fill');
    if (sbFill) sbFill.style.width = `${Math.min(100, Math.round((pending / 50) * 100))}%`;
    tbody.innerHTML = items
      .map(
        (q) => `<tr>
          <td>${esc(q.id)}</td>
          <td>${esc(q.phone)}</td>
          <td>${esc((q.message || '').slice(0, 60))}</td>
          <td>${esc(q.status)}</td>
          <td>${esc(q.attempts)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5">Cola vacia.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5">Error: ${esc(err.message)}</td></tr>`;
  }
}

document.querySelectorAll('[data-queue]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await apiFetch(`/api/queue/${btn.dataset.queue}`, { method: 'POST' });
      loadQueue();
    } catch (err) {
      alert(err.message);
    }
  });
});

// ---------------------------------------------------------------------
// Mensajes programados
// ---------------------------------------------------------------------
async function loadScheduled() {
  const tbody = document.querySelector('#table-scheduled tbody');
  tbody.innerHTML = '<tr><td colspan="5">Cargando...</td></tr>';
  try {
    const items = await apiFetch('/api/scheduled-messages?limit=100');
    tbody.innerHTML = items
      .map(
        (s) => `<tr>
          <td>${esc(s.id)}</td>
          <td>${esc(s.phone)}</td>
          <td>${esc((s.message || '').slice(0, 60))}</td>
          <td>${esc(fmtDate(s.scheduled_at))}</td>
          <td>${esc(s.status)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5">Sin mensajes programados.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5">Error: ${esc(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------
// Reservas y citas (confirmadas por el bot)
// ---------------------------------------------------------------------
const reservationsState = { items: [], canceling: new Set() };

async function loadReservations() {
  const tbody = document.querySelector('#table-reservations tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6">Cargando...</td></tr>';
  try {
    const items = await apiFetch('/api/reservations?limit=100');
    reservationsState.items = items;
    tbody.innerHTML =
      items
        .map((r) => {
          const when = r.date_text && r.time_text ? `${r.date_text} · ${r.time_text}` : fmtDate(r.start_at);
          const badge =
            r.status === 'CONFIRMED'
              ? '<span class="badge-inline" style="background:#10b981">Confirmada</span>'
              : '<span class="badge-inline" style="background:#64748b">Cancelada</span>';
          const name = esc(r.customer_name || '—');
          const btn =
            r.status === 'CONFIRMED'
              ? `<button type="button" class="btn btn-secondary" data-res-cancel="${r.id}">✕ Cancelar</button>`
              : '';
          return `<tr>
            <td>${esc(r.id)}</td>
            <td>${name}</td>
            <td>${esc(r.phone || '—')}</td>
            <td>${esc(r.start_at ? when : '—')}</td>
            <td>${badge}</td>
            <td>${btn}</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="6">SIN reservas confirmadas todavia.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">Error: ${esc(err.message)}</td></tr>`;
  }
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-res-cancel]');
  if (!btn) return;
  const id = btn.dataset.resCancel;
  if (!window.confirm(`¿Cancelar la reserva N° ${id}? El cliente no recibirá aviso (tenlo a mano por WhatsApp).`)) return;
  btn.disabled = true;
  try {
    await apiFetch(`/api/reservations/${id}/cancel`, { method: 'POST' });
    await loadReservations();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

if (document.getElementById('btn-res-reload')) {
  document.getElementById('btn-res-reload').addEventListener('click', loadReservations);
}

// ---------------------------------------------------------------------
// Logs / errores
// ---------------------------------------------------------------------
async function loadLogs() {
  const tbody = document.querySelector('#table-logs tbody');
  tbody.innerHTML = '<tr><td colspan="4">Cargando...</td></tr>';
  try {
    const logs = await apiFetch('/api/dashboard/logs?limit=100');
    tbody.innerHTML = logs
      .map(
        (l) => `<tr>
          <td>${esc(fmtDate(l.created_at))}</td>
          <td><span class="badge-inline" style="background:${l.level === 'ERROR' ? '#ef4444' : l.level === 'WARN' ? '#f59e0b' : '#334155'}">${esc(l.level)}</span></td>
          <td>${esc(l.event_type)}</td>
          <td>${esc(l.message)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="4">Sin registros todavia.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4">Error: ${esc(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Chat en vivo (modulo avanzado)
// 3 columnas: conversaciones | chat | panel del asistente. Polling
// incremental (since_id): sin WebSockets (Vercel serverless no los
// soporta) pero sin duplicados ni recargar el historial.
// ---------------------------------------------------------------------
const chatState = {
  conversationId: null,
  conversations: [],
  sinceId: 0, // ultimo mensaje ya pintado: el poll solo pide id > sinceId
  tick: 0,
  filter: '',
  unread: {}, // {conversationId: noLeidos} (lo detecta el poll de la lista)
  lastSeenAt: {}, // ultima actividad vista por conversacion
  sending: false,
};

// URL del archivo (almacenado en BD o CDN) para <img>/<audio>: no pueden
// mandar cabeceras, por eso el token va en la query. download=1 fuerza
// la descarga en lugar de mostrarlo inline. MEDIA_VER invalida la cache
// HTTP del navegador: si alguna vez se sirvieron bytes corruptos, la URL
// nueva fuerza una descarga fresca (solo subir MEDIA_VER para refrescar).
const MEDIA_VER = 2;
function chatMediaUrl(m, download = false) {
  return `${API_BASE}/api/messages/${m.id}/media?token=${encodeURIComponent(getAuthToken())}&v=${MEDIA_VER}${download ? '&download=1' : ''}`;
}

function chatBubbleParts(m) {
  let texto = String(m.content || '');
  let etiqueta = null;
  // Las transcripciones/descripciones llegan como "[La persona envio ...]: texto"
  const match = texto.match(/^\[([^\]]+)\]:?\s*/);
  if (match) {
    etiqueta = match[1];
    texto = texto.slice(match[0].length);
  }
  const tipoLabel = {
    AUDIO: '🎙️ Nota de voz',
    IMAGE: '🖼️ Imagen',
    STICKER: '🔧 Sticker',
    VIDEO: '🎬 Video',
    DOCUMENT: '📄 Documento',
    LOCATION: '📍 Ubicación',
  };
  const kind = m.media_kind || m.message_type;
  return { etiqueta, texto, tipo: tipoLabel[kind] || (m.media_url ? '📎 Archivo' : null), kind };
}

// Burbuja con multimedia inline: imagen (con zoom al clic), sticker pequeno
// sin fondo, audio con descarga alternativa, video y documento. Todo pasa
// por /media autenticado: nada queda expuesto.
function chatBubbleMedia(m, kind) {
  if (!m.media_url || !m.media_key) return '';
  if (kind === 'IMAGE' || kind === 'STICKER') {
    const cls = kind === 'STICKER' ? ' bubble-img sticker' : ' bubble-img';
    const zoom = kind === 'IMAGE' ? ' data-zoom="1"' : '';
    return `<div class="media-wrap"><span class="media-load" aria-hidden="true"></span><img class="${cls}" loading="lazy" src="${chatMediaUrl(m)}" alt="multimedia"${zoom} /></div>`;
  }
  if (kind === 'AUDIO') {
    return `<div class="bubble-audio-wrap"><audio controls preload="metadata" class="bubble-audio" src="${chatMediaUrl(m)}"></audio><a class="media-dl" href="${chatMediaUrl(m, true)}" download title="Descargar audio">&#11015;&#65039;</a></div>`;
  }
  if (kind === 'VIDEO') {
    return `<div class="media-wrap"><span class="media-load" aria-hidden="true"></span><video controls preload="metadata" class="bubble-video" src="${chatMediaUrl(m)}"></video></div>`;
  }
  if (kind === 'DOCUMENT') {
    const nombre = (m.media_meta && m.media_meta.fileName) || 'documento';
    return `<a class="bubble-file" href="${chatMediaUrl(m, true)}" download>&#128196; ${esc(nombre)}<span class="bubble-file-go">Descargar</span></a>`;
  }
  return '<div class="bubble-type">📎 Archivo (vista no disponible)</div>';
}

function chatBubbleHtml(m) {
  const { etiqueta, texto, tipo, kind } = chatBubbleParts(m);
  const side = m.direction === 'INBOUND' ? 'in' : 'out';
  const parts = [];
  const mediaHtml = chatBubbleMedia(m, kind);
  if (mediaHtml) parts.push(mediaHtml);
  if (tipo && kind !== 'IMAGE' && kind !== 'STICKER' && kind !== 'AUDIO' && kind !== 'DOCUMENT') {
    parts.push(`<div class="bubble-type">${esc(tipo)}</div>`);
  } else if (etiqueta) {
    parts.push(`<div class="bubble-type">${esc(etiqueta)}</div>`);
  }
  if (texto) parts.push(`<div class="bubble-text">${esc(texto).replace(/\n/g, '<br>')}</div>`);
  return `<div class="chat-row ${side}" data-msg="${esc(m.id)}">
    <div class="bubble">
      ${parts.join('')}
      <div class="bubble-meta">${esc(fmtDate(m.created_at))}
        <button class="bubble-del" data-del-msg="${esc(m.id)}" title="Borrar mensaje">🗑️</button>
      </div>
    </div>
  </div>`;
}

function chatNombre(c) {
  return c.customer_name || c.customer_phone || `Cliente ${c.customer_id}`;
}

function updateUnreadBadge() {
  const badge = document.getElementById('chat-unread-badge');
  if (!badge) return;
  const total = Object.values(chatState.unread).reduce((a, b) => a + b, 0);
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

async function loadChatList() {
  const listEl = document.getElementById('chat-list');
  if (!listEl) return;
  try {
    const conversations = await apiFetch('/api/conversations?view=chat&limit=50');
    chatState.conversations = conversations || [];
    const filtro = chatState.filter.trim().toLowerCase();
    const visibles = chatState.conversations.filter((c) => {
      if (!filtro) return true;
      const nombre = String(chatNombre(c)).toLowerCase();
      const prev = String(c.last_message_preview || '').toLowerCase();
      return nombre.includes(filtro) || prev.includes(filtro);
    });
    listEl.innerHTML =
      visibles
        .map((c) => {
          const nombre = chatNombre(c);
          const prev = String(c.last_message_preview || '')
            .replace(/^\[[^\]]+\]:?\s*/, '')
            .slice(0, 42);
          const activa = c.id === chatState.conversationId ? ' active' : '';
          const unread = chatState.unread[c.id] || 0;
          const modo = c.status === 'HUMAN' ? '🙋' : c.status === 'CLOSED' ? '✔️' : '';
          const stageEmoji = { NUEVO: '🆕', NEGOCIANDO: '🤝', CERRADO: '🏆' }[c.customer_funnel_stage] || '';
          const pin = c.pinned ? '<span class="chat-item-pin" title="Anclada">📌</span>' : '';
          const hora = c.last_message_at ? String(c.last_message_at).slice(11, 16) : '';
          return `<div class="chat-item${activa}" data-chat="${esc(c.id)}">
            <div class="chat-item-top"><span class="chat-item-name">${pin}${esc(nombre)}</span><span class="chat-item-hora">${esc(hora)}</span></div>
            <div class="chat-item-bottom"><span class="chat-item-preview">${esc(stageEmoji)} ${esc(prev || 'Sin mensajes')}</span>${unread > 0 ? `<span class="chat-unread">${unread > 9 ? '9+' : unread}</span>` : ''}<span class="chat-item-modo">${modo}</span></div>
          </div>`;
        })
        .join('') || `<p class="chat-empty">${filtro ? 'Sin resultados.' : 'Sin conversaciones todavía.'}</p>`;
    listEl.querySelectorAll('[data-chat]').forEach((el) => {
      el.addEventListener('click', () => openChat(Number(el.dataset.chat)));
    });
    // Detectar actividad nueva en conversaciones NO abiertas: si la hora del
    // ultimo mensaje cambio respecto a lo ya visto, suma al no-leido.
    for (const c of chatState.conversations) {
      const last = c.last_message_at || '';
      const seen = chatState.lastSeenAt[c.id];
      if (chatState.conversationId === c.id) {
        chatState.lastSeenAt[c.id] = last;
        continue;
      }
      if (seen && last && last !== seen) {
        chatState.unread[c.id] = (chatState.unread[c.id] || 0) + 1;
      }
      if (last) chatState.lastSeenAt[c.id] = last;
    }
    updateUnreadBadge();
    syncChatMode();
  } catch (err) {
    listEl.innerHTML = `<p class="chat-empty">Error: ${esc(err.message)}</p>`;
  }
}

// Refleja el modo (estado) de la conversacion abierta en el selector.
function syncChatMode() {
  const sel = document.getElementById('chat-mode');
  if (!sel) return;
  const conv = chatState.conversations.find((c) => c.id === chatState.conversationId);
  sel.value = conv && conv.status ? conv.status : 'OPEN';
}

async function openChat(conversationId) {
  chatState.conversationId = conversationId;
  chatState.sinceId = 0; // recarga completa del historial
  delete chatState.unread[conversationId];
  updateUnreadBadge();
  loadChatList();
  const conv = chatState.conversations.find((c) => c.id === conversationId);
  document.getElementById('chat-header').textContent = conv
    ? chatNombre(conv)
    : `Conversación ${conversationId}`;
  const sub = document.getElementById('chat-sub');
  sub.textContent = conv && conv.customer_phone ? `📱 ${conv.customer_phone}` : '';
  syncChatMode();
  syncChatExtras();
  await refreshChatMessages();
}

async function refreshChatMessages() {
  if (!chatState.conversationId) return;
  const container = document.getElementById('chat-messages');
  if (!container) return;
  try {
    // Polling incremental: con since_id solo llegan los mensajes nuevos
    // (recupera lo perdido tras una desconexion consultando el historial
    // persistido, y la dedup por id evita repetidos).
    const url =
      chatState.sinceId > 0
        ? `/api/messages?conversation_id=${chatState.conversationId}&since_id=${chatState.sinceId}&limit=100`
        : `/api/messages?conversation_id=${chatState.conversationId}&limit=200`;
    const fresh = await apiFetch(url);
    const messages = fresh || [];
    if (!messages.length) return;
    if (chatState.sinceId === 0) {
      container.innerHTML = messages.map(chatBubbleHtml).join('') || '<p class="chat-empty">Sin mensajes.</p>';
      bindBubbleActions(container);
      container.scrollTop = container.scrollHeight;
    } else {
      const yaVistos = new Set(
        Array.from(container.querySelectorAll('[data-msg]')).map((el) => Number(el.dataset.msg))
      );
      const nuevos = messages.filter((m) => !yaVistos.has(m.id));
      if (!nuevos.length) return;
      const cercaDelFinal = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
      container.insertAdjacentHTML('beforeend', nuevos.map(chatBubbleHtml).join(''));
      bindBubbleActions(container);
      if (cercaDelFinal) container.scrollTop = container.scrollHeight;
    }
    chatState.sinceId = messages[messages.length - 1].id;
  } catch (err) {
    // Error de red momentaneo: el proximo tick reintenta (la BD es la fuente
    // de verdad, no se pierde nada).
    console.warn('chat refresh:', err.message);
  }
}

// Ampliacion de imagenes del chat: overlay unico, se cierra con clic o ESC.
function ensureMediaLightbox() {
  let box = document.getElementById('media-lightbox');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'media-lightbox';
  box.hidden = true;
  box.innerHTML = '<img alt="vista ampliada" />';
  box.addEventListener('click', () => {
    box.hidden = true;
    box.querySelector('img').src = '';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') box.hidden = true;
  });
  document.body.appendChild(box);
  return box;
}

function openMediaLightbox(src) {
  const box = ensureMediaLightbox();
  box.querySelector('img').src = src;
  box.hidden = false;
}

function bindBubbleActions(container) {
  container.querySelectorAll('[data-del-msg]').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => deleteMessage(Number(btn.dataset.delMsg)));
  });
  // Multimedia: indicador de carga, fallo claro con descarga alternativa y
  // ampliacion de imagenes. load/error no burbujean: se engancha directo.
  container.querySelectorAll('.media-wrap, .bubble-audio-wrap').forEach((wrap) => {
    if (wrap.dataset.mediaBound) return;
    wrap.dataset.mediaBound = '1';
    const row = wrap.closest('[data-msg]');
    const msgId = row ? Number(row.dataset.msg) : null;
    const el = wrap.querySelector('img, video, audio');
    if (!el) return;
    const done = () => wrap.classList.add('loaded');
    if (el.tagName === 'IMG' && el.complete) done();
    el.addEventListener('load', done);
    el.addEventListener('error', () => {
      // Primer error: reintentar una vez con cache-bust (por si el navegador
      // retuvo bytes corruptos o la red fallo). Solo si sigue fallando se
      // muestra "Archivo no disponible".
      if (!el.dataset.mediaRetried) {
        el.dataset.mediaRetried = '1';
        el.src = `${el.src}${el.src.includes('?') ? '&' : '?'}retry=${Date.now()}`;
        return;
      }
      wrap.classList.add('loaded');
      const dl = document.createElement('a');
      dl.className = 'media-dl media-dl-fail';
      if (msgId) {
        dl.href = `${API_BASE}/api/messages/${msgId}/media?token=${encodeURIComponent(getAuthToken())}&v=${MEDIA_VER}&download=1`;
        dl.download = '';
      }
      dl.textContent = 'Archivo no disponible';
      if (msgId) {
        const retry = document.createElement('a');
        retry.className = 'media-dl';
        retry.href = dl.href;
        retry.download = '';
        retry.textContent = 'Descargar';
        wrap.replaceChildren(dl, document.createTextNode(' '), retry);
      } else {
        wrap.replaceChildren(dl);
      }
    });
  });
  container.querySelectorAll('[data-zoom]').forEach((img) => {
    if (img.dataset.zoomBound) return;
    img.dataset.zoomBound = '1';
    img.addEventListener('click', () => openMediaLightbox(img.src));
  });
}

async function sendPanelMessage(text) {
  if (!chatState.conversationId || chatState.sending) return;
  chatState.sending = true;
  const input = document.getElementById('chat-input');
  const btn = document.querySelector('#chat-form button');
  input.disabled = true;
  if (btn) btn.disabled = true;
  try {
    const message = await apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: chatState.conversationId, text }),
    });
    input.value = '';
    dismissChatAi();
    // El mensaje ya esta en WhatsApp: lo agrego al chat sin esperar al poll.
    const container = document.getElementById('chat-messages');
    const yaVisto = Array.from(container.querySelectorAll('[data-msg]')).some(
      (el) => Number(el.dataset.msg) === message.id
    );
    if (!yaVisto && message && message.id) {
      container.insertAdjacentHTML('beforeend', chatBubbleHtml(message));
      bindBubbleActions(container);
      container.scrollTop = container.scrollHeight;
      if (message.id > chatState.sinceId) chatState.sinceId = message.id;
    }
    loadChatList();
  } catch (err) {
    alert(`No se pudo enviar: ${err.message}`);
  } finally {
    chatState.sending = false;
    input.disabled = false;
    if (btn) btn.disabled = false;
    input.focus();
  }
}

// Respuesta SUGERIDA por la IA: se muestra en una caja aparte con
// Enviar/Descartar. Queda claro que es una propuesta, no un mensaje enviado.
function dismissChatAi() {
  const box = document.getElementById('chat-ai');
  if (box) box.hidden = true;
}

async function requestSuggestion() {
  if (!chatState.conversationId) return;
  const box = document.getElementById('chat-ai');
  box.hidden = false;
  box.innerHTML = '<p class="chat-empty">✨ Generando sugerencia...</p>';
  try {
    const r = await apiFetch(`/api/messages/suggestions?conversation_id=${chatState.conversationId}`);
    if (r.suggestion) {
      box.innerHTML = `<div class="chat-ai-label">✨ Respuesta sugerida (propuesta, no enviada)</div>
        <div class="chat-ai-text">${esc(r.suggestion)}</div>
        <div class="btn-row">
          <button class="btn" data-ai="send">Enviar</button>
          <button class="btn btn-secondary" data-ai="discard">Descartar</button>
        </div>`;
      box.querySelector('[data-ai="send"]').addEventListener('click', () => {
        document.getElementById('chat-input').value = r.suggestion;
        dismissChatAi();
        document.getElementById('chat-input').focus();
      });
      box.querySelector('[data-ai="discard"]').addEventListener('click', dismissChatAi);
    } else {
      box.innerHTML = `<p class="chat-empty">✨ ${esc(r.reason || 'No hay sugerencia disponible, intenta de nuevo.')}</p>`;
    }
  } catch (err) {
    box.innerHTML = `<p class="chat-empty">Error: ${esc(err.message)}</p>`;
  }
}

async function requestSummary() {
  if (!chatState.conversationId) return;
  const body = document.getElementById('chat-context-body');
  body.innerHTML = '<p class="chat-empty">📄 Resumiendo la conversacion...</p>';
  try {
    const r = await apiFetch(`/api/messages/summary?conversation_id=${chatState.conversationId}`);
    body.innerHTML = r.summary
      ? `<div class="chat-ctx-block"><strong>📄 Resumen</strong><p>${esc(r.summary)}</p></div>`
      : `<p class="chat-empty">📄 ${esc(r.reason || 'No hay resumen disponible, intenta de nuevo.')}</p>`;
  } catch (err) {
    body.innerHTML = `<p class="chat-empty">Error: ${esc(err.message)}</p>`;
  }
}

// Modo de atencion por conversacion (Seccion 6): HUMAN pausa las respuestas
// automaticas de esa conversacion y el operador toma el control.
async function changeChatMode(status) {
  if (!chatState.conversationId) return;
  try {
    await apiFetch(`/api/conversations/${chatState.conversationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const conv = chatState.conversations.find((c) => c.id === chatState.conversationId);
    if (conv) conv.status = status;
    loadChatList();
  } catch (err) {
    alert(`No se pudo cambiar el modo: ${err.message}`);
    syncChatMode();
  }
}

async function deleteMessage(id) {
  if (
    !window.confirm(
      '¿Borrar este mensaje del panel? Si fue enviado por el bot, también se intentará borrar en WhatsApp para todos.'
    )
  )
    return;
  try {
    const r = await apiFetch(`/api/messages/${id}`, { method: 'DELETE' });
    if (r.deletedFromPanel && r.whatsappRevoked) {
      alert('Borrado del panel y de WhatsApp ✅');
    } else if (r.deletedFromPanel) {
      alert(
        'Borrado del panel ✅\n\nNota: en WhatsApp no se pudo borrar porque la versión actual de Evolution API todavía no trae la ruta de borrado (delete for everyone). Quedará funcionando automáticamente en cuanto se actualice el servidor.'
      );
    }
    chatState.sinceId = 0; // recarga completa: el mensaje ya no existe
    await refreshChatMessages();
    loadChatList();
  } catch (err) {
    alert(err.message);
  }
}

// Eventos del chat (una sola vez: los elementos son fijos, no se re-crean).
(function initChatEvents() {
  const search = document.getElementById('chat-search');
  if (search) {
    search.addEventListener('input', () => {
      chatState.filter = search.value;
      loadChatList();
    });
  }
  const form = document.getElementById('chat-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = document.getElementById('chat-input').value.trim();
      if (text) sendPanelMessage(text);
    });
  }
  const mode = document.getElementById('chat-mode');
  if (mode) mode.addEventListener('change', () => changeChatMode(mode.value));
  const stage = document.getElementById('chat-stage');
  if (stage) {
    stage.addEventListener('change', () => {
      const conv = chatState.conversations.find((c) => c.id === chatState.conversationId);
      if (conv) setCustomerStage(conv.customer_id, stage.value);
    });
  }
  const btnPin = document.getElementById('btn-pin');
  if (btnPin) btnPin.addEventListener('click', togglePin);
  const btnSuggest = document.getElementById('btn-suggest');
  if (btnSuggest) btnSuggest.addEventListener('click', requestSuggestion);
  const btnSummary = document.getElementById('btn-summary');
  if (btnSummary) btnSummary.addEventListener('click', requestSummary);
})();

// Cargar el chat al abrir la pestaña, y refrescarlo mientras esté visible.
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'tab-chat') {
      loadChatList();
      loadQuickReplies();
    }
    if (btn.dataset.tab === 'tab-reservations') loadReservations();
  });
});

setInterval(() => {
  const tab = document.getElementById('tab-chat');
  if (!tab || tab.classList.contains('hidden')) return;
  chatState.tick += 1;
  if (chatState.tick % 3 === 1) loadChatList();
  refreshChatMessages();
  // Estado de conexion de WhatsApp reflejado en la barra del chat.
  const wa = document.getElementById('status-whatsapp');
  const conn = document.getElementById('chat-conn');
  if (wa && conn) {
    conn.textContent = `● ${wa.textContent || '?'}`;
    conn.className = `chat-conn ${/conectado/i.test(wa.textContent || '') ? 'ok' : 'warn'}`;
  }
}, 5000);

// ---------------------------------------------------------------------
// Suite de ventas (inspirado en los CRM tipo Kanban, hecho en el panel
// propio): embudo de etapas, tarjeta CRM del chat (notas + pausa de IA +
// seguimientos), respuestas rapidas en 1 clic y conversaciones ancladas.
// ---------------------------------------------------------------------
const FUNNEL_STAGES = ['NUEVO', 'NEGOCIANDO', 'CERRADO'];
const STAGE_LABEL = { NUEVO: '🆕 Nuevo', NEGOCIANDO: '🤝 Negociando', CERRADO: '🏆 Cerrado' };

// Cambia la etapa de un cliente (desde la tabla, la tarjeta o el embudo).
async function setCustomerStage(customerId, stage) {
  if (!FUNNEL_STAGES.includes(stage)) return;
  try {
    await apiFetch(`/api/customers/${customerId}`, {
      method: 'PUT',
      body: JSON.stringify({ funnel_stage: stage }),
    });
    const conv = chatState.conversations.find((c) => c.customer_id === customerId);
    if (conv) conv.customer_funnel_stage = stage;
    syncChatExtras();
    renderFunnelBoardFromCache();
  } catch (err) {
    alert(`No se pudo cambiar la etapa: ${err.message}`);
    loadCustomers();
  }
}

// Tabla con etapas por cliente (fuente: la ultima carga de contactos).
const funnelCache = { customers: [] };

async function setCustomerStageAndReload(customerId, stage) {
  await setCustomerStage(customerId, stage);
  const c = funnelCache.customers.find((x) => x.id === customerId);
  if (c) c.funnel_stage = stage;
  renderFunnelBoard(funnelCache.customers);
}

function renderFunnelBoard(customers) {
  funnelCache.customers = customers || funnelCache.customers;
  renderFunnelBoardFromCache();
}

function renderFunnelBoardFromCache() {
  const board = document.getElementById('funnel-board');
  if (!board) return;
  const cols = FUNNEL_STAGES.map((stage) => {
    const list = funnelCache.customers.filter((c) => (c.funnel_stage || 'NUEVO') === stage);
    const cards = list
      .map(
        (c) => `<div class="funnel-card">
          <div class="funnel-card-name">${esc(c.name || c.phone)}</div>
          <div class="funnel-card-sub mono">${esc(c.phone)}</div>
          <select class="stage-mini" data-funnel-move="${esc(c.id)}" title="Cambiar etapa">
            ${FUNNEL_STAGES.map((s) => `<option value="${s}"${(c.funnel_stage || 'NUEVO') === s ? ' selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}
          </select>
        </div>`
      )
      .join('');
    return `<div class="funnel-col funnel-col-${stage.toLowerCase()}">
      <div class="funnel-col-head"><span>${STAGE_LABEL[stage]}</span><span class="funnel-count mono">${list.length}</span></div>
      <div class="funnel-col-body">${cards || '<p class="chat-empty">—</p>'}</div>
    </div>`;
  });
  board.innerHTML = `<div class="funnel-grid">${cols.join('')}</div>`;
  board.querySelectorAll('[data-funnel-move]').forEach((sel) => {
    sel.addEventListener('change', () => {
      setCustomerStageAndReload(Number(sel.dataset.funnelMove), sel.value);
    });
  });
}

// Toast liviano del embudo (usa el toast global de pro.js si existe).
function toastFunnel(msg) {
  const t = document.getElementById('toast');
  if (!t || t.classList.contains('hidden')) return;
  t.textContent = msg;
}

// ---------------------------------------------------------------------
// Tarjeta CRM del chat: etapa, pausa de IA, notas y seguimientos del
// cliente de la conversacion abierta. Vive en la columna del asistente.
// ---------------------------------------------------------------------
let crmCustomerId = null;

function syncChatExtras() {
  const conv = chatState.conversations.find((c) => c.id === chatState.conversationId);
  const stageSel = document.getElementById('chat-stage');
  const btnPin = document.getElementById('btn-pin');
  if (stageSel) {
    stageSel.disabled = !conv;
    stageSel.value = (conv && conv.customer_funnel_stage) || 'NUEVO';
  }
  if (btnPin) {
    btnPin.disabled = !conv;
    btnPin.textContent = conv && conv.pinned ? '📍' : '📌';
    btnPin.title = conv && conv.pinned ? 'Quitar anclaje' : 'Anclar arriba en la bandeja';
  }
  renderCrmCard(conv);
}

function crmDefaultWhen() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCrmCard(conv) {
  const card = document.getElementById('chat-crm-card');
  if (!card) return;
  if (!conv) {
    crmCustomerId = null;
    card.innerHTML = '<p class="chat-empty">Elige una conversacion.</p>';
    return;
  }
  crmCustomerId = conv.customer_id;
  const paused = conv.customer_ai_paused === true;
  card.innerHTML = `
    <div class="crm-title">👤 CRM del cliente</div>
    <label class="crm-label">Etapa</label>
    <select id="crm-stage" class="stage-mini">
      ${FUNNEL_STAGES.map((s) => `<option value="${s}"${(conv.customer_funnel_stage || 'NUEVO') === s ? ' selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}
    </select>
    <label class="crm-check"><input type="checkbox" id="crm-ai-paused"${paused ? ' checked' : ''} /> Pausar IA para este cliente (atención 100% humana)</label>
    <label class="crm-label">Notas</label>
    <textarea id="crm-notes" rows="3" maxlength="4000" placeholder="Notas del cliente (lo que pide, presupuesto...)">${esc(conv.customer_notes || '')}</textarea>
    <button id="crm-notes-save" class="btn btn-secondary crm-btn">💾 Guardar notas</button>
    <div class="crm-sep"></div>
    <label class="crm-label">⏰ Seguimiento</label>
    <input type="datetime-local" id="crm-fu-when" value="${crmDefaultWhen()}" />
    <input type="text" id="crm-fu-note" placeholder="ej. Llamarle a las 10am" maxlength="200" />
    <button id="crm-fu-add" class="btn btn-primary crm-btn">＋ Crear recordatorio</button>
    <div id="crm-fu-list"><p class="chat-empty">Cargando seguimientos...</p></div>`;

  card.querySelector('#crm-stage').addEventListener('change', (e) => {
    setCustomerStage(crmCustomerId, e.target.value);
  });
  card.querySelector('#crm-ai-paused').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await apiFetch(`/api/customers/${crmCustomerId}`, {
        method: 'PUT',
        body: JSON.stringify({ ai_paused: on }),
      });
      conv.customer_ai_paused = on;
      loadChatList();
    } catch (err) {
      alert(err.message);
      e.target.checked = !on;
    }
  });
  card.querySelector('#crm-notes-save').addEventListener('click', async () => {
    const val = card.querySelector('#crm-notes').value;
    try {
      await apiFetch(`/api/customers/${crmCustomerId}`, {
        method: 'PUT',
        body: JSON.stringify({ notes: val }),
      });
      conv.customer_notes = val;
      loadChatList();
    } catch (err) {
      alert(`No se pudieron guardar las notas: ${err.message}`);
    }
  });
  card.querySelector('#crm-fu-add').addEventListener('click', async () => {
    const when = card.querySelector('#crm-fu-when').value;
    const note = card.querySelector('#crm-fu-note').value.trim();
    if (!when) return alert('Elige fecha y hora del recordatorio');
    try {
      await apiFetch('/api/follow-ups', {
        method: 'POST',
        body: JSON.stringify({
          customerId: crmCustomerId,
          conversationId: conv.id,
          remindAt: when,
          note: note || null,
        }),
      });
      card.querySelector('#crm-fu-note').value = '';
      loadFollowUps(crmCustomerId);
    } catch (err) {
      alert(`No se pudo crear el seguimiento: ${err.message}`);
    }
  });
  loadFollowUps(crmCustomerId);
}

async function loadFollowUps(customerId) {
  const listEl = document.getElementById('crm-fu-list');
  if (!listEl || crmCustomerId !== customerId) return;
  try {
    const items = await apiFetch(`/api/follow-ups?customer_id=${customerId}`);
    const pend = (items || []).filter((f) => !f.done);
    if (!pend.length) {
      listEl.innerHTML = '<p class="chat-empty">Sin seguimientos pendientes.</p>';
      return;
    }
    const vencido = (f) => new Date(f.remind_at).getTime() < Date.now();
    listEl.innerHTML = pend
      .map(
        (f) => `<div class="crm-fu${vencido(f) ? ' overdue' : ''}">
          <div class="crm-fu-text"><strong class="mono">${esc(fmtDate(f.remind_at))}</strong>${vencido(f) ? ' <span class="crm-fu-flag">vencido</span>' : ''}${f.note ? `<span>${esc(f.note)}</span>` : ''}</div>
          <div class="crm-fu-actions">
            <button class="crm-fu-btn" data-fu-done="${esc(f.id)}" title="Marcar hecho">✔️</button>
            <button class="crm-fu-btn" data-fu-del="${esc(f.id)}" title="Eliminar">🗑️</button>
          </div>
        </div>`
      )
      .join('');
    listEl.querySelectorAll('[data-fu-done]').forEach((b) =>
      b.addEventListener('click', async () => {
        await apiFetch(`/api/follow-ups/${b.dataset.fuDone}/done`, { method: 'PATCH' });
        loadFollowUps(customerId);
      })
    );
    listEl.querySelectorAll('[data-fu-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        await apiFetch(`/api/follow-ups/${b.dataset.fuDel}`, { method: 'DELETE' });
        loadFollowUps(customerId);
      })
    );
  } catch (err) {
    listEl.innerHTML = `<p class="chat-empty">Error: ${esc(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------
// Respuestas rapidas en 1 clic (usa las plantillas existentes). Chip ->
// inserta el texto en el input con {{nombre}} ya reemplazado; el dueño
// revisa y envia. Nada se envia solo.
// ---------------------------------------------------------------------
let quickRepliesLoaded = false;

async function loadQuickReplies() {
  const bar = document.getElementById('quick-replies');
  if (!bar || quickRepliesLoaded) return;
  try {
    const templates = await apiFetch('/api/templates');
    const usable = (templates || []).filter((t) => t.body && String(t.body).trim());
    if (!usable.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = usable
      .slice(0, 12)
      .map(
        (t, i) =>
          `<button type="button" class="qr-chip" data-qr="${i}" title="${esc(t.body)}">${esc(t.title || t.name)}</button>`
      )
      .join('');
    bar.dataset.bodies = JSON.stringify(usable.slice(0, 12).map((t) => t.body));
    bar.querySelectorAll('[data-qr]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const bodies = JSON.parse(bar.dataset.bodies || '[]');
        const raw = bodies[Number(chip.dataset.qr)] || '';
        const conv = chatState.conversations.find((c) => c.id === chatState.conversationId);
        const nombre = String((conv && conv.customer_name) || '').split(/\s+/)[0] || '';
        const input = document.getElementById('chat-input');
        input.value = raw.replace(/\{\{\s*nombre\s*\}\}/gi, nombre);
        input.focus();
      });
    });
    quickRepliesLoaded = true;
  } catch (err) {
    bar.hidden = true;
  }
}

// ---------------------------------------------------------------------
// Anclar / desanclar la conversacion abierta (queda primera en bandeja).
// ---------------------------------------------------------------------
async function togglePin() {
  const conv = chatState.conversations.find((c) => c.id === chatState.conversationId);
  if (!conv) return;
  try {
    await apiFetch(`/api/conversations/${conv.id}`, {
      method: 'PUT',
      body: JSON.stringify({ pinned: !conv.pinned }),
    });
    conv.pinned = !conv.pinned;
    loadChatList();
    syncChatExtras();
  } catch (err) {
    alert(`No se pudo anclar: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Catalogo de productos (pestaña Catálogo): CRUD real contra la tabla
// `products`, la misma que la IA consulta para responder precios/stock.
// ---------------------------------------------------------------------
const productsState = { items: [], editingId: null, filter: '' };

async function loadProducts() {
  const tbody = document.querySelector('#table-products tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6">Cargando...</td></tr>';
  try {
    productsState.items = (await apiFetch('/api/products')) || [];
    renderProducts();
    const badge = document.getElementById('products-count-badge');
    if (badge) {
      badge.textContent = String(productsState.items.length);
      badge.hidden = productsState.items.length === 0;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">Error: ${esc(err.message)}</td></tr>`;
  }
}

function renderProducts() {
  const tbody = document.querySelector('#table-products tbody');
  if (!tbody) return;
  const filtro = productsState.filter.trim().toLowerCase();
  const visibles = productsState.items.filter((p) => {
    if (!filtro) return true;
    return [p.name, p.price, p.stock, p.description]
      .some((v) => String(v || '').toLowerCase().includes(filtro));
  });
  tbody.innerHTML =
    visibles
      .map(
        (p) => `<tr>
          <td><strong>${esc(p.name)}</strong></td>
          <td class="mono">${esc(p.price || '—')}</td>
          <td class="mono">${esc(p.stock || '—')}</td>
          <td>${esc(String(p.description || '').slice(0, 80))}${String(p.description || '').length > 80 ? '…' : ''}</td>
          <td>${p.active
            ? '<span class="badge-inline" style="background:var(--emerald)">ACTIVO</span>'
            : '<span class="badge-inline" style="background:#64748b">PAUSADO</span>'}</td>
          <td>
            <div class="btn-row">
              <button class="btn btn-secondary" data-prod-edit="${esc(p.id)}">Editar</button>
              <button class="btn btn-danger" data-prod-del="${esc(p.id)}">Eliminar</button>
              <button class="btn btn-secondary" data-prod-toggle="${esc(p.id)}" title="${p.active ? 'Pausar: la IA deja de mencionarlo' : 'Activar: la IA vuelve a mencionarlo'}">${p.active ? '⏸️' : '▶️'}</button>
            </div>
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="6">Sin productos todavía. Agrega el primero con "＋ Nuevo producto".</td></tr>';

  tbody.querySelectorAll('[data-prod-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openProductModal(Number(btn.dataset.prodEdit)))
  );
  tbody.querySelectorAll('[data-prod-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!window.confirm('¿Eliminar este producto del catálogo?')) return;
      try {
        await apiFetch(`/api/products/${btn.dataset.prodDel}`, { method: 'DELETE' });
        loadProducts();
      } catch (err) {
        alert(err.message);
      }
    })
  );
  tbody.querySelectorAll('[data-prod-toggle]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const p = productsState.items.find((x) => x.id === Number(btn.dataset.prodToggle));
      if (!p) return;
      try {
        await apiFetch(`/api/products/${p.id}`, {
          method: 'PUT',
          body: JSON.stringify({ active: !p.active }),
        });
        loadProducts();
      } catch (err) {
        alert(err.message);
      }
    })
  );
}

function openProductModal(id = null) {
  productsState.editingId = id;
  const p = id ? productsState.items.find((x) => x.id === id) : null;
  document.getElementById('prod-modal-title').textContent = p ? `✏️ Editar: ${p.name}` : '＋ Nuevo producto';
  document.getElementById('prod-name').value = p ? p.name || '' : '';
  document.getElementById('prod-price').value = p ? p.price || '' : '';
  document.getElementById('prod-stock').value = p ? p.stock || '' : '';
  document.getElementById('prod-desc').value = p ? p.description || '' : '';
  document.getElementById('prod-active').checked = p ? p.active === true : true;
  document.getElementById('modal-product').classList.remove('hidden');
  setTimeout(() => document.getElementById('prod-name').focus(), 50);
}

async function saveProduct() {
  const body = {
    name: document.getElementById('prod-name').value.trim(),
    price: document.getElementById('prod-price').value.trim(),
    stock: document.getElementById('prod-stock').value.trim(),
    description: document.getElementById('prod-desc').value.trim(),
    active: document.getElementById('prod-active').checked,
  };
  if (!body.name) return alert('El nombre del producto es obligatorio');
  const btn = document.getElementById('prod-save');
  btn.disabled = true;
  try {
    if (productsState.editingId) {
      await apiFetch(`/api/products/${productsState.editingId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch('/api/products', { method: 'POST', body: JSON.stringify(body) });
    }
    document.getElementById('modal-product').classList.add('hidden');
    loadProducts();
  } catch (err) {
    alert(`No se pudo guardar: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// Eventos del catalogo (elementos fijos, se enganchan una sola vez).
(function initProductsEvents() {
  const search = document.getElementById('prod-search');
  if (search) search.addEventListener('input', () => {
    productsState.filter = search.value;
    renderProducts();
  });
  const btnNew = document.getElementById('btn-prod-new');
  if (btnNew) btnNew.addEventListener('click', () => openProductModal(null));
  const btnReload = document.getElementById('btn-prod-reload');
  if (btnReload) btnReload.addEventListener('click', loadProducts);
  const btnSave = document.getElementById('prod-save');
  if (btnSave) btnSave.addEventListener('click', saveProduct);
})();

// ---------------------------------------------------------------------
// Orquestacion
// ---------------------------------------------------------------------
function refreshAll() {
  fetchHealth();
  fetchAutomationStatus();
  loadCustomers();
  loadConversations();
  loadQueue();
  loadScheduled();
  loadReservations();
  loadLogs();
  loadProducts();
}

if (getAuthToken()) {
  showApp();
} else {
  showLogin();
}

setInterval(() => {
  if (getAuthToken()) fetchHealth();
}, 10000);