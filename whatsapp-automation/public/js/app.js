// =====================================================================
// Panel administrativo de WhatsApp Automation.
// Vanilla JS, sin build step. Todos los datos que llegan de la API se
// escapan con esc() antes de pintarse: el nombre de un cliente o el texto
// de un mensaje podrían inyectar HTML/JS (XSS almacenado).
// =====================================================================

'use strict';

// En desarrollo el panel se sirve en :8080 y la API en :3000.
const API_BASE = window.location.origin.includes(':8080')
  ? window.location.origin.replace(':8080', ':3000')
  : window.location.origin;

const TOKEN_KEY = 'wa_admin_token';
const THEME_KEY = 'wa_theme';
const PAGE_SIZE = 200;

const state = {
  user: null,
  health: null,
  automation: { status: null, pause_queue: false },
  customers: [],
  customersById: new Map(),
  conversations: [],
  queue: [],
  scheduled: [],
  messages: [],
  logs: [],
  response: { settings: null, stats: null, alerts: [], limits: null },
  responseJobs: [],
  responseHistory: [],
  loaded: {
    customers: false,
    conversations: false,
    queue: false,
    scheduled: false,
    messages: false,
    logs: false,
    response: false,
    responseJobs: false,
    responseHistory: false,
  },
  errors: {},
  filters: {
    customers: '',
    conversations: 'ALL',
    queue: 'ALL',
    scheduled: 'ALL',
    messages: { direction: 'ALL', q: '' },
    logs: { level: 'ALL', q: '' },
    responseJobs: 'ALL',
  },
  activeTab: 'tab-dashboard',
  modalConversationId: null,
  modalCustomerId: null,
  lastUpdatedAt: null,
  refreshing: false,
  waPollTimer: null,
  webhookEnsured: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const STATUS_TONES = {
  ACTIVE: 'up', BLOCKED: 'down', ARCHIVED: '',
  OPEN: 'up', PENDING: 'warn', HUMAN: 'info', CLOSED: '',
  SCHEDULED: 'info', QUEUED: 'warn', SENT: 'up', FAILED: 'down', CANCELLED: '',
  PROCESSING: 'info', PAUSED: 'warn', UNCERTAIN: 'warn', STOPPED: 'down',
  INBOUND: 'info', OUTBOUND: 'up',
  INFO: '', WARN: 'warn', ERROR: 'down',
};

function badgeFor(value) {
  const tone = STATUS_TONES[value] || '';
  return `<span class="pill ${tone ? `is-${tone}` : ''}">${esc(value || '—')}</span>`;
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
}

function relativeTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const diff = Date.now() - d.getTime();
  if (diff < 0) return fmtDate(value);
  if (diff < 60 * 1000) return 'hace un momento';
  if (diff < 60 * 60 * 1000) return `hace ${Math.floor(diff / 60000)} min`;
  if (diff < 24 * 60 * 60 * 1000) return `hace ${Math.floor(diff / 3600000)} h`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `hace ${Math.floor(diff / 86400000)} d`;
  return fmtDate(value);
}

function timeHtml(value) {
  if (!value) return '—';
  const d = new Date(value);
  const iso = Number.isNaN(d.getTime()) ? '' : d.toISOString();
  return `<time datetime="${esc(iso)}" title="${esc(fmtDate(value))}">${esc(relativeTime(value))}</time>`;
}

function customerLabel(customer) {
  if (!customer) return '—';
  return customer.name ? `${customer.name} · ${customer.phone}` : customer.phone;
}

function customerById(id) {
  return state.customersById.get(Number(id)) || null;
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------
// Fetch autenticado
// ---------------------------------------------------------------------
function getToken() {
  return localStorage.getItem(TOKEN_KEY) || null;
}

async function apiFetch(path, options = {}) {
  const { skipAuthRedirect = false, ...fetchOptions } = options;
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers });
  } catch (err) {
    throw new Error('No se pudo conectar con el servidor');
  }

  // Solo se cierra la sesión una vez: si otra petición en paralelo ya
  // borró el token, no se repite el aviso.
  if (res.status === 401 && !skipAuthRedirect) {
    if (getToken()) logout(true);
    throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
  }

  if (res.status === 204) return null;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && (body.error || (Array.isArray(body.errors) ? body.errors.join('. ') : null));
    throw new Error(detail || `Error ${res.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------
// Avisos (toasts)
// ---------------------------------------------------------------------
function toast(message, type = 'info', ttl = 4200) {
  const container = $('#toasts');
  if (!container) return;
  const node = document.createElement('div');
  node.className = `toast is-${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  node.appendChild(text);
  container.appendChild(node);

  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

// ---------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
}

// ---------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------
function renderUser() {
  const user = state.user;
  const name = user?.name || user?.email || 'Cuenta';
  $('#user-name').textContent = name;
  $('#user-email').textContent = user?.email || '—';
  $('#user-initials').textContent = String(name).trim().charAt(0).toUpperCase() || '?';
}

async function loadMe() {
  try {
    state.user = await apiFetch('/api/auth/me');
    renderUser();
    renderResponseControl();
  } catch (err) {
    // Un 401 ya cierra la sesión; otros errores no deben bloquear el panel.
    if (getToken()) toast(err.message, 'warn');
  }
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#login-error').classList.add('hidden');
  loadMe();
  refreshAll();
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  const email = $('#login-email');
  if (email) setTimeout(() => email.focus(), 50);
}

function logout(expired = false) {
  localStorage.removeItem(TOKEN_KEY);
  state.user = null;
  state.webhookEnsured = false;
  const password = $('#login-password');
  if (password) password.value = '';
  stopWaPolling();
  showLogin();
  if (expired) toast('La sesión terminó. Vuelve a entrar.', 'warn');
}

// ---------------------------------------------------------------------
// Estado del sistema
// ---------------------------------------------------------------------
function setService(service, tone, label, detail) {
  const dot = $(`#dot-${service}`);
  const pill = $(`#status-${service}`);
  const detailEl = $(`#detail-${service}`);
  if (dot) dot.className = `status-dot ${tone === 'up' ? 'up' : tone === 'warn' ? 'warn' : 'down'}`;
  if (pill) {
    pill.className = `pill is-${tone}`;
    pill.textContent = label;
  }
  if (detailEl) detailEl.textContent = detail;
}

const WHATSAPP_LABELS = {
  CONNECTED: 'CONECTADO',
  CONNECTING: 'CONECTANDO',
  DISCONNECTED: 'DESVINCULADO',
  ERROR: 'ERROR',
};

function updateWhatsappBadge(rawStatus, reason) {
  const status = rawStatus || 'ERROR';
  const tone = status === 'CONNECTED' ? 'up' : status === 'CONNECTING' ? 'warn' : 'down';
  const label = WHATSAPP_LABELS[status] || 'SIN ESTADO';
  let detail = reason || 'Evolution API no reporta una sesión activa';
  if (status === 'CONNECTED') detail = 'Sesión activa en Evolution API';
  else if (status === 'CONNECTING') detail = 'Esperando la vinculación del dispositivo';

  setService('whatsapp', tone, label, detail);
  const pill = $('#connection-pill');
  if (pill) {
    pill.className = `pill is-${tone}`;
    pill.textContent = label;
  }

  const disconnectBtn = $('#btn-disconnect');
  if (disconnectBtn) disconnectBtn.hidden = status !== 'CONNECTED';

  if (status === 'CONNECTED') ensureWebhookOnce();
}

function renderHealth(data) {
  const backendOk = data.backend === 'UP';
  const databaseOk = data.database === 'UP';

  setService(
    'backend',
    backendOk ? 'up' : 'down',
    backendOk ? 'EN LÍNEA' : 'CAÍDO',
    backendOk ? 'La API responde correctamente' : 'Sin respuesta de la API'
  );
  setService(
    'database',
    databaseOk ? 'up' : 'down',
    databaseOk ? 'EN LÍNEA' : 'CAÍDA',
    databaseOk ? 'PostgreSQL conectado' : 'No se pudo conectar a PostgreSQL'
  );
  updateWhatsappBadge(data.whatsapp, data.whatsapp_reason);

  const healthPill = $('#health-pill');
  if (healthPill) {
    if (!databaseOk) {
      healthPill.className = 'pill is-down';
      healthPill.textContent = 'Revisar base de datos';
    } else if (data.whatsapp !== 'CONNECTED') {
      healthPill.className = 'pill is-warn';
      healthPill.textContent = 'WhatsApp sin conectar';
    } else {
      healthPill.className = 'pill is-up';
      healthPill.textContent = 'Todo en orden';
    }
  }
}

async function fetchHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/dashboard/health`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('Respuesta no válida');
    state.health = data;
    renderHealth(data);
  } catch (err) {
    renderHealth({
      backend: 'DOWN',
      database: 'DOWN',
      whatsapp: 'ERROR',
      whatsapp_reason: err.message,
    });
  }
  touchUpdated();
}

// ---------------------------------------------------------------------
// Automatización
// ---------------------------------------------------------------------
const AUTOMATION_HINTS = {
  ACTIVE: 'Los mensajes se envían automáticamente respetando horario y límites.',
  PAUSED: 'No se agregan nuevos envíos ni se procesa la cola.',
  STOPPED: 'Todos los envíos automáticos están detenidos.',
};

function renderAutomation() {
  const status = state.automation?.status || null;
  const pill = $('#automation-status');
  if (pill) {
    const tone = status === 'ACTIVE' ? 'up' : status === 'PAUSED' ? 'warn' : status === 'STOPPED' ? 'down' : '';
    pill.className = `pill ${tone ? `is-${tone}` : ''}`;
    pill.textContent = status || '—';
  }

  const hint = $('#automation-hint');
  if (hint) {
    hint.textContent = (AUTOMATION_HINTS[status] || 'Consulta el estado del envío automático.')
      + (state.automation?.pause_queue ? ' La cola está pausada.' : '');
  }

  $$('[data-automation]').forEach((btn) => {
    const action = btn.dataset.automation;
    btn.disabled =
      (status === 'ACTIVE' && (action === 'activate' || action === 'resume')) ||
      (status === 'PAUSED' && action === 'pause') ||
      (status === 'STOPPED' && action === 'stop');
  });
}

async function fetchAutomationStatus() {
  try {
    state.automation = await apiFetch('/api/automation/status');
  } catch (err) {
    state.automation = { status: null, pause_queue: false };
  }
  renderAutomation();
}

async function runAutomationAction(action) {
  const labels = {
    activate: 'Automatización activada',
    pause: 'Automatización pausada',
    stop: 'Automatización detenida',
    resume: 'Automatización reanudada',
  };
  if (action === 'stop' && !window.confirm('¿Detener todos los envíos automáticos?')) return;

  try {
    await apiFetch(`/api/automation/${action}`, { method: 'POST' });
    toast(labels[action] || 'Estado actualizado', 'success');
    await fetchAutomationStatus();
    loadQueue();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Conexión de WhatsApp
// ---------------------------------------------------------------------
function setWaMessage(text, extraNode = null) {
  const container = $('#qr-container');
  if (!container) return;
  container.textContent = '';
  if (text) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    container.appendChild(p);
  }
  if (extraNode) container.appendChild(extraNode);
}

function stopWaPolling() {
  if (state.waPollTimer) clearInterval(state.waPollTimer);
  state.waPollTimer = null;
}

// Consulta el estado real de Evolution API cada 5 s (máximo 3 minutos).
function startWaPolling() {
  stopWaPolling();
  let tries = 0;
  state.waPollTimer = setInterval(async () => {
    tries += 1;
    try {
      const res = await fetch(`${API_BASE}/api/instance/status`, { cache: 'no-store' });
      const data = await res.json();
      updateWhatsappBadge(data.status, data.reason);
      if (data.status === 'CONNECTED') {
        stopWaPolling();
        setWaMessage('WhatsApp conectado. Ya puedes recibir y enviar mensajes.');
        toast('WhatsApp conectado', 'success');
        fetchHealth();
        loadQueue();
        return;
      }
    } catch (err) {
      /* se reintenta en el siguiente ciclo */
    }
    if (tries >= 36) {
      stopWaPolling();
      setWaMessage('Tiempo agotado. Genera un código nuevo e inténtalo otra vez.');
    }
  }, 5000);
}

async function ensureWebhookOnce() {
  if (state.webhookEnsured || !getToken()) return;
  state.webhookEnsured = true;
  try {
    await apiFetch('/api/instance/webhook', { method: 'POST' });
  } catch (err) {
    state.webhookEnsured = false; // se reintenta en el siguiente chequeo
  }
}

async function connectWhatsapp() {
  const btn = $('#btn-qr');
  const rawNumber = $('#pairing-number')?.value || '';
  const number = onlyDigits(rawNumber);

  if (rawNumber.trim() && (number.length < 8 || number.length > 15)) {
    toast('Número inválido: usa solo dígitos con código de país (8 a 15).', 'error');
    return;
  }

  btn.disabled = true;
  setWaMessage('Conectando con Evolution API…');
  updateWhatsappBadge('CONNECTING');

  try {
    const path = number ? `/api/instance/qrcode?number=${number}` : '/api/instance/qrcode';
    const data = await apiFetch(path);

    if (data.status === 'CONNECTED') {
      setWaMessage('WhatsApp ya está conectado.');
      updateWhatsappBadge('CONNECTED');
      return;
    }

    if (data.pairingCode) {
      const code = String(data.pairingCode).replace(/(.{4})(?=.)/g, '$1-');
      const big = document.createElement('div');
      big.className = 'pairing-code';
      big.textContent = code;
      setWaMessage(
        'En WhatsApp: Dispositivos vinculados → Vincular con el número de teléfono. Escribe este código:',
        big
      );
      startWaPolling();
    } else if (data.base64) {
      const img = document.createElement('img');
      img.alt = 'Código QR de WhatsApp';
      img.src = data.base64.startsWith('data:') ? data.base64 : `data:image/png;base64,${data.base64}`;
      setWaMessage(
        'Escanea este QR desde WhatsApp → Dispositivos vinculados → Vincular un dispositivo.',
        img
      );
      startWaPolling();
    } else {
      setWaMessage('Evolution API aún está preparando la sesión. Espera unos segundos y vuelve a intentarlo.');
    }
  } catch (err) {
    updateWhatsappBadge('ERROR', err.message);
    setWaMessage(`No se pudo conectar: ${err.message}`);
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function disconnectWhatsapp() {
  if (!window.confirm('¿Desconectar WhatsApp de este panel?')) return;
  stopWaPolling();
  try {
    await apiFetch('/api/instance/logout', { method: 'POST' });
    setWaMessage('WhatsApp desconectado.');
    toast('WhatsApp desconectado', 'success');
  } catch (err) {
    setWaMessage(`No se pudo desconectar: ${err.message}`);
    toast(err.message, 'error');
  }
  fetchHealth();
}

// ---------------------------------------------------------------------
// Helpers de tablas
// ---------------------------------------------------------------------
function tableBody(tableId) {
  return document.querySelector(`#${tableId} tbody`);
}

function loadingRow(tableId, colspan) {
  const body = tableBody(tableId);
  if (body) {
    body.innerHTML = `<tr><td colspan="${colspan}" class="empty-cell">
      <span class="skeleton" style="display:inline-block;width:180px"></span>
    </td></tr>`;
  }
}

function renderRows(tableId, colspan, rows, emptyText) {
  const body = tableBody(tableId);
  if (!body) return;
  body.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="${colspan}" class="empty-cell">${esc(emptyText)}</td></tr>`;
}

function errorRow(tableId, colspan, message) {
  const body = tableBody(tableId);
  if (body) {
    body.innerHTML = `<tr><td colspan="${colspan}" class="empty-cell error-cell">${esc(message)}</td></tr>`;
  }
}

function setCount(selector, text) {
  const el = $(selector);
  if (el) el.textContent = text;
}

// ---------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------
function updateKpis() {
  const customersEl = $('#kpi-customers');
  if (customersEl) customersEl.textContent = state.loaded.customers ? state.customers.length : '–';

  const conversationsEl = $('#kpi-conversations');
  if (conversationsEl) {
    conversationsEl.textContent = state.loaded.conversations
      ? state.conversations.filter((c) => c.status !== 'CLOSED').length
      : '–';
  }

  const queueEl = $('#kpi-queue');
  if (queueEl) {
    queueEl.textContent = state.loaded.queue
      ? state.queue.filter((q) => q.status === 'PENDING' || q.status === 'PROCESSING').length
      : '–';
  }

  const errorsEl = $('#kpi-errors');
  if (errorsEl) {
    errorsEl.textContent = state.loaded.logs
      ? state.logs.filter((l) => l.level === 'ERROR').length
      : '–';
  }
}

// ---------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------
function fillCustomerSelect() {
  const select = $('#sched-customer');
  if (!select) return;
  const current = select.value;
  const options = state.customers
    .map((c) => `<option value="${esc(c.id)}">${esc(customerLabel(c))}</option>`)
    .join('');
  select.innerHTML = `<option value="">Selecciona un cliente…</option>${options}`;
  if (current && state.customersById.has(Number(current))) select.value = current;
}

function renderCustomers() {
  if (!state.loaded.customers) return;
  const query = state.filters.customers.trim().toLowerCase();

  const filtered = state.customers.filter((c) => {
    if (!query) return true;
    return [c.phone, c.name, c.email, c.status, c.interest_type, c.interest_level]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });

  setCount(
    '#customers-count',
    query
      ? `${filtered.length} de ${state.customers.length} clientes`
      : `${state.customers.length} ${state.customers.length === 1 ? 'cliente' : 'clientes'}`
  );

  const rows = filtered.map((c) => `
    <tr>
      <td>${esc(c.phone)}</td>
      <td>
        ${esc(c.name || '—')}
        ${c.email ? `<span class="cell-sub">${esc(c.email)}</span>` : ''}
      </td>
      <td>${badgeFor(c.status)}</td>
      <td>
        ${esc(c.interest_type || '—')}
        ${c.interest_level ? `<span class="cell-sub">${esc(c.interest_level)}</span>` : ''}
      </td>
      <td>${timeHtml(c.last_message_at)}</td>
      <td>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" data-customer-response="${esc(c.id)}">Tiempo de respuesta</button>
        </div>
      </td>
    </tr>`);

  renderRows('table-customers', 6, rows, query ? 'Ningún cliente coincide con la búsqueda.' : 'Todavía no hay clientes.');
}

async function loadCustomers() {
  if (!state.loaded.customers) loadingRow('table-customers', 6);
  try {
    const customers = await apiFetch(`/api/customers?limit=${PAGE_SIZE}`);
    state.customers = Array.isArray(customers) ? customers : [];
    state.customersById = new Map(state.customers.map((c) => [Number(c.id), c]));
    state.loaded.customers = true;
    delete state.errors.customers;
    renderCustomers();
    fillCustomerSelect();
  } catch (err) {
    state.errors.customers = err.message;
    setCount('#customers-count', 'No se pudieron cargar los clientes');
    errorRow('table-customers', 6, `No se pudieron cargar los clientes: ${err.message}`);
  }
  updateKpis();
}

async function createCustomer(event) {
  event.preventDefault();
  const phone = onlyDigits($('#customer-phone').value);
  const name = $('#customer-name').value.trim();
  const email = $('#customer-email').value.trim();

  if (phone.length < 8 || phone.length > 15) {
    toast('El teléfono debe tener entre 8 y 15 dígitos, sin “+”.', 'error');
    return;
  }

  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await apiFetch('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ phone, name: name || null, email: email || null }),
    });
    toast('Cliente creado', 'success');
    event.target.reset();
    const details = event.target.closest('details');
    if (details) details.open = false;
    await loadCustomers();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------
function renderConversations() {
  if (!state.loaded.conversations) return;
  const filter = state.filters.conversations;
  const filtered = state.conversations.filter((c) => filter === 'ALL' || c.status === filter);

  setCount(
    '#conversations-count',
    filter === 'ALL'
      ? `${state.conversations.length} conversaciones`
      : `${filtered.length} de ${state.conversations.length} conversaciones`
  );

  const rows = filtered.map((c) => {
    const customer = customerById(c.customer_id);
    const actions = [];
    actions.push(`<button class="btn btn-ghost btn-sm" data-conv-action="view" data-id="${esc(c.id)}">Ver</button>`);
    if (c.status !== 'HUMAN' && c.status !== 'CLOSED') {
      actions.push(`<button class="btn btn-ghost btn-sm" data-conv-action="human" data-id="${esc(c.id)}">Derivar</button>`);
    }
    if (c.status !== 'CLOSED') {
      actions.push(`<button class="btn btn-danger btn-sm" data-conv-action="close" data-id="${esc(c.id)}">Cerrar</button>`);
    }
    if (c.status === 'HUMAN' || c.bot_enabled === false) {
      actions.push(`<button class="btn btn-ghost btn-sm" data-conv-action="release" data-id="${esc(c.id)}">Reactivar bot</button>`);
    }

    return `<tr>
      <td>
        ${esc(customer ? customerLabel(customer) : `Cliente #${c.customer_id}`)}
        <span class="cell-sub">Conversación #${esc(c.id)}</span>
      </td>
      <td>
        ${badgeFor(c.status)}
        <span class="cell-sub">${c.bot_enabled === false ? 'Bot desactivado' : 'Bot activo'}</span>
      </td>
      <td>${timeHtml(c.last_message_at || c.started_at)}</td>
      <td><div class="btn-row">${actions.join('')}</div></td>
    </tr>`;
  });

  renderRows('table-conversations', 4, rows, 'No hay conversaciones en este estado.');
}

async function loadConversations() {
  if (!state.loaded.conversations) loadingRow('table-conversations', 4);
  try {
    const conversations = await apiFetch(`/api/conversations?limit=${PAGE_SIZE}`);
    state.conversations = Array.isArray(conversations) ? conversations : [];
    state.loaded.conversations = true;
    delete state.errors.conversations;
    renderConversations();
  } catch (err) {
    state.errors.conversations = err.message;
    setCount('#conversations-count', 'No se pudieron cargar las conversaciones');
    errorRow('table-conversations', 4, `No se pudieron cargar las conversaciones: ${err.message}`);
  }
  updateKpis();
}

async function updateConversation(id, status) {
  const messages = {
    HUMAN: 'Conversación derivada a atención humana',
    CLOSED: 'Conversación cerrada',
    OPEN: 'Conversación reabierta',
  };
  await apiFetch(`/api/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
  toast(messages[status] || 'Conversación actualizada', 'success');
  await loadConversations();
  if (state.modalConversationId && String(state.modalConversationId) === String(id)) {
    const conversation = state.conversations.find((c) => String(c.id) === String(id));
    if (conversation) updateModalHeader(conversation);
  }
}

async function handleConversationAction(action, id) {
  if (action === 'view') {
    openConversation(id);
    return;
  }

  if (action === 'close' && !window.confirm('¿Cerrar esta conversación?')) return;
  if (action === 'human' && !window.confirm('¿Tomar el control humano? Se cancelarán las respuestas automáticas pendientes de esta conversación.')) return;

  try {
    if (action === 'release') {
      await apiFetch(`/api/response-control/conversations/${id}/release`, { method: 'POST' });
      toast('Bot reactivado en la conversación', 'success');
      await loadConversations();
      return;
    }
    await updateConversation(id, action === 'human' ? 'HUMAN' : 'CLOSED');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Modal de conversación
// ---------------------------------------------------------------------
function updateModalHeader(conversation) {
  const customer = customerById(conversation.customer_id);
  $('#modal-subtitle').textContent =
    `${customer ? customerLabel(customer) : `Cliente #${conversation.customer_id}`} · Estado: ${conversation.status}`;

  const actions = [];
  if (conversation.status !== 'HUMAN' && conversation.status !== 'CLOSED') {
    actions.push('<button class="btn btn-ghost btn-sm" data-modal-action="human">Derivar a humano</button>');
  }
  if (conversation.status !== 'CLOSED') {
    actions.push('<button class="btn btn-danger btn-sm" data-modal-action="close">Cerrar conversación</button>');
  }
  if (conversation.status === 'HUMAN' || conversation.bot_enabled === false) {
    actions.push('<button class="btn btn-primary btn-sm" data-modal-action="release">Reactivar bot</button>');
  }
  $('#modal-actions').innerHTML = actions.join('');
}

async function openConversation(id) {
  const conversation = state.conversations.find((c) => String(c.id) === String(id));
  if (!conversation) {
    toast('No se encontró la conversación', 'error');
    return;
  }

  state.modalConversationId = conversation.id;
  updateModalHeader(conversation);
  $('#chat-messages').innerHTML = '<p class="muted">Cargando mensajes…</p>';
  $('#modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const closeBtn = $('#modal .modal-head [data-close-modal]');
  if (closeBtn) setTimeout(() => closeBtn.focus(), 60);

  try {
    const messages = await apiFetch(
      `/api/messages?conversation_id=${encodeURIComponent(conversation.id)}&limit=${PAGE_SIZE}`
    );
    renderChat(messages);
  } catch (err) {
    $('#chat-messages').innerHTML = `<p class="alert alert-error">${esc(err.message)}</p>`;
  }
}

function renderChat(messages) {
  const container = $('#chat-messages');
  if (!Array.isArray(messages) || messages.length === 0) {
    container.innerHTML = '<p class="muted">No hay mensajes registrados en esta conversación.</p>';
    return;
  }

  container.innerHTML = messages.map((m) => {
    const outbound = m.direction === 'OUTBOUND';
    const content = m.content || `[${m.message_type || 'ARCHIVO'}]`;
    return `<div class="bubble ${outbound ? 'out' : 'in'}">
      <p>${esc(content)}</p>
      <span class="bubble-meta">${esc(fmtDate(m.created_at))} · ${esc(m.status || '—')}</span>
    </div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function closeModal() {
  state.modalConversationId = null;
  $('#modal').classList.add('hidden');
  document.body.style.overflow = '';
  $('#chat-messages').innerHTML = '';
}

// ---------------------------------------------------------------------
// Chat en vivo
// ---------------------------------------------------------------------
const liveChatState = { conversationId: null, conversations: [], tick: 0 };

function liveChatBubbleText(message) {
  let text = String(message.content || '');
  let label = null;
  // Las transcripciones/descripciones llegan como "[La persona envió ...]: texto"
  const match = text.match(/^\[([^\]]+)\]:?\s*/);
  if (match) {
    label = match[1];
    text = text.slice(match[0].length);
  }
  const typeLabels = {
    AUDIO: 'Nota de voz',
    IMAGE: 'Imagen',
    VIDEO: 'Vídeo',
    DOCUMENT: 'Documento',
    LOCATION: 'Ubicación',
    STICKER: 'Sticker',
  };
  return { label, text, type: typeLabels[message.message_type] || null };
}

function liveChatName(conversation) {
  return conversation.customer_name || conversation.customer_phone || `Cliente #${conversation.customer_id}`;
}

function renderLiveChatList() {
  const listEl = $('#live-chat-list');
  if (!listEl) return;
  const items = liveChatState.conversations;

  setCount(
    '#live-chat-count',
    items.length
      ? `${items.length} ${items.length === 1 ? 'conversación' : 'conversaciones'}`
      : 'Sin conversaciones todavía'
  );

  if (!items.length) {
    listEl.innerHTML = '<p class="chat-empty">Sin conversaciones todavía.</p>';
    return;
  }

  const scrollTop = listEl.scrollTop;
  listEl.innerHTML = items.map((conversation) => {
    const preview = String(conversation.last_message_preview || '')
      .replace(/^\[[^\]]+\]:?\s*/, '')
      .slice(0, 60);
    const active = conversation.id === liveChatState.conversationId ? ' is-active' : '';
    return `<button type="button" class="live-chat-item${active}" data-live-chat="${esc(conversation.id)}">
      <span class="live-chat-item-name">${esc(liveChatName(conversation))}</span>
      <span class="live-chat-item-preview">${esc(preview || 'Sin mensajes')}</span>
    </button>`;
  }).join('');
  listEl.scrollTop = scrollTop;

  $$('[data-live-chat]', listEl).forEach((node) => {
    node.addEventListener('click', () => openLiveChat(Number(node.dataset.liveChat)));
  });
}

async function loadLiveChats() {
  const listEl = $('#live-chat-list');
  if (!listEl) return;
  try {
    const conversations = await apiFetch('/api/conversations?view=chat&limit=50');
    liveChatState.conversations = Array.isArray(conversations) ? conversations : [];
    renderLiveChatList();
  } catch (err) {
    setCount('#live-chat-count', 'No se pudo cargar el chat');
    listEl.innerHTML = `<p class="chat-empty">No se pudo cargar: ${esc(err.message)}</p>`;
  }
}

async function openLiveChat(conversationId) {
  liveChatState.conversationId = conversationId;
  renderLiveChatList();
  const conversation = liveChatState.conversations.find((c) => c.id === conversationId);
  const header = $('#live-chat-header');
  if (header) {
    header.textContent = conversation ? liveChatName(conversation) : `Conversación ${conversationId}`;
  }
  const container = $('#live-chat-messages');
  if (container) container.innerHTML = '<p class="chat-empty">Cargando mensajes…</p>';
  await refreshLiveChatMessages();
}

async function refreshLiveChatMessages() {
  if (!liveChatState.conversationId) return;
  const container = $('#live-chat-messages');
  if (!container) return;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

  try {
    const messages = await apiFetch(
      `/api/messages?conversation_id=${encodeURIComponent(liveChatState.conversationId)}&limit=${PAGE_SIZE}`
    );
    const list = Array.isArray(messages) ? messages : [];

    if (!list.length) {
      container.innerHTML = '<p class="chat-empty">Sin mensajes en esta conversación.</p>';
      return;
    }

    container.innerHTML = list.map((message) => {
      const { label, text, type } = liveChatBubbleText(message);
      const side = message.direction === 'INBOUND' ? 'in' : 'out';
      const parts = [];
      if (type) parts.push(`<div class="live-bubble-type">${esc(type)}</div>`);
      if (label) parts.push(`<div class="live-bubble-type">${esc(label)}</div>`);
      if (text) parts.push(`<div class="live-bubble-text">${esc(text).replace(/\n/g, '<br>')}</div>`);
      return `<div class="live-row ${side}">
        <div class="live-bubble">
          ${parts.join('')}
          <div class="live-bubble-meta">
            <span>${esc(fmtDate(message.created_at))}</span>
            <button type="button" class="live-bubble-del" data-del-live-msg="${esc(message.id)}" title="Borrar mensaje" aria-label="Borrar mensaje">🗑</button>
          </div>
        </div>
      </div>`;
    }).join('');

    if (atBottom) container.scrollTop = container.scrollHeight;
    $$('[data-del-live-msg]', container).forEach((node) => {
      node.addEventListener('click', () => deleteLiveChatMessage(Number(node.dataset.delLiveMsg)));
    });
  } catch (err) {
    container.innerHTML = `<p class="chat-empty">Error: ${esc(err.message)}</p>`;
  }
}

async function deleteLiveChatMessage(id) {
  if (!window.confirm('¿Borrar este mensaje del panel? Si lo envió el bot, también se intentará borrar en WhatsApp para todos.')) {
    return;
  }
  try {
    const result = await apiFetch(`/api/messages/${id}`, { method: 'DELETE' });
    if (result?.deletedFromPanel && result?.whatsappRevoked) {
      toast('Mensaje borrado del panel y de WhatsApp', 'success');
    } else if (result?.deletedFromPanel) {
      toast('Borrado del panel. WhatsApp no confirmó el borrado para todos.', 'warn', 6500);
    } else {
      toast('El servidor no confirmó el borrado', 'warn');
    }
    await Promise.allSettled([refreshLiveChatMessages(), loadLiveChats()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Cola
// ---------------------------------------------------------------------
function renderQueue() {
  if (!state.loaded.queue) return;
  const filter = state.filters.queue;
  const filtered = state.queue.filter((q) => filter === 'ALL' || q.status === filter);

  setCount(
    '#queue-count',
    filter === 'ALL' ? `${state.queue.length} mensajes` : `${filtered.length} de ${state.queue.length} mensajes`
  );

  const rows = filtered.map((q) => `<tr>
    <td>${esc(q.id)}</td>
    <td>${esc(q.phone)}</td>
    <td>
      <span class="cell-truncate" title="${esc(q.message || '')}">${esc(q.message || '—')}</span>
      ${q.error_message ? `<span class="cell-sub error-cell">${esc(q.error_message)}</span>` : ''}
    </td>
    <td>${badgeFor(q.status)}</td>
    <td>${esc(q.attempts ?? 0)}</td>
    <td>${timeHtml(q.created_at)}</td>
  </tr>`);

  renderRows('table-queue', 6, rows, 'No hay mensajes en la cola con este estado.');
}

async function loadQueue() {
  if (!state.loaded.queue) loadingRow('table-queue', 6);
  try {
    const items = await apiFetch(`/api/queue?limit=${PAGE_SIZE}`);
    state.queue = Array.isArray(items) ? items : [];
    state.loaded.queue = true;
    delete state.errors.queue;
    renderQueue();
  } catch (err) {
    state.errors.queue = err.message;
    setCount('#queue-count', 'No se pudo cargar la cola');
    errorRow('table-queue', 6, `No se pudo cargar la cola: ${err.message}`);
  }
  updateKpis();
}

async function runQueueAction(action) {
  if (action === 'stop' && !window.confirm('¿Detener la cola y cancelar todos los mensajes abiertos?')) return;
  const labels = { pause: 'Cola pausada', resume: 'Cola reanudada', stop: 'Cola detenida' };
  try {
    await apiFetch(`/api/queue/${action}`, { method: 'POST' });
    toast(labels[action] || 'Cola actualizada', 'success');
    await Promise.all([loadQueue(), fetchAutomationStatus()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Control de respuestas automaticas
// ---------------------------------------------------------------------
const RESPONSE_STATUS_LABELS = {
  ACTIVE: 'Activa',
  PAUSED: 'Pausada',
  STOPPED: 'Detenida',
};

function isAdmin() {
  return state.user && state.user.role === 'ADMIN';
}

function renderResponseAlerts() {
  const container = $('#response-alerts');
  if (!container) return;
  const alerts = Array.isArray(state.response.alerts) ? state.response.alerts : [];
  container.innerHTML = alerts.map((alert) => {
    const tone = alert.level === 'error' ? 'is-error' : 'is-warn';
    return `<div class="alert-item ${tone}">
      <span class="status-dot ${alert.level === 'error' ? 'down' : 'warn'}"></span>
      <div>
        <strong>${esc(alert.code || 'Aviso')}</strong>
        <span>${esc(alert.message || '')}</span>
      </div>
    </div>`;
  }).join('');
}

function renderResponseControl() {
  const { settings, stats, limits } = state.response;
  if (!settings || !stats) return;

  setCount('#resp-kpi-pending', stats.pending ?? '–');
  setCount('#resp-kpi-processing', stats.processing ?? '–');
  setCount('#resp-kpi-sent', stats.sent_today ?? '–');
  setCount('#resp-kpi-failed', stats.failed_today ?? '–');
  setCount('#resp-kpi-uncertain', stats.uncertain_today ?? '–');

  const pill = $('#response-status-pill');
  if (pill) {
    const tone = settings.status === 'ACTIVE' ? 'up' : settings.status === 'PAUSED' ? 'warn' : 'down';
    pill.className = `pill is-${tone}`;
    const stateLabel = RESPONSE_STATUS_LABELS[settings.status] || settings.status;
    pill.textContent = settings.enabled ? stateLabel : `Desactivada · ${stateLabel}`;
  }
  const modePill = $('#response-mode-pill');
  if (modePill) {
    modePill.className = `pill ${settings.enabled && settings.status === 'ACTIVE' ? 'is-up' : 'is-warn'}`;
    modePill.textContent = settings.enabled && settings.status === 'ACTIVE' ? 'Respondiendo' : 'En pausa';
  }

  setCount(
    '#response-summary',
    `${stats.pending + stats.processing + stats.paused} trabajo(s) en curso · `
      + `${stats.sent_today} enviadas hoy · ${stats.failed_today} errores · ${stats.uncertain_today} inciertas`
  );
  setCount(
    '#response-limits',
    `Rangos permitidos: espera mínima ${limits.minDelaySeconds.min}–${limits.minDelaySeconds.max}s · `
      + `máxima ${limits.maxDelaySeconds.min}–${limits.maxDelaySeconds.max}s · `
      + `agrupación ${limits.groupingWindowSeconds.min}–${limits.groupingWindowSeconds.max}s · `
      + `simultáneas ${limits.maxConcurrentResponses.min}–${limits.maxConcurrentResponses.max}.`
  );

  const form = $('#form-response');
  if (form && !form.contains(document.activeElement)) {
    $('#response-enabled').checked = Boolean(settings.enabled);
    $('#response-min').value = settings.minDelaySeconds;
    $('#response-max').value = settings.maxDelaySeconds;
    $('#response-grouping').value = settings.groupingWindowSeconds;
    $('#response-concurrency').value = settings.maxConcurrentResponses;
    $('#response-threshold').value = settings.alertThreshold;
  }

  const admin = isAdmin();
  if (form) {
    form.querySelectorAll('input, button').forEach((node) => { node.disabled = !admin; });
  }
  $$('[data-response-action]').forEach((btn) => {
    btn.disabled = !admin;
    btn.title = admin ? '' : 'Solo un administrador puede cambiar la configuración global';
  });

  renderResponseAlerts();
}

async function loadResponseControl() {
  try {
    state.response = await apiFetch('/api/response-control');
    state.loaded.response = true;
    delete state.errors.response;
    renderResponseControl();
  } catch (err) {
    state.errors.response = err.message;
    setCount('#response-summary', `No se pudo cargar el control de respuestas: ${err.message}`);
    const container = $('#response-alerts');
    if (container) {
      container.innerHTML = `<div class="alert-item is-error"><div><strong>Error</strong><span>${esc(err.message)}</span></div></div>`;
    }
  }
}

function readResponseForm() {
  const enabled = $('#response-enabled').checked;
  const values = {
    enabled,
    minDelaySeconds: Number($('#response-min').value),
    maxDelaySeconds: Number($('#response-max').value),
    groupingWindowSeconds: Number($('#response-grouping').value),
    maxConcurrentResponses: Number($('#response-concurrency').value),
    alertThreshold: Number($('#response-threshold').value),
  };
  const integerFields = ['minDelaySeconds', 'maxDelaySeconds', 'groupingWindowSeconds', 'maxConcurrentResponses', 'alertThreshold'];
  if (integerFields.some((field) => !Number.isInteger(values[field]))) {
    throw new Error('Todos los tiempos y límites deben ser números enteros.');
  }
  if (values.minDelaySeconds < 0 || values.minDelaySeconds > 600) throw new Error('La espera mínima debe estar entre 0 y 600 s.');
  if (values.maxDelaySeconds < 0 || values.maxDelaySeconds > 900) throw new Error('La espera máxima debe estar entre 0 y 900 s.');
  if (values.maxDelaySeconds < values.minDelaySeconds) throw new Error('La espera máxima no puede ser menor que la mínima.');
  if (values.groupingWindowSeconds < 0 || values.groupingWindowSeconds > 120) throw new Error('La agrupación debe estar entre 0 y 120 s.');
  if (values.maxConcurrentResponses < 1 || values.maxConcurrentResponses > 10) throw new Error('Las respuestas simultáneas deben estar entre 1 y 10.');
  if (values.alertThreshold < 1 || values.alertThreshold > 100) throw new Error('El umbral de alertas debe estar entre 1 y 100.');
  return values;
}

async function saveResponseSettings(event) {
  event.preventDefault();
  const button = $('#btn-save-response');
  let values;
  try {
    values = readResponseForm();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  button.disabled = true;
  try {
    await apiFetch('/api/response-control', { method: 'PUT', body: JSON.stringify(values) });
    toast('Configuración de respuestas guardada', 'success');
    await Promise.all([loadResponseControl(), loadResponseJobs(), loadResponseHistory()]);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function runResponseAction(action) {
  if (!isAdmin()) return toast('Solo un administrador puede hacer esto', 'warn');
  const messages = {
    activate: 'Respuestas automáticas activadas',
    pause: 'Cola de respuestas pausada',
    stop: 'Detención de emergencia activada',
  };
  if (action === 'stop' && !window.confirm('¿Detener de emergencia? Se cancelarán todas las respuestas automáticas abiertas.')) return;
  if (action === 'pause' && !window.confirm('¿Pausar la cola de respuestas? Los trabajos se conservan y pueden reanudarse.')) return;
  try {
    await apiFetch(`/api/response-control/${action}`, { method: 'POST', body: JSON.stringify({}) });
    toast(messages[action] || 'Estado actualizado', 'success');
    await Promise.all([
      loadResponseControl(),
      loadResponseJobs(),
      loadResponseHistory(),
      fetchAutomationStatus(),
      loadQueue(),
    ]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function jobCustomer(job) {
  if (job.customer_name || job.customer_phone) {
    return job.customer_name ? `${job.customer_name} · ${job.customer_phone}` : job.customer_phone;
  }
  const customer = customerById(job.customer_id);
  return customer ? customerLabel(customer) : `Cliente #${job.customer_id}`;
}

function renderResponseJobs() {
  if (!state.loaded.responseJobs) return;
  const filter = state.filters.responseJobs;
  const filtered = state.responseJobs.filter((job) => filter === 'ALL' || job.status === filter);

  setCount(
    '#response-jobs-count',
    filter === 'ALL'
      ? `${state.responseJobs.length} trabajos`
      : `${filtered.length} de ${state.responseJobs.length} trabajos`
  );

  const rows = filtered.map((job) => {
    const detail = job.error_message
      ? `<span class="cell-sub error-cell">${esc(job.error_message)}</span>`
        + (job.status === 'UNCERTAIN'
          ? '<span class="cell-sub">Entrega incierta: no se reintenta sola. Revisa la conversación antes de reenviar.</span>'
          : '')
      : job.reply_text
        ? `<span class="cell-sub">${esc(String(job.reply_text).slice(0, 120))}</span>`
        : '<span class="cell-sub">—</span>';
    const actions = job.status === 'FAILED'
      ? `<button class="btn btn-ghost btn-sm" data-job-action="retry" data-id="${esc(job.id)}">Reintentar</button>`
      : '—';
    return `<tr>
      <td>${esc(job.id)}</td>
      <td>
        ${esc(jobCustomer(job))}
        <span class="cell-sub">Conversación #${esc(job.conversation_id)}</span>
      </td>
      <td>${badgeFor(job.status)}</td>
      <td>${timeHtml(job.due_at)}</td>
      <td>${esc(job.attempts ?? 0)} / ${esc(job.max_attempts ?? '—')}</td>
      <td><span class="cell-truncate" title="${esc(job.reply_text || job.error_message || '')}">${detail}</span></td>
      <td><div class="btn-row">${actions}</div></td>
    </tr>`;
  });

  renderRows('table-response-jobs', 7, rows, 'No hay trabajos de respuesta con este estado.');
}

async function loadResponseJobs() {
  if (!state.loaded.responseJobs) loadingRow('table-response-jobs', 7);
  try {
    const status = state.filters.responseJobs === 'ALL' ? '' : `&status=${encodeURIComponent(state.filters.responseJobs)}`;
    const jobs = await apiFetch(`/api/response-control/jobs?limit=${PAGE_SIZE}${status}`);
    state.responseJobs = Array.isArray(jobs) ? jobs : [];
    state.loaded.responseJobs = true;
    delete state.errors.responseJobs;
    renderResponseJobs();
  } catch (err) {
    state.errors.responseJobs = err.message;
    errorRow('table-response-jobs', 7, `No se pudieron cargar los trabajos: ${err.message}`);
  }
}

async function retryResponseJob(id) {
  if (!window.confirm('¿Reintentar esta respuesta? Solo se permite si el fallo fue confirmado.')) return;
  try {
    await apiFetch(`/api/response-control/jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({}) });
    toast('Respuesta reencolada', 'success');
    await Promise.all([loadResponseJobs(), loadResponseControl()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function historyDetail(entry) {
  if (entry.reason) return entry.reason;
  const value = entry.next_value || entry.previous_value;
  if (!value) return '—';
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function renderResponseHistory() {
  if (!state.loaded.responseHistory) return;
  setCount('#response-history-count', `${state.responseHistory.length} cambios recientes`);
  const rows = state.responseHistory.map((entry) => `<tr>
    <td>${timeHtml(entry.created_at)}</td>
    <td>${esc(entry.scope || '—')}</td>
    <td>${esc(entry.action || '—')}</td>
    <td>${esc(entry.actor_name || entry.actor_email || 'Sistema')}</td>
    <td><span class="cell-truncate" title="${esc(historyDetail(entry))}">${esc(historyDetail(entry))}</span></td>
  </tr>`);
  renderRows('table-response-history', 5, rows, 'Todavía no hay cambios registrados.');
}

async function loadResponseHistory() {
  if (!state.loaded.responseHistory) loadingRow('table-response-history', 5);
  try {
    const items = await apiFetch('/api/response-control/history?limit=50');
    state.responseHistory = Array.isArray(items) ? items : [];
    state.loaded.responseHistory = true;
    delete state.errors.responseHistory;
    renderResponseHistory();
  } catch (err) {
    state.errors.responseHistory = err.message;
    errorRow('table-response-history', 5, `No se pudo cargar el historial: ${err.message}`);
  }
}

// -------------------------- Ajuste por cliente --------------------------
function fillCustomerResponseForm(data) {
  const effective = data.effective || {};
  const global = data.global || {};
  $('#customer-modal-title').textContent = data.customer?.name || data.customer?.phone || 'Tiempo de respuesta';
  $('#customer-modal-subtitle').textContent = data.customer?.phone || '—';
  setCount(
    '#customer-response-source',
    data.configured
      ? 'Este cliente tiene una configuración propia. Si la borras, se usan los valores globales.'
      : `Este cliente usa los valores globales: ${global.minDelaySeconds}–${global.maxDelaySeconds} s y agrupación de ${global.groupingWindowSeconds} s.`
  );

  $('#cres-enabled').checked = Boolean(effective.enabled);
  $('#cres-min').value = effective.minDelaySeconds;
  $('#cres-max').value = effective.maxDelaySeconds;
  $('#cres-priority').value = effective.priority;
  $('#cres-random').checked = Boolean(effective.randomVariation);
  $('#cres-paused').checked = Boolean(effective.paused);

  const conversation = data.conversation;
  const humanPill = $('#customer-human-pill');
  const humanStatus = $('#customer-human-status');
  const takeoverBtn = $('[data-cust-response="takeover"]');
  const releaseBtn = $('[data-cust-response="release"]');

  if (!conversation) {
    humanPill.className = 'pill';
    humanPill.textContent = 'Sin conversación';
    humanStatus.textContent = 'No hay una conversación abierta con este cliente.';
    takeoverBtn.disabled = true;
    releaseBtn.disabled = true;
    takeoverBtn.hidden = true;
    releaseBtn.hidden = true;
    return;
  }

  const botEnabled = conversation.botEnabled !== false && conversation.status !== 'HUMAN';
  humanPill.className = `pill ${botEnabled ? 'is-up' : 'is-warn'}`;
  humanPill.textContent = botEnabled ? 'Bot activo' : 'Atención humana';
  humanStatus.textContent = botEnabled
    ? `El bot responde automáticamente. Conversación #${conversation.id} (${conversation.status}).`
    : `Una persona tomó el control${conversation.humanTakenOverAt ? ` el ${fmtDate(conversation.humanTakenOverAt)}` : ''}. `
      + 'Las respuestas automáticas de esta conversación están canceladas hasta que reactives el bot.';
  takeoverBtn.disabled = !botEnabled;
  releaseBtn.disabled = botEnabled;
  takeoverBtn.hidden = !botEnabled;
  releaseBtn.hidden = botEnabled;
}

async function openCustomerResponse(id) {
  state.modalCustomerId = Number(id);
  const modal = $('#customer-modal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  try {
    const data = await apiFetch(`/api/response-control/customers/${id}`);
    state.modalCustomerState = data;
    fillCustomerResponseForm(data);
  } catch (err) {
    toast(err.message, 'error');
    closeCustomerModal();
  }
}

function closeCustomerModal() {
  state.modalCustomerId = null;
  state.modalCustomerState = null;
  $('#customer-modal').classList.add('hidden');
  document.body.style.overflow = $('#modal').classList.contains('hidden') ? '' : 'hidden';
}

function readCustomerResponseForm() {
  const values = {
    enabled: $('#cres-enabled').checked,
    minDelaySeconds: Number($('#cres-min').value),
    maxDelaySeconds: Number($('#cres-max').value),
    randomVariation: $('#cres-random').checked,
    priority: Number($('#cres-priority').value),
    paused: $('#cres-paused').checked,
  };
  if (!Number.isInteger(values.minDelaySeconds) || !Number.isInteger(values.maxDelaySeconds) || !Number.isInteger(values.priority)) {
    throw new Error('Los tiempos y la prioridad deben ser números enteros.');
  }
  if (values.minDelaySeconds < 0 || values.minDelaySeconds > 600) throw new Error('La espera mínima debe estar entre 0 y 600 s.');
  if (values.maxDelaySeconds < 0 || values.maxDelaySeconds > 900) throw new Error('La espera máxima debe estar entre 0 y 900 s.');
  if (values.maxDelaySeconds < values.minDelaySeconds) throw new Error('La espera máxima no puede ser menor que la mínima.');
  if (values.priority < 0 || values.priority > 10) throw new Error('La prioridad debe estar entre 0 y 10.');
  return values;
}

async function saveCustomerResponse(event) {
  event.preventDefault();
  if (!state.modalCustomerId) return;
  const button = $('#btn-save-customer-response');
  let values;
  try {
    values = readCustomerResponseForm();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  button.disabled = true;
  try {
    const data = await apiFetch(`/api/response-control/customers/${state.modalCustomerId}`, {
      method: 'PUT',
      body: JSON.stringify(values),
    });
    state.modalCustomerState = data;
    fillCustomerResponseForm(data);
    toast('Tiempo de respuesta guardado', 'success');
    await Promise.all([loadResponseControl(), loadResponseJobs(), loadResponseHistory()]);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function resetCustomerResponse() {
  if (!state.modalCustomerId) return;
  if (!window.confirm('¿Borrar la configuración propia y volver a los valores globales?')) return;
  try {
    const data = await apiFetch(`/api/response-control/customers/${state.modalCustomerId}`, { method: 'DELETE' });
    state.modalCustomerState = data;
    fillCustomerResponseForm(data);
    toast('Se usan los valores globales para este cliente', 'success');
    await Promise.all([loadResponseControl(), loadResponseJobs(), loadResponseHistory()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function changeCustomerHuman(action) {
  const data = state.modalCustomerState;
  if (!state.modalCustomerId || !data?.conversation) return;
  const conversationId = data.conversation.id;
  if (action === 'takeover' && !window.confirm('¿Tomar el control humano? Se cancelarán las respuestas automáticas pendientes.')) return;
  try {
    await apiFetch(`/api/response-control/conversations/${conversationId}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ reason: action === 'takeover' ? 'Atención humana desde el panel' : null }),
    });
    toast(action === 'takeover' ? 'Atención humana activada' : 'Bot reactivado', 'success');
    const updated = await apiFetch(`/api/response-control/customers/${state.modalCustomerId}`);
    state.modalCustomerState = updated;
    fillCustomerResponseForm(updated);
    await Promise.all([loadConversations(), loadResponseControl(), loadResponseJobs()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Mensajes programados
// ---------------------------------------------------------------------
function renderScheduled() {
  if (!state.loaded.scheduled) return;
  const filter = state.filters.scheduled;
  const filtered = state.scheduled.filter((s) => filter === 'ALL' || s.status === filter);

  setCount(
    '#scheduled-count',
    filter === 'ALL' ? `${state.scheduled.length} programados` : `${filtered.length} de ${state.scheduled.length} programados`
  );

  const rows = filtered.map((s) => {
    const customer = customerById(s.customer_id);
    const actions = s.status === 'SCHEDULED'
      ? `<button class="btn btn-danger btn-sm" data-sched-action="cancel" data-id="${esc(s.id)}">Cancelar</button>`
      : '—';

    return `<tr>
      <td>
        ${esc(customer ? customerLabel(customer) : s.phone)}
        <span class="cell-sub">${esc(s.phone)}</span>
      </td>
      <td><span class="cell-truncate" title="${esc(s.message || '')}">${esc(s.message || '—')}</span></td>
      <td>${timeHtml(s.scheduled_at)}</td>
      <td>${badgeFor(s.status)}</td>
      <td><div class="btn-row">${actions}</div></td>
    </tr>`;
  });

  renderRows('table-scheduled', 5, rows, 'No hay mensajes programados con este estado.');
}

async function loadScheduled() {
  if (!state.loaded.scheduled) loadingRow('table-scheduled', 5);
  try {
    const items = await apiFetch(`/api/scheduled-messages?limit=${PAGE_SIZE}`);
    state.scheduled = Array.isArray(items) ? items : [];
    state.loaded.scheduled = true;
    delete state.errors.scheduled;
    renderScheduled();
  } catch (err) {
    state.errors.scheduled = err.message;
    setCount('#scheduled-count', 'No se pudieron cargar los programados');
    errorRow('table-scheduled', 5, `No se pudieron cargar los programados: ${err.message}`);
  }
}

function resetScheduleDate() {
  const input = $('#sched-when');
  if (!input) return;
  const soon = new Date(Date.now() + 60 * 1000);
  input.min = toLocalInputValue(soon);
  input.value = toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000));
}

async function createScheduledMessage(event) {
  event.preventDefault();
  const customerId = Number($('#sched-customer').value);
  const phone = onlyDigits($('#sched-phone').value);
  const message = $('#sched-message').value.trim();
  const whenRaw = $('#sched-when').value;

  if (!customerId) return toast('Selecciona un cliente', 'error');
  if (phone.length < 8 || phone.length > 15) return toast('El teléfono debe tener entre 8 y 15 dígitos', 'error');
  if (!message) return toast('Escribe el mensaje', 'error');

  const scheduledAt = new Date(whenRaw);
  if (Number.isNaN(scheduledAt.getTime())) return toast('Fecha y hora inválidas', 'error');
  if (scheduledAt.getTime() <= Date.now()) return toast('La fecha debe ser futura', 'error');

  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await apiFetch('/api/scheduled-messages', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        phone,
        message,
        scheduled_at: scheduledAt.toISOString(),
      }),
    });
    toast('Mensaje programado', 'success');
    $('#sched-message').value = '';
    resetScheduleDate();
    await loadScheduled();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function cancelScheduledMessage(id) {
  if (!window.confirm('¿Cancelar este mensaje programado?')) return;
  try {
    await apiFetch(`/api/scheduled-messages/${id}`, { method: 'DELETE' });
    toast('Mensaje cancelado', 'success');
    await loadScheduled();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------
function renderMessages() {
  if (!state.loaded.messages) return;
  const { direction, q } = state.filters.messages;
  const query = q.trim().toLowerCase();

  const filtered = state.messages.filter((m) => {
    if (direction !== 'ALL' && m.direction !== direction) return false;
    if (!query) return true;
    const customer = customerById(m.customer_id);
    return [m.content, m.message_type, m.status, clientSearch(customer)]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });

  setCount(
    '#messages-count',
    query || direction !== 'ALL'
      ? `${filtered.length} de ${state.messages.length} mensajes`
      : `${state.messages.length} mensajes recientes`
  );

  const rows = filtered.map((m) => {
    const customer = customerById(m.customer_id);
    return `<tr>
      <td>${timeHtml(m.created_at)}</td>
      <td>${badgeFor(m.direction)}</td>
      <td>${esc(customer ? customerLabel(customer) : `Cliente #${m.customer_id}`)}</td>
      <td>${esc(m.message_type || '—')}</td>
      <td><span class="cell-truncate" title="${esc(m.content || '')}">${esc(m.content || '—')}</span></td>
      <td>${badgeFor(m.status)}</td>
    </tr>`;
  });

  renderRows('table-messages', 6, rows, 'No hay mensajes que coincidan.');
}

function clientSearch(customer) {
  return customer ? `${customer.name || ''} ${customer.phone || ''}` : '';
}

async function loadMessages() {
  if (!state.loaded.messages) loadingRow('table-messages', 6);
  try {
    const items = await apiFetch(`/api/messages?limit=${PAGE_SIZE}`);
    state.messages = Array.isArray(items) ? items : [];
    state.loaded.messages = true;
    delete state.errors.messages;
    renderMessages();
  } catch (err) {
    state.errors.messages = err.message;
    setCount('#messages-count', 'No se pudieron cargar los mensajes');
    errorRow('table-messages', 6, `No se pudieron cargar los mensajes: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------
function renderLogs() {
  if (!state.loaded.logs) return;
  const { level, q } = state.filters.logs;
  const query = q.trim().toLowerCase();

  const filtered = state.logs.filter((l) => {
    if (level !== 'ALL' && l.level !== level) return false;
    if (!query) return true;
    return [l.event_type, l.message, l.level]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });

  setCount(
    '#logs-count',
    query || level !== 'ALL'
      ? `${filtered.length} de ${state.logs.length} eventos`
      : `${state.logs.length} eventos recientes`
  );

  const rows = filtered.map((l) => `<tr>
    <td>${timeHtml(l.created_at)}</td>
    <td>${badgeFor(l.level)}</td>
    <td>${esc(l.event_type || '—')}</td>
    <td>${esc(l.message || '—')}</td>
  </tr>`);

  renderRows('table-logs', 4, rows, 'No hay eventos que coincidan.');
}

async function loadLogs() {
  if (!state.loaded.logs) loadingRow('table-logs', 4);
  try {
    const items = await apiFetch(`/api/dashboard/logs?limit=${PAGE_SIZE}`);
    state.logs = Array.isArray(items) ? items : [];
    state.loaded.logs = true;
    delete state.errors.logs;
    renderLogs();
  } catch (err) {
    state.errors.logs = err.message;
    setCount('#logs-count', 'No se pudieron cargar los logs');
    errorRow('table-logs', 4, `No se pudieron cargar los logs: ${err.message}`);
  }
  updateKpis();
}

// ---------------------------------------------------------------------
// Actualización y pestañas
// ---------------------------------------------------------------------
function touchUpdated() {
  state.lastUpdatedAt = Date.now();
  updateLastUpdated();
}

function updateLastUpdated() {
  const el = $('#last-updated');
  if (!el) return;
  if (!state.lastUpdatedAt) {
    el.textContent = 'Sin actualizar';
    return;
  }
  const seconds = Math.floor((Date.now() - state.lastUpdatedAt) / 1000);
  el.textContent = seconds < 5 ? 'Actualizado ahora' : `Actualizado hace ${seconds} s`;
}

async function refreshAll() {
  await loadCustomers();
  await Promise.allSettled([
    fetchHealth(),
    fetchAutomationStatus(),
    loadConversations(),
    loadQueue(),
    loadScheduled(),
    loadMessages(),
    loadLogs(),
    loadResponseControl(),
    loadResponseJobs(),
    loadResponseHistory(),
  ]);
  updateKpis();
  touchUpdated();
}

async function refreshActiveTab() {
  switch (state.activeTab) {
    case 'tab-dashboard':
      await Promise.allSettled([fetchHealth(), fetchAutomationStatus()]);
      break;
    case 'tab-customers': return loadCustomers();
    case 'tab-chat':
      await loadLiveChats();
      if (liveChatState.conversationId) await refreshLiveChatMessages();
      return undefined;
    case 'tab-conversations': return loadConversations();
    case 'tab-queue': return loadQueue();
    case 'tab-responses':
      await Promise.allSettled([loadResponseControl(), loadResponseJobs(), loadResponseHistory()]);
      return undefined;
    case 'tab-scheduled': return loadScheduled();
    case 'tab-messages': return loadMessages();
    case 'tab-logs': return loadLogs();
    default: return undefined;
  }
}

function switchTab(tabId) {
  state.activeTab = tabId;
  $$('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== tabId));
  refreshActiveTab();
}

async function silentRefresh() {
  if (!getToken() || state.refreshing || document.hidden) return;
  state.refreshing = true;
  try {
    await refreshActiveTab();
    updateKpis();
    touchUpdated();
  } finally {
    state.refreshing = false;
  }
}

// ---------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------
function bindEvents() {
  // Login / logout
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#btn-login');
    const errorEl = $('#login-error');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
    button.disabled = true;
    button.textContent = 'Entrando…';

    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        skipAuthRedirect: true,
        body: JSON.stringify({
          email: $('#login-email').value.trim(),
          password: $('#login-password').value,
        }),
      });
      if (!data?.token) throw new Error('Respuesta de login inválida');
      localStorage.setItem(TOKEN_KEY, data.token);
      state.user = data.user || null;
      $('#login-form').reset();
      showApp();
      if (state.user) renderUser();
    } catch (err) {
      errorEl.textContent = err.message || 'No se pudo iniciar sesión';
      errorEl.classList.remove('hidden');
    } finally {
      button.disabled = false;
      button.textContent = 'Entrar';
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      /* el logout local se hace igual */
    }
    logout();
  });

  // Tema
  $('#btn-theme').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'light' ? 'dark' : 'light');
  });

  // Actualizar todo
  $('#btn-refresh').addEventListener('click', async () => {
    const button = $('#btn-refresh');
    button.disabled = true;
    await refreshAll();
    button.disabled = false;
    toast('Datos actualizados', 'success', 2200);
  });

  // Pestañas
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Botones "Actualizar" de cada sección
  $$('[data-refresh]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.refresh;
      btn.disabled = true;
      try {
        if (target === 'customers') await loadCustomers();
        else if (target === 'chat') await loadLiveChats();
        else if (target === 'conversations') await loadConversations();
        else if (target === 'queue') await loadQueue();
        else if (target === 'scheduled') await loadScheduled();
        else if (target === 'messages') await loadMessages();
        else if (target === 'logs') await loadLogs();
        else if (target === 'responses') {
          await Promise.allSettled([loadResponseControl(), loadResponseJobs(), loadResponseHistory()]);
        } else if (target === 'response-jobs') await loadResponseJobs();
        touchUpdated();
        toast('Sección actualizada', 'success', 1800);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Automatización
  $$('[data-automation]').forEach((btn) => {
    btn.addEventListener('click', () => runAutomationAction(btn.dataset.automation));
  });

  // WhatsApp
  $('#btn-qr').addEventListener('click', connectWhatsapp);
  $('#btn-disconnect').addEventListener('click', disconnectWhatsapp);

  // Clientes
  $('#form-customer').addEventListener('submit', createCustomer);
  $('#search-customers').addEventListener('input', debounce((event) => {
    state.filters.customers = event.target.value;
    renderCustomers();
  }, 180));

  // Filtros
  $('#filter-conversations').addEventListener('change', (event) => {
    state.filters.conversations = event.target.value;
    renderConversations();
  });
  $('#filter-queue').addEventListener('change', (event) => {
    state.filters.queue = event.target.value;
    renderQueue();
  });
  $('#filter-scheduled').addEventListener('change', (event) => {
    state.filters.scheduled = event.target.value;
    renderScheduled();
  });
  $('#filter-messages').addEventListener('change', (event) => {
    state.filters.messages.direction = event.target.value;
    renderMessages();
  });
  $('#search-messages').addEventListener('input', debounce((event) => {
    state.filters.messages.q = event.target.value;
    renderMessages();
  }, 180));
  $('#filter-logs').addEventListener('change', (event) => {
    state.filters.logs.level = event.target.value;
    renderLogs();
  });
  $('#search-logs').addEventListener('input', debounce((event) => {
    state.filters.logs.q = event.target.value;
    renderLogs();
  }, 180));

  // Control de respuestas automaticas
  $('#form-response').addEventListener('submit', saveResponseSettings);
  $$('[data-response-action]').forEach((btn) => {
    btn.addEventListener('click', () => runResponseAction(btn.dataset.responseAction));
  });
  $('#filter-response-jobs').addEventListener('change', (event) => {
    state.filters.responseJobs = event.target.value;
    loadResponseJobs();
  });
  $('#table-response-jobs tbody').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-job-action]');
    if (btn && btn.dataset.jobAction === 'retry') retryResponseJob(btn.dataset.id);
  });
  $('#table-customers tbody').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-customer-response]');
    if (btn) openCustomerResponse(btn.dataset.customerResponse);
  });
  $('#form-customer-response').addEventListener('submit', saveCustomerResponse);
  $$('#customer-modal [data-cust-response]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.custResponse;
      if (action === 'reset') resetCustomerResponse();
      else changeCustomerHuman(action);
    });
  });
  $$('[data-close-customer-modal]').forEach((node) => node.addEventListener('click', closeCustomerModal));

  // Cola
  $$('[data-queue]').forEach((btn) => {
    btn.addEventListener('click', () => runQueueAction(btn.dataset.queue));
  });

  // Programados
  $('#form-scheduled').addEventListener('submit', createScheduledMessage);
  $('#sched-customer').addEventListener('change', (event) => {
    const customer = customerById(event.target.value);
    if (customer) $('#sched-phone').value = customer.phone;
  });

  // Acciones de tablas (delegación)
  $('#table-conversations tbody').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-conv-action]');
    if (btn) handleConversationAction(btn.dataset.convAction, btn.dataset.id);
  });

  $('#table-scheduled tbody').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-sched-action]');
    if (btn && btn.dataset.schedAction === 'cancel') cancelScheduledMessage(btn.dataset.id);
  });

  // Modal
  $$('[data-close-modal]').forEach((node) => node.addEventListener('click', closeModal));
  $('#modal-actions').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-modal-action]');
    if (!btn || !state.modalConversationId) return;
    const action = btn.dataset.modalAction;
    if (action === 'close' && !window.confirm('¿Cerrar esta conversación?')) return;
    try {
      if (action === 'release') {
        await apiFetch(`/api/response-control/conversations/${state.modalConversationId}/release`, { method: 'POST', body: JSON.stringify({}) });
        toast('Bot reactivado en la conversación', 'success');
        await loadConversations();
        const conversation = state.conversations.find((c) => String(c.id) === String(state.modalConversationId));
        if (conversation) updateModalHeader(conversation);
        return;
      }
      await updateConversation(state.modalConversationId, action === 'human' ? 'HUMAN' : 'CLOSED');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#customer-modal').classList.contains('hidden')) closeCustomerModal();
    else if (!$('#modal').classList.contains('hidden')) closeModal();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && getToken()) silentRefresh();
  });
}

// ---------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------
function init() {
  initTheme();
  bindEvents();
  resetScheduleDate();
  renderUser();
  setInterval(updateLastUpdated, 1000);
  setInterval(silentRefresh, 20000);

  // El chat en vivo se refresca cada 5 s mientras su pestaña está visible.
  setInterval(() => {
    if (state.activeTab !== 'tab-chat' || document.hidden) return;
    liveChatState.tick += 1;
    if (liveChatState.tick % 3 === 1) loadLiveChats();
    refreshLiveChatMessages();
  }, 5000);

  if (getToken()) {
    showApp();
  } else {
    showLogin();
  }
}

init();
