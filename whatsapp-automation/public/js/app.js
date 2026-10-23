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
  try {
    const data = await apiFetch('/api/automation/status');
    document.getElementById('automation-status').textContent = data.status;
  } catch (err) {
    document.getElementById('automation-status').textContent = 'ERROR';
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
  tbody.innerHTML = '<tr><td colspan="6">Cargando...</td></tr>';
  try {
    const customers = await apiFetch('/api/customers?limit=100');
    tbody.innerHTML = customers
      .map(
        (c) => `<tr>
          <td>${esc(c.id)}</td>
          <td>${esc(c.phone)}</td>
          <td>${esc(c.name || '-')}</td>
          <td>${esc(c.status)}</td>
          <td>${esc(c.interest_type || '-')}</td>
          <td>${esc(fmtDate(c.last_message_at))}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="6">Sin clientes todavia.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">Error: ${esc(err.message)}</td></tr>`;
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
// Orquestacion
// ---------------------------------------------------------------------
function refreshAll() {
  fetchHealth();
  fetchAutomationStatus();
  loadCustomers();
  loadConversations();
  loadQueue();
  loadScheduled();
  loadLogs();
}

if (getAuthToken()) {
  showApp();
} else {
  showLogin();
}

setInterval(() => {
  if (getAuthToken()) fetchHealth();
}, 10000);