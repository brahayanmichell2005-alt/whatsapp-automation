(() => {
  if (window.__micierroCrmLoaded) return;
  window.__micierroCrmLoaded = true;

  const host = document.createElement('div');
  host.id = 'micierro-crm-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const state = { open: false, customer: null, record: null, records: {}, search: '', view: 'contact', autoReply: false, apiConnected: false };

  root.innerHTML = `
    <style>
      :host{all:initial;color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf5ef;font-size:13px;line-height:1.4}
      *{box-sizing:border-box}button,input,textarea,select{font:inherit}button{cursor:pointer}
      .launcher{position:fixed;z-index:2147483000;right:18px;bottom:22px;width:52px;height:52px;border:1px solid #dfff9a;border-radius:18px;background:#c7f36b;color:#172112;box-shadow:0 8px 28px #0005;display:grid;place-items:center;font-size:20px;font-weight:900;transition:transform .2s,box-shadow .2s}
      .launcher:hover{transform:translateY(-2px);box-shadow:0 12px 32px #0007}.launcher em{position:absolute;right:-2px;top:-3px;width:11px;height:11px;border:2px solid #fff;background:#59c77e;border-radius:50%}
      .panel{position:fixed;z-index:2147483001;right:0;top:0;height:100vh;width:min(365px,calc(100vw - 24px));background:#101916;border-left:1px solid #2b3a30;box-shadow:-18px 0 55px #0004;display:flex;flex-direction:column;transform:translateX(105%);transition:transform .24s ease;overflow:hidden}
      .panel.open{transform:translateX(0)}.top{padding:17px 18px 14px;background:#151f19;border-bottom:1px solid #26342b;display:flex;align-items:center;gap:11px}
      .logo{height:36px;width:36px;display:grid;place-items:center;border-radius:12px;background:#c7f36b;color:#152111;font-size:17px;font-weight:900}.title{flex:1}.title b{display:block;font-size:14px;letter-spacing:.1px}.title small{display:block;color:#859389;font-size:10px;margin-top:2px}.icon{height:30px;width:30px;border:0;border-radius:9px;background:transparent;color:#acb8ad;font-size:18px}.icon:hover{background:#26342b;color:#fff}
      .tabs{display:flex;gap:5px;padding:12px 16px 0}.tab{border:1px solid #2b3930;color:#9aa99e;background:transparent;border-radius:9px;padding:7px 10px;font-size:11px}.tab.active{background:#243228;color:#d6f39a;border-color:#354a36}
      .scroll{overflow:auto;padding:15px 17px 22px;flex:1}.section-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#87948a;font-weight:700;margin:1px 0 11px}.profile{padding:14px;border:1px solid #2b3930;border-radius:15px;background:linear-gradient(135deg,#1a271e,#151d18);margin-bottom:18px}.profile-head{display:flex;align-items:center;gap:11px}.avatar{height:43px;width:43px;border-radius:14px;background:#32442d;color:#d3f789;display:grid;place-items:center;font-size:17px;font-weight:700}.name{min-width:0;flex:1}.name strong{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.name small{display:block;color:#89988d;font-size:11px;margin-top:3px}.badge{font-size:9px;padding:4px 7px;border-radius:99px;background:#283b28;color:#caee83;white-space:nowrap}
      label{display:block;color:#9ba99e;font-size:10px;font-weight:650;margin:14px 0 6px}.field,textarea,select{width:100%;border:1px solid #2a3930;border-radius:10px;background:#141e18;color:#eaf3e9;padding:10px 11px;outline:none}.field:focus,textarea:focus,select:focus{border-color:#88b64d}.field::placeholder,textarea::placeholder{color:#65736a}textarea{resize:vertical;min-height:76px}.status-row{display:flex;gap:7px;flex-wrap:wrap}.status-chip,.tag{border:1px solid #344338;background:#1a251e;color:#bac7bc;border-radius:99px;padding:6px 9px;font-size:10px}.status-chip.active{background:#324326;border-color:#779c45;color:#dbf5a1}.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.tag{padding:5px 8px}.tag button{border:0;background:none;color:inherit;margin-left:4px;padding:0}.addtag{display:flex;gap:6px}.addtag input{flex:1;min-width:0}.smallbtn{border:1px solid #43553d;border-radius:9px;background:#263825;color:#d9f49d;padding:8px 10px;font-size:10px;font-weight:700}.save{width:100%;margin-top:16px;border:0;border-radius:10px;background:#c7f36b;color:#14200f;padding:11px;font-size:12px;font-weight:800}.save:hover{background:#d8ff8c}.muted{color:#819087;font-size:10px}.divider{height:1px;background:#253129;margin:18px 0}.empty{padding:24px 13px;border:1px dashed #334138;border-radius:13px;color:#91a096;text-align:center;font-size:11px}.row{padding:12px 10px;margin:6px 0;border:1px solid #2b3930;border-radius:11px;background:#17211b;cursor:pointer}.row:hover{border-color:#759747}.row strong{font-size:12px}.row small{display:block;color:#87958a;margin-top:4px;font-size:10px}.search{margin-bottom:10px}.subhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.count{color:#a3b48e;font-size:10px}
      .toast{position:fixed;z-index:2147483002;bottom:87px;right:20px;background:#243228;border:1px solid #41583e;border-radius:10px;padding:10px 13px;color:#e3f5d0;font-size:11px;box-shadow:0 8px 24px #0005;animation:fade 2.5s forwards}@keyframes fade{0%,75%{opacity:1}100%{opacity:0}}
      .toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid #2b3930;background:#17211b;border-radius:12px;margin:14px 0}.toggle-row span strong,.toggle-row span small{display:block}.toggle-row span strong{font-size:11px;color:#e5eee5}.toggle-row span small{font-size:9px;color:#859389;margin-top:3px}.toggle-row input{appearance:none;width:38px;height:21px;border-radius:20px;background:#3b4940;position:relative;cursor:pointer;flex:none}.toggle-row input:before{content:"";position:absolute;width:15px;height:15px;left:3px;top:3px;border-radius:50%;background:#cad4cb;transition:transform .18s}.toggle-row input:checked{background:#8fbe4d}.toggle-row input:checked:before{transform:translateX(17px);background:#fff}.toggle-row input:disabled{opacity:.45;cursor:not-allowed}.notice{padding:10px 11px;border-radius:10px;background:#29291b;color:#d9d09a;font-size:10px;line-height:1.5}
      @media(max-width:600px){.panel{width:min(100vw,365px)}.launcher{right:12px;bottom:16px}}
    </style>
    <button class="launcher" aria-label="Abrir MiCierro CRM" title="Abrir CRM">M<em></em></button>
    <aside class="panel" aria-label="MiCierro CRM">
      <div class="top"><div class="logo">M</div><div class="title"><b>MiCierro CRM</b><small>GESTIÓN DE CLIENTES</small></div><button class="icon all" title="Todos los clientes">⌕</button><button class="icon close" title="Cerrar">×</button></div>
      <div class="tabs"><button class="tab active" data-view="contact">Contacto</button><button class="tab" data-view="clients">Clientes <span class="total"></span></button><button class="tab" data-view="replies">Respuestas</button></div>
      <div class="scroll"></div>
    </aside>`;

  const $ = (selector) => root.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const keyFor = (contact) => contact.phone ? `tel:${contact.phone}` : `name:${contact.name.toLocaleLowerCase()}`;

  function detectContact() {
    const main = document.querySelector('#main');
    const header = main?.querySelector('header');
    if (!header) return null;
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const looksLikePhone = (text) => /^\+?[\d\s().-]{7,}$/.test(text);
    const ignored = /^(video|audio|buscar|search|más|menu|more|profile|perfil|información del perfil|profile info|info\. del perfil|últ\. vez|en línea|online|typing\.\.\.)$/i;
    const preferred = clean(header.querySelector('[data-testid="conversation-info-header-chat-title"]')?.textContent);
    const candidates = [...header.querySelectorAll('span[dir="auto"]')]
      .filter((el) => el.getClientRects().length && !el.closest('button,[role="button"]'))
      .map((el) => clean(el.textContent))
      .filter((text) => text && text.length < 100 && !ignored.test(text));
    const fallbackTitles = [...header.querySelectorAll('[title]')]
      .map((el) => clean(el.getAttribute('title')))
      .filter((text) => text && text.length < 100 && !ignored.test(text));
    const rawName = (!looksLikePhone(preferred) && preferred) || candidates.find((text) => !looksLikePhone(text)) || fallbackTitles.find((text) => !looksLikePhone(text));
    if (!rawName) return null;
    const phoneCandidate = candidates.find(looksLikePhone) || fallbackTitles.find(looksLikePhone) || '';
    const phone = phoneCandidate.replace(/\D/g, '');
    const name = rawName.slice(0, 80);
    return { name, phone, key: keyFor({ name, phone }) };
  }

  async function loadRecords() {
    const data = await chrome.storage.local.get('micierro_crm_records');
    state.records = data.micierro_crm_records || {};
    $('.total').textContent = Object.keys(state.records).length ? `(${Object.keys(state.records).length})` : '';
  }
  function currentRecord() {
    if (!state.customer) return null;
    return state.records[state.customer.key] || { name: state.customer.name, phone: state.customer.phone, status: 'Nuevo', tags: [], notes: '', followUp: '' };
  }
  function toast(message) {
    root.querySelector('.toast')?.remove();
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; root.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }
  function renderContact() {
    const box = $('.scroll');
    state.customer = detectContact();
    if (!state.customer) {
      box.innerHTML = '<div class="empty">Abre una conversación para ver y editar su ficha CRM.<br><br>WhatsApp Web permanece en el centro de tu trabajo.</div><div class="divider"></div><div class="section-title">Cómo empezar</div><p class="muted">Selecciona un chat en la lista de WhatsApp. Los datos y notas del CRM se guardan localmente en este navegador.</p>';
      return;
    }
    const record = currentRecord(); state.record = record;
    const initial = esc((record.name || '?').trim().slice(0, 1).toUpperCase());
    const tags = (record.tags || []).map((tag, index) => `<span class="tag">${esc(tag)} <button data-remove-tag="${index}" title="Quitar">×</button></span>`).join('');
    box.innerHTML = `<div class="section-title">Ficha del contacto</div>
      <div class="profile"><div class="profile-head"><div class="avatar">${initial}</div><div class="name"><strong>${esc(record.name)}</strong><small>${record.phone ? `+${esc(record.phone)}` : 'Contacto de WhatsApp'}</small></div><span class="badge">${esc(record.status)}</span></div></div>
      <label>Estado del cliente</label><div class="status-row">${['Nuevo','Interesado','Cliente','Seguimiento'].map((s) => `<button class="status-chip ${record.status === s ? 'active' : ''}" data-status="${s}">${s}</button>`).join('')}</div>
      <label>Etiquetas</label><div class="tags">${tags || '<span class="muted">Aún no hay etiquetas</span>'}</div>
      <div class="addtag" style="margin-top:9px"><input class="field tag-input" placeholder="Añadir etiqueta" maxlength="24"><button class="smallbtn add-tag">Añadir</button></div>
      <label for="notes">Notas internas</label><textarea id="notes" placeholder="Preferencias, contexto o acuerdos…">${esc(record.notes || '')}</textarea>
      <label for="follow-up">Próximo seguimiento</label><input id="follow-up" class="field" type="date" value="${esc(record.followUp || '')}">
      <button class="save">Guardar ficha</button><p class="muted" style="text-align:center;margin:9px 0 0">Privado en este navegador · No se envía al chat</p>`;
    box.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => {
      const updated = { ...currentRecord(), status: button.dataset.status };
      state.records[state.customer.key] = updated; chrome.storage.local.set({ micierro_crm_records: state.records }).then(renderContact);
    }));
    box.querySelector('.add-tag').addEventListener('click', async () => {
      const input = box.querySelector('.tag-input'); const value = input.value.trim();
      if (!value) return;
      const updated = currentRecord();
      if (!updated.tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) updated.tags = [...updated.tags, value];
      state.records[state.customer.key] = updated; await chrome.storage.local.set({ micierro_crm_records: state.records }); renderContact();
    });
    box.querySelectorAll('[data-remove-tag]').forEach((button) => button.addEventListener('click', async () => {
      const updated = currentRecord(); updated.tags.splice(Number(button.dataset.removeTag), 1);
      state.records[state.customer.key] = updated; await chrome.storage.local.set({ micierro_crm_records: state.records }); renderContact();
    }));
    box.querySelector('.save').addEventListener('click', async () => {
      const updated = { ...currentRecord(), name: state.customer.name, phone: state.customer.phone, notes: box.querySelector('#notes').value.trim(), followUp: box.querySelector('#follow-up').value };
      state.records[state.customer.key] = updated; await chrome.storage.local.set({ micierro_crm_records: state.records });
      await loadRecords(); toast('Ficha guardada');
    });
  }
  function renderClients() {
    const box = $('.scroll'); const entries = Object.entries(state.records);
    const filtered = entries.filter(([, rec]) => `${rec.name} ${rec.phone} ${(rec.tags || []).join(' ')}`.toLowerCase().includes(state.search.toLowerCase()));
    box.innerHTML = `<div class="subhead"><div class="section-title" style="margin:0">Base de clientes</div><span class="count">${filtered.length} contactos</span></div>
      <input class="field search" placeholder="Buscar nombre o etiqueta…" value="${esc(state.search)}">
      ${filtered.length ? filtered.map(([key, rec]) => `<div class="row" data-key="${esc(key)}"><strong>${esc(rec.name || 'Contacto')}</strong><small>${rec.phone ? `+${esc(rec.phone)} · ` : ''}${esc(rec.status || 'Nuevo')}${rec.tags?.length ? ` · ${esc(rec.tags.join(', '))}` : ''}</small></div>`).join('') : '<div class="empty">Todavía no hay contactos guardados. Abre una conversación para crear su ficha.</div>'}`;
    box.querySelector('.search').addEventListener('input', (event) => { state.search = event.target.value; renderClients(); const field = box.querySelector('.search'); field.focus(); field.setSelectionRange(field.value.length, field.value.length); });
    box.querySelectorAll('[data-key]').forEach((row) => row.addEventListener('click', () => {
      const rec = state.records[row.dataset.key];
      state.customer = { name: rec.name, phone: rec.phone || '', key: row.dataset.key };
      activateView('contact'); renderContact();
    }));
  }
  function renderReplies() {
    const box = $('.scroll');
    box.innerHTML = `<div class="section-title">Asistente de respuestas</div>
      <div class="profile"><div class="profile-head"><div class="avatar">✦</div><div class="name"><strong>Respuesta automática</strong><small>${state.apiConnected ? 'Motor de respuesta conectado' : 'Conecta el backend desde el icono M de Chrome'}</small></div><span class="badge">${state.autoReply ? 'ACTIVA' : 'PAUSADA'}</span></div></div>
      <label class="toggle-row"><span><strong>Responder en WhatsApp Web</strong><small>Envía respuestas al recibir un mensaje nuevo</small></span><input class="auto-reply-toggle" type="checkbox" ${state.autoReply ? 'checked' : ''} ${state.apiConnected ? '' : 'disabled'}></label>
      <div class="divider"></div>
      <div class="section-title">Cómo funciona</div>
      <p class="muted">Los últimos mensajes del chat se envían al backend que configures para generar una respuesta con IA. Si la IA no está configurada, se usan las reglas del backend. La respuesta se envía en la conversación abierta de WhatsApp Web.</p>
      <p class="notice">Actívalo solo después de conectar el backend y revisar que esté configurado. Mientras está apagado, no se envía ninguna respuesta automática.</p>
      ${state.apiConnected ? '' : '<p class="muted">Abre el menú de la extensión en Chrome, ingresa la URL del backend y tus credenciales del panel para conectar el motor.</p>'}`;
    box.querySelector('.auto-reply-toggle').addEventListener('change', async (event) => {
      state.autoReply = event.target.checked;
      await chrome.storage.local.set({ micierro_auto_reply_enabled: state.autoReply });
      toast(state.autoReply ? 'Respuestas automáticas activadas' : 'Respuestas automáticas pausadas');
      renderReplies();
    });
  }
  function activateView(view) {
    state.view = view;
    root.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
    if (view === 'contact') renderContact();
    else if (view === 'clients') renderClients();
    else renderReplies();
  }
  function toggle(open = !state.open) {
    state.open = open; $('.panel').classList.toggle('open', open);
    $('.launcher').setAttribute('aria-expanded', String(open));
    if (open) {
      Promise.all([
        loadRecords(),
        chrome.storage.local.get(['micierro_auto_reply_enabled', 'micierro_auth_token']),
      ]).then(([, config]) => {
        state.autoReply = Boolean(config.micierro_auto_reply_enabled);
        state.apiConnected = Boolean(config.micierro_auth_token);
        activateView(state.view || 'contact');
      });
    }
  }
  $('.launcher').addEventListener('click', () => toggle());
  $('.close').addEventListener('click', () => toggle(false));
  $('.all').addEventListener('click', () => activateView('clients'));
  root.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => activateView(tab.dataset.view)));

  let lastContact = '';
  const seenInbound = new Set();
  let inboundBaselineReady = false;
  let inboundBaselineContact = null;

  function getMessageText(node) {
    const element = node.querySelector('[data-testid="selectable-text"]') || node.querySelector('.selectable-text');
    return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  }
  function getChatHistory() {
    return [...document.querySelectorAll('#main .message-in, #main .message-out')]
      .map((node) => ({ role: node.classList.contains('message-out') ? 'assistant' : 'user', content: getMessageText(node) }))
      .filter((message) => message.content).slice(-20);
  }
  function messageFingerprint(node, contact) {
    return `${contact?.key || 'chat'}:${node.getAttribute('data-id') || node.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || getMessageText(node)}`;
  }
  function optCommand(text) {
    const normalized = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (normalized === 'dejar de recibir mensajes' || normalized === 'stop') return 'out';
    if (normalized === 'quiero recibir mensajes' || normalized === 'start') return 'in';
    return null;
  }
  function sendInWhatsApp(text) {
    const footer = document.querySelector('#main footer');
    const composer = footer?.querySelector('[contenteditable="true"][role="textbox"], [contenteditable="true"]');
    if (!composer) throw new Error('No encuentro el cuadro de mensaje de WhatsApp.');
    composer.focus();
    document.execCommand('insertText', false, text);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    const sendButton = footer.querySelector('[data-testid="send"], button[aria-label="Enviar"], button[aria-label="Send"], [data-icon="send"]')?.closest('button') || footer.querySelector('[data-testid="send"], button[aria-label="Enviar"], button[aria-label="Send"]');
    if (!sendButton) throw new Error('WhatsApp no mostró el botón Enviar; no se envió el mensaje.');
    sendButton.click();
  }
  async function createAndSendReply(contact, triggerFingerprint) {
    const { micierro_auto_reply_enabled: enabled, micierro_auth_token: token } = await chrome.storage.local.get([
      'micierro_auto_reply_enabled', 'micierro_auth_token',
    ]);
    if (!enabled || !token) return;
    const suppressed = await chrome.storage.local.get('micierro_opted_out_contacts');
    if (suppressed.micierro_opted_out_contacts?.[contact?.key]) return;
    const history = getChatHistory();
    if (!history.length || history[history.length - 1].role !== 'user') return;
    const response = await chrome.runtime.sendMessage({
      type: 'MICIERRO_GENERATE_REPLY',
      payload: { customerName: contact?.name || '', messages: history },
    });
    if (!response?.ok) { toast(response?.error || 'No se pudo generar la respuesta'); return; }
    if (!response.data.reply) return;
    const activeContact = detectContact();
    const activeLastInbound = [...document.querySelectorAll('#main .message-in')].pop();
    const stillEnabled = await chrome.storage.local.get('micierro_auto_reply_enabled');
    if (!stillEnabled.micierro_auto_reply_enabled) return;
    if (activeContact?.key !== contact?.key || !activeLastInbound || messageFingerprint(activeLastInbound, activeContact) !== triggerFingerprint) return;
    sendInWhatsApp(response.data.reply);
    toast(`Respuesta enviada · ${response.data.source === 'AI' ? 'IA' : 'reglas'}`);
  }
  function observeIncoming() {
    const contact = detectContact();
    const contactKey = contact?.key || null;
    const incoming = [...document.querySelectorAll('#main .message-in')];
    if (!inboundBaselineReady || contactKey !== inboundBaselineContact) {
      incoming.forEach((node) => seenInbound.add(messageFingerprint(node, contact)));
      inboundBaselineReady = true;
      inboundBaselineContact = contactKey;
      return;
    }
    const latest = incoming[incoming.length - 1];
    if (!latest) return;
    const latestText = getMessageText(latest);
    if (!latestText) return;
    const fingerprint = messageFingerprint(latest, contact);
    if (seenInbound.has(fingerprint)) return;
    seenInbound.add(fingerprint);
    if (seenInbound.size > 250) seenInbound.delete(seenInbound.values().next().value);
    const command = optCommand(latestText);
    if (command) {
      chrome.storage.local.get('micierro_opted_out_contacts').then(({ micierro_opted_out_contacts: contacts = {} }) => {
        if (command === 'out') contacts[contact?.key || 'unknown'] = true;
        else delete contacts[contact?.key || 'unknown'];
        return chrome.storage.local.set({ micierro_opted_out_contacts: contacts });
      }).then(() => toast(command === 'out' ? 'Respuestas pausadas para este contacto' : 'Respuestas reactivadas para este contacto'));
      return;
    }
    createAndSendReply(contact, fingerprint).catch((error) => toast(error.message || 'Error preparando respuesta'));
  }

  const observer = new MutationObserver(() => {
    const contact = detectContact(); const signature = contact?.key || '';
    if (signature !== lastContact) {
      lastContact = signature;
      if (state.open && $('.panel').classList.contains('open')) activateView('contact');
    }
    observeIncoming();
  });
  observeIncoming();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
})();
