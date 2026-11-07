// WhatsApp Pro Suite — logica de las vistas nuevas.
// Complementa app.js (que sigue siendo el dueno de chat, cola, clientes,
// programados, logs y estado). Aqui van: tema claro/oscuro, dashboard con
// KPIs reales, campanas masivas (constructor + lista), reglas de chatbot
// (CRUD + probador), extras de contactos (busqueda/filtros/modales) y los
// botones del topbar. Reutiliza las globals de app.js: esc, apiFetch,
// getAuthToken, API_BASE, fmtDate, loadCustomers, refreshAll.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------
  function toast(message, type = 'success') {
    const t = $('toast');
    if (!t) return;
    t.textContent = message;
    t.className = `toast ${type}`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add('hidden'), 3600);
  }

  // ---------------------------------------------------------------------
  // Tema claro / oscuro (html.dark; se persiste en wa_theme)
  // ---------------------------------------------------------------------
  const themeBtn = $('btn-theme');
  function syncThemeIcon() {
    if (!themeBtn) return;
    const dark = document.documentElement.classList.contains('dark');
    themeBtn.textContent = dark ? '☀️' : '🌙';
    themeBtn.title = dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
  }
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('wa_theme', dark ? 'dark' : 'light'); } catch (err) { /* noop */ }
      syncThemeIcon();
      enforceBodyBg();
    });
    syncThemeIcon();
    enforceBodyBg();
  }

  // Algunas extensiones de "modo oscuro" pintan el body con !important y
  // ignoran el tema de la pagina. Un inline !important les gana y usa la
  // misma variable del tema activo (no-op visual en navegadores limpios).
  function enforceBodyBg() {
    document.body.style.setProperty('background', 'var(--bg)', 'important');
  }

  // ---------------------------------------------------------------------
  // Navegacion: breadcrumbs + cargas perezosas + botones data-tab externos
  // ---------------------------------------------------------------------
  const CRUMBS = {
    'tab-dashboard': 'Panel de Control / Resumen General',
    'tab-campaigns': 'Difusión Masiva / Editor de Campañas',
    'tab-bot': 'Automatizaciones / Chatbot de Respuestas',
    'tab-customers': 'Audiencias / Base de Contactos',
    'tab-products': 'Ventas / Catálogo de Productos',
    'tab-chat': 'Mensajería / Chats en Directo',
    'tab-conversations': 'Mensajería / Historial de Conversaciones',
    'tab-qr': 'Instancia / Conexión WhatsApp Web',
    'tab-queue': 'Sistema / Cola de Envíos',
    'tab-scheduled': 'Sistema / Mensajes Programados',
    'tab-logs': 'Sistema / Registros',
  };

  function activateTab(tabId) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    if (btn) btn.click(); // app.js activa el panel y sus cargas
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const crumb = $('crumb-view');
      if (crumb) crumb.textContent = CRUMBS[btn.dataset.tab] || 'WhatsApp Pro';
      if (btn.dataset.tab === 'tab-dashboard') loadStats();
      if (btn.dataset.tab === 'tab-campaigns') { loadCampaigns(); ensureAudienceList(); }
      if (btn.dataset.tab === 'tab-bot') loadRules();
    });
  });

  // Elementos con data-tab fuera del sidebar: marca, topbar, "Ver todas".
  document.querySelectorAll('[data-tab]:not(.tab-btn)').forEach((el) => {
    el.addEventListener('click', () => activateTab(el.dataset.tab));
  });

  // ---------------------------------------------------------------------
  // Topbar: refresco manual + boton primario contextual (QR o campana)
  // ---------------------------------------------------------------------
  const btnRefresh = $('btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      btnRefresh.classList.add('spin');
      try { refreshAll(); } catch (err) { /* app.js aun no listo */ }
      loadStats();
      loadCampaigns();
      loadRules();
      setTimeout(() => btnRefresh.classList.remove('spin'), 900);
      toast('Datos sincronizados', 'info');
    });
  }

  // El boton primario depende del estado REAL de WhatsApp: si hay sesion,
  // invita a crear una campana; si no, a vincular.
  let waConnected = false;
  function syncPrimaryButton() {
    const badge = $('status-whatsapp');
    waConnected = (badge ? badge.textContent : '') === 'CONECTADO';
    const btn = $('btn-primary');
    if (!btn) return;
    if (waConnected) {
      btn.textContent = '✈️ Nueva Campaña';
      btn.dataset.tab = 'tab-campaigns';
      btn.classList.remove('btn-amber');
    } else {
      btn.textContent = '🔗 Vincular WhatsApp';
      btn.dataset.tab = 'tab-qr';
      btn.classList.add('btn-amber');
    }
  }
  setInterval(syncPrimaryButton, 4000);
  syncPrimaryButton();

  // ---------------------------------------------------------------------
  // Dashboard: KPIs + grafico semanal + cola (todo desde /api/dashboard/stats)
  // ---------------------------------------------------------------------
  let statsTimer = null;

  function updateSidebarQueue(pending) {
    const num = $('sb-queue-num');
    if (num) num.textContent = String(pending);
    const fill = $('sb-queue-fill');
    if (fill) fill.style.width = `${Math.min(100, Math.round((pending / 50) * 100))}%`;
  }

  function renderChart(week) {
    const body = $('dash-chart-body');
    if (!body) return;
    if (!week || !week.length) {
      body.innerHTML = '<p class="empty-note">Aún no hay actividad registrada.</p>';
      return;
    }
    const max = Math.max(1, ...week.map((d) => Math.max(Number(d.sent || 0), Number(d.received || 0))));
    body.innerHTML = week
      .map((d) => {
        const dt = new Date(`${d.day}T12:00:00`);
        const label = Number.isNaN(dt.getTime())
          ? String(d.day).slice(5)
          : dt.toLocaleDateString('es-PE', { weekday: 'short' });
        const hOut = Math.max(2, Math.round(((Number(d.sent) || 0) / max) * 118));
        const hIn = Math.max(2, Math.round(((Number(d.received) || 0) / max) * 118));
        const nums = [];
        if (Number(d.sent) > 0) nums.push(`<span>${Number(d.sent)}➤</span>`);
        if (Number(d.received) > 0) nums.push(`<span>${Number(d.received)}↩</span>`);
        return `<div class="chart-col">
          <div class="chart-nums">${nums.join('')}</div>
          <div class="chart-bars">
            <div class="chart-bar out" style="height:${hOut}px" title="Enviados: ${Number(d.sent) || 0}"></div>
            <div class="chart-bar in" style="height:${hIn}px" title="Recibidos: ${Number(d.received) || 0}"></div>
          </div>
          <span class="chart-day">${esc(label)}</span>
        </div>`;
      })
      .join('');
  }

  async function loadStats() {
    try {
      const s = await apiFetch('/api/dashboard/stats');
      const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
      set('kpi-sent', s.totals.sent ?? '—');
      set('kpi-response', s.totals.responseRate == null ? '—' : `${s.totals.responseRate}%`);
      set('kpi-chats', s.activeChats24h ?? '—');
      set('kpi-contacts', s.contactsActive ?? '—');
      set('sys-queue-num', s.queuePending ?? 0);
      const note = $('sys-queue-note');
      if (note) note.textContent = (s.queuePending || 0) === 1 ? 'mensaje pendiente de envío' : 'mensajes pendientes de envío';
      renderChart(s.week || []);
      updateSidebarQueue(s.queuePending || 0);
      await loadCampaigns();
    } catch (err) {
      const body = $('dash-chart-body');
      if (body) body.innerHTML = `<p class="empty-note">No se pudieron cargar las métricas: ${esc(err.message)}</p>`;
    }
  }

  // ---------------------------------------------------------------------
  // Campanas masivas
  // ---------------------------------------------------------------------
  const MAX_RECIPIENTS = 500;
  const camp = { customers: [], loaded: false, selected: new Set() };

  async function ensureAudienceList() {
    if (camp.loaded) return;
    try {
      camp.customers = await apiFetch('/api/customers?limit=200');
      camp.loaded = true;
      renderAudienceList();
      updateAudienceSummary();
      updatePreview();
    } catch (err) {
      toast(`No se pudieron cargar los contactos: ${err.message}`, 'error');
    }
  }

  function renderAudienceList() {
    const box = $('cp-list');
    if (!box) return;
    const q = (($('cp-list-search') || {}).value || '').trim().toLowerCase();
    const visibles = camp.customers.filter((c) => {
      if (!q) return true;
      return String(c.name || '').toLowerCase().includes(q) || String(c.phone || '').includes(q);
    });
    box.innerHTML =
      visibles
        .map(
          (c) => `<label class="cp-list-item">
            <input type="checkbox" data-cp-cust="${esc(c.id)}" ${camp.selected.has(Number(c.id)) ? 'checked' : ''} />
            <span>${esc(c.name || 'Sin nombre')}</span>
            <span class="ph">${esc(c.phone)}</span>
          </label>`
        )
        .join('') || '<p class="empty-note">Sin resultados.</p>';
    box.querySelectorAll('[data-cp-cust]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const id = Number(chk.dataset.cpCust);
        if (chk.checked) camp.selected.add(id);
        else camp.selected.delete(id);
        updateAudienceSummary();
        updatePreview();
      });
    });
  }

  function audienceFilter() {
    const rows = document.querySelectorAll('#cp-filter-box .chk-row');
    const statuses = Array.from(rows[0] ? rows[0].querySelectorAll('input:checked') : []).map((i) => i.value);
    const interests = Array.from(rows[1] ? rows[1].querySelectorAll('input:checked') : []).map((i) => i.value);
    return { statuses, interests };
  }

  function updateAudienceSummary() {
    const sum = $('cp-aud-sum');
    const mode = ($('cp-mode') || {}).value || 'ALL';
    if (!sum) return;
    let label = '';
    if (mode === 'ALL') {
      const n = camp.customers.filter((c) => c.status === 'ACTIVE').length;
      label = camp.loaded
        ? `Audiencia: todos los contactos activos (${n} aprox., tope ${MAX_RECIPIENTS})`
        : 'Audiencia: todos los contactos activos';
    } else if (mode === 'FILTER') {
      const { statuses, interests } = audienceFilter();
      const n = camp.customers.filter((c) => {
        const okS = statuses.length ? statuses.includes(c.status) : c.status === 'ACTIVE';
        const okI = interests.length ? interests.includes(c.interest_type) : true;
        return okS && okI;
      }).length;
      label = camp.loaded ? `Audiencia según filtro: ${n} aprox.` : 'Audiencia según filtro';
    } else {
      label = `Audiencia manual: ${camp.selected.size} seleccionados`;
    }
    sum.textContent = label;
  }

  // Vista previa tipo WhatsApp: *negrita*, _cursiva_ y variables sustituidas.
  function fmtWhatsApp(text) {
    return esc(text)
      .replace(/\*(.+?)\*/g, '<span class="wbold">$1</span>')
      .replace(/_(.+?)_/g, '<span class="wital">$1</span>');
  }

  function updatePreview() {
    const el = $('cp-preview');
    if (!el) return;
    let msg = ($('cp-message') || {}).value || '';
    if (!msg.trim()) {
      el.textContent = 'Escribe el mensaje para ver la vista previa...';
      return;
    }
    const sample =
      camp.customers.find((c) => camp.selected.has(Number(c.id))) || camp.customers[0] || null;
    msg = msg
      .replace(/\{\{\s*nombre\s*\}\}/gi, sample ? sample.name || 'sin nombre' : 'Juan Pérez')
      .replace(/\{\{\s*telefono\s*\}\}/gi, sample ? sample.phone : '51900000000');
    el.innerHTML = fmtWhatsApp(msg);
  }

  function updateCharCount() {
    const el = $('cp-count');
    if (el) el.textContent = `${(($('cp-message') || {}).value || '').length} / 4096`;
  }

  function renderCampaignItem(c) {
    const total = Number(c.total || 0);
    const sent = Number(c.sent || 0);
    const failed = Number(c.failed || 0);
    const pending = Number(c.pending || 0);
    const pct = total > 0 ? Math.min(100, Math.round(((sent + failed) / total) * 100)) : 0;
    const badge =
      c.status === 'COMPLETED'
        ? '<span class="badge-inline completed">Completada</span>'
        : c.status === 'SENDING'
          ? '<span class="badge-inline sending">Enviando</span>'
          : `<span class="badge-inline draft">${esc(c.status)}</span>`;
    return `<div class="camp-item">
      <div class="camp-item-top">
        <div style="min-width:0">
          <div class="camp-item-name">${esc(c.name)}</div>
          <div class="camp-item-msg">${esc(c.message)}</div>
        </div>
        <div class="camp-item-actions">
          ${badge}
          <button class="camp-del" data-camp-del="${esc(c.id)}" title="Eliminar campaña">🗑️</button>
        </div>
      </div>
      <div class="camp-progress"><div style="width:${pct}%"></div></div>
      <div class="camp-item-stats">
        <span>${total} dest. · ✓ ${sent} · ✗ ${failed}${pending ? ` · ⏳ ${pending}` : ''}</span>
        <span>${esc(fmtDate(c.createdAt))}</span>
      </div>
    </div>`;
  }

  let lastCampaigns = [];

  async function loadCampaigns() {
    const listBox = $('campaigns-list');
    const recentBox = $('campaigns-recent');
    try {
      lastCampaigns = await apiFetch('/api/campaigns');
      if (listBox) {
        listBox.innerHTML =
          lastCampaigns.map(renderCampaignItem).join('') ||
          '<p class="empty-note">Aún no hay campañas. Crea la primera con el constructor.</p>';
      }
      if (recentBox) {
        recentBox.innerHTML =
          lastCampaigns.slice(0, 3).map(renderCampaignItem).join('') ||
          '<p class="empty-note">Sin campañas todavía. Lanza la primera desde Campañas Masivas.</p>';
      }
    } catch (err) {
      if (listBox) listBox.innerHTML = `<p class="empty-note">Error: ${esc(err.message)}</p>`;
      if (recentBox) recentBox.innerHTML = '<p class="empty-note">Sin datos de campañas.</p>';
    }
  }

  async function sendCampaign() {
    const name = ($('cp-name') || {}).value || '';
    const message = ($('cp-message') || {}).value || '';
    const mode = ($('cp-mode') || {}).value || 'ALL';
    if (!name.trim()) return toast('Ponle un nombre a la campaña', 'error');
    if (!message.trim()) return toast('Escribe el mensaje de la campaña', 'error');

    const audience = { mode };
    if (mode === 'FILTER') {
      const { statuses, interests } = audienceFilter();
      if (!statuses.length) return toast('Marca al menos un estado en el filtro', 'error');
      audience.statuses = statuses;
      if (interests.length) audience.interestTypes = interests;
    } else if (mode === 'LIST') {
      if (!camp.selected.size) return toast('Selecciona al menos un contacto', 'error');
      audience.customerIds = Array.from(camp.selected);
    }

    const btn = $('cp-send');
    btn.disabled = true;
    btn.textContent = '⏳ Encolando...';
    try {
      const r = await apiFetch('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), message: message.trim(), audience }),
      });
      toast(`Campaña creada: ${r.total} mensajes en cola de salida`);
      $('cp-name').value = '';
      $('cp-message').value = '';
      camp.selected.clear();
      renderAudienceList();
      updateCharCount();
      updatePreview();
      updateAudienceSummary();
      loadCampaigns();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '✈️ Lanzar campaña';
    }
  }

  function bindCampaigns() {
    const mode = $('cp-mode');
    if (mode) {
      mode.addEventListener('change', () => {
        const isFilter = mode.value === 'FILTER';
        const isList = mode.value === 'LIST';
        const fb = $('cp-filter-box');
        const lb = $('cp-list-box');
        if (fb) fb.classList.toggle('hidden', !isFilter);
        if (lb) lb.classList.toggle('hidden', !isList);
        if (isList) ensureAudienceList();
        updateAudienceSummary();
      });
    }
    const msg = $('cp-message');
    if (msg) msg.addEventListener('input', () => { updateCharCount(); updatePreview(); });
    const search = $('cp-list-search');
    if (search) search.addEventListener('input', renderAudienceList);
    document.querySelectorAll('[data-cpvar]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const ta = $('cp-message');
        if (!ta) return;
        const v = `{{${chip.dataset.cpvar}}}`;
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? start;
        ta.value = ta.value.slice(0, start) + v + ta.value.slice(end);
        ta.dispatchEvent(new Event('input'));
        ta.focus();
      });
    });
    const send = $('cp-send');
    if (send) send.addEventListener('click', sendCampaign);
    const reload = $('cp-reload');
    if (reload) reload.addEventListener('click', loadCampaigns);
    // Delegacion de borrado (la lista se vuelve a renderizar)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-camp-del]');
      if (!btn) return;
      if (!window.confirm('¿Eliminar esta campaña? Los mensajes pendientes se cancelan (los ya enviados no se tocan).')) return;
      try {
        await apiFetch(`/api/campaigns/${btn.dataset.campDel}`, { method: 'DELETE' });
        toast('Campaña eliminada', 'info');
        loadCampaigns();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  bindCampaigns();

  // ---------------------------------------------------------------------
  // Reglas de chatbot (CRUD + probador)
  // ---------------------------------------------------------------------
  async function loadRules() {
    const tbody = document.querySelector('#table-rules tbody');
    if (!tbody) return;
    try {
      const rules = await apiFetch('/api/bot-rules');
      tbody.innerHTML =
        rules
          .map((r) => {
            const reply = String(r.reply || '');
            const corto = reply.length > 90 ? `${reply.slice(0, 90)}…` : reply;
            return `<tr>
              <td><strong>${esc(r.keyword)}</strong></td>
              <td><span class="badge-inline ${r.active ? 'active' : 'inactive'}">${esc(r.triggerType)}</span></td>
              <td style="max-width:280px">${esc(corto)}</td>
              <td class="mono">${esc(r.timesTriggered)}</td>
              <td><button class="rule-toggle" data-rule-toggle="${esc(r.id)}" data-active="${r.active ? '1' : '0'}" title="${r.active ? 'Desactivar regla' : 'Activar regla'}">${r.active ? '🟢' : '⚪'}</button></td>
              <td><button class="rule-del" data-rule-del="${esc(r.id)}" title="Eliminar regla">🗑️</button></td>
            </tr>`;
          })
          .join('') || '<tr><td colspan="6" style="text-align:center">Sin reglas todavía: crea la primera arriba.</td></tr>';

      tbody.querySelectorAll('[data-rule-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await apiFetch(`/api/bot-rules/${btn.dataset.ruleToggle}`, {
              method: 'PATCH',
              body: JSON.stringify({ active: btn.dataset.active !== '1' }),
            });
            loadRules();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
      tbody.querySelectorAll('[data-rule-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!window.confirm('¿Eliminar esta regla del chatbot?')) return;
          try {
            await apiFetch(`/api/bot-rules/${btn.dataset.ruleDel}`, { method: 'DELETE' });
            toast('Regla eliminada', 'info');
            loadRules();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  async function createRule() {
    const keyword = ($('rule-keyword') || {}).value || '';
    const reply = ($('rule-reply') || {}).value || '';
    const triggerType = ($('rule-type') || {}).value || 'CONTAINS';
    const priority = parseInt(($('rule-priority') || {}).value, 10);
    if (!keyword.trim()) return toast('Escribe la palabra clave que dispara la regla', 'error');
    if (!reply.trim()) return toast('Escribe la respuesta automática', 'error');
    const btn = $('rule-add');
    btn.disabled = true;
    try {
      await apiFetch('/api/bot-rules', {
        method: 'POST',
        body: JSON.stringify({
          keyword: keyword.trim(),
          reply: reply.trim(),
          triggerType,
          ...(Number.isInteger(priority) ? { priority } : {}),
        }),
      });
      toast('Regla creada: el bot responderá antes que la IA');
      $('rule-keyword').value = '';
      $('rule-reply').value = '';
      loadRules();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function runBotTest() {
    const text = (($('bot-test-input') || {}).value || '').trim();
    const out = $('bot-test-result');
    if (!out) return;
    if (!text) return toast('Escribe un mensaje de prueba', 'error');
    out.classList.remove('hidden');
    out.innerHTML = '<em>Probando contra las reglas activas...</em>';
    try {
      const r = await apiFetch('/api/bot-rules/test', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (r.matched && r.rule) {
        out.innerHTML = `<span class="matched">✓ Coincide con la regla "${esc(r.rule.keyword)}" (${esc(r.rule.triggerType)})</span>${esc(r.rule.reply)}`;
      } else {
        out.innerHTML = '<span class="nomatch">Sin coincidencia</span>Ninguna regla activa aplica: respondería la IA (si está habilitada) o la plantilla interna.';
      }
    } catch (err) {
      out.innerHTML = `<span class="nomatch">Error</span>${esc(err.message)}`;
    }
  }

  function bindRules() {
    const add = $('rule-add');
    if (add) add.addEventListener('click', createRule);
    const run = $('bot-test-run');
    if (run) run.addEventListener('click', runBotTest);
    const testInput = $('bot-test-input');
    if (testInput) {
      testInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runBotTest();
      });
    }
  }
  bindRules();

  // ---------------------------------------------------------------------
  // Contactos: busqueda + filtros client-side sobre la tabla de app.js
  // ---------------------------------------------------------------------
  function filterCustomerRows() {
    const q = (($('cust-search') || {}).value || '').trim().toLowerCase();
    const status = ($('cust-filter-status') || {}).value || 'ALL';
    const interest = ($('cust-filter-interest') || {}).value || 'ALL';
    document.querySelectorAll('#table-customers tbody tr').forEach((tr) => {
      const cells = tr.cells;
      if (!cells || cells.length < 5) return;
      const okQ = !q || tr.textContent.toLowerCase().includes(q);
      const okS = status === 'ALL' || cells[3].textContent.trim() === status;
      const okI = interest === 'ALL' || cells[4].textContent.trim() === interest;
      tr.style.display = okQ && okS && okI ? '' : 'none';
    });
  }
  (function bindContacts() {
    const search = $('cust-search');
    const fStatus = $('cust-filter-status');
    const fInterest = $('cust-filter-interest');
    if (search) search.addEventListener('input', filterCustomerRows);
    if (fStatus) fStatus.addEventListener('change', filterCustomerRows);
    if (fInterest) fInterest.addEventListener('change', filterCustomerRows);
  })();

  // ---------------------------------------------------------------------
  // Modales: nuevo contacto + importacion CSV
  // ---------------------------------------------------------------------
  function openModal(id) { const m = $(id); if (m) m.classList.remove('hidden'); }
  function closeModal(id) { const m = $(id); if (m) m.classList.add('hidden'); }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.classList.add('hidden');
    });
  });

  async function afterCustomersChanged() {
    camp.loaded = false;
    try { loadCustomers(); } catch (err) { /* app.js aun no listo */ }
    ensureAudienceList();
  }

  const btnSaveContact = $('contact-save');
  if (btnSaveContact) {
    btnSaveContact.addEventListener('click', async () => {
      const phone = (($('contact-phone') || {}).value || '').trim();
      const name = (($('contact-name') || {}).value || '').trim();
      if (!phone) return toast('El teléfono (con código país) es obligatorio', 'error');
      btnSaveContact.disabled = true;
      try {
        await apiFetch('/api/customers', {
          method: 'POST',
          body: JSON.stringify(name ? { phone, name } : { phone }),
        });
        toast('Contacto creado');
        closeModal('modal-contact');
        afterCustomersChanged();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btnSaveContact.disabled = false;
      }
    });
  }

  const btnNew = $('btn-cust-new');
  if (btnNew) {
    btnNew.addEventListener('click', () => {
      $('contact-phone').value = '';
      $('contact-name').value = '';
      openModal('modal-contact');
      setTimeout(() => $('contact-phone').focus(), 50);
    });
  }

  const btnCsv = $('btn-cust-csv');
  if (btnCsv) {
    btnCsv.addEventListener('click', () => {
      $('csv-file').value = '';
      const p = $('csv-progress');
      if (p) { p.classList.add('hidden'); p.innerHTML = ''; }
      openModal('modal-csv');
    });
  }

  // CSV simple: phone,name por linea (separador coma, ; o tab). Importacion
  // secuencial y amable con el rate limit de la API (120 req/min).
  function parseCsv(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => line.split(/[,;\t]/).map((p) => p.trim().replace(/^"|"$/g, '')))
      .filter((parts) => parts[0] && !/^phone$/i.test(parts[0]))
      .map((parts) => ({ phone: parts[0], name: parts[1] || '' }));
  }

  const csvFile = $('csv-file');
  if (csvFile) {
    csvFile.addEventListener('change', async () => {
      const file = csvFile.files && csvFile.files[0];
      const progress = $('csv-progress');
      if (!file || !progress) return;
      const rows = parseCsv(await file.text());
      if (!rows.length) {
        progress.classList.remove('hidden');
        progress.innerHTML = '⚠️ No se encontraron filas válidas. Usa el formato: <span class="mono">phone,name</span>';
        return;
      }
      progress.classList.remove('hidden');
      let ok = 0;
      let fail = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        progress.innerHTML = `⏳ Importando ${i + 1} de ${rows.length}... (✅ ${ok} · ⚠️ ${fail})`;
        try {
          await apiFetch('/api/customers', {
            method: 'POST',
            body: JSON.stringify(r.name ? { phone: r.phone, name: r.name } : { phone: r.phone }),
          });
          ok += 1;
        } catch (err) {
          fail += 1;
        }
        await sleep(400);
      }
      progress.innerHTML = `✅ Importación terminada: ${ok} creados${fail ? `, ${fail} omitidos (duplicados o inválidos)` : ''}`;
      toast(`CSV importado: ${ok} contactos nuevos`);
      afterCustomersChanged();
    });
  }

  // ---------------------------------------------------------------------
  // Arranque y refresco periodico del dashboard (60 s si esta visible)
  // ---------------------------------------------------------------------
  if (getAuthToken()) loadStats();
  // Al iniciar sesion (#app deja de estar oculto) se cargan KPIs y botones
  const appEl = $('app');
  if (appEl && 'MutationObserver' in window) {
    new MutationObserver(() => {
      if (!appEl.classList.contains('hidden')) {
        loadStats();
        syncPrimaryButton();
      }
    }).observe(appEl, { attributes: true, attributeFilter: ['class'] });
  }
  statsTimer = setInterval(() => {
    const dash = $('tab-dashboard');
    if (dash && !dash.classList.contains('hidden') && getAuthToken()) loadStats();
  }, 60000);
})();
