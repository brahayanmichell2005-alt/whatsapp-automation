// Asistente virtual flotante del panel ("Nova"): personaje + ventana de
// chat conectada al endpoint real /api/assistant/chat (Gemini + herramientas
// del backend: busqueda web, datos del sistema, envio de WhatsApp con
// confirmacion, analisis de imagenes/audios).
//
// Depende de utilidades globales de app.js (esc, apiFetch, getAuthToken),
// cargadas antes de este archivo.

(function () {
  'use strict';

  const HISTORY_KEY = 'wa_assistant_history';
  const MAX_STORED = 80;

  const state = {
    open: false,
    busy: false,
    history: [], // [{ role: 'user'|'assistant', content }]
    attachment: null, // { name, mimetype, data(base64) }
  };

  const el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    Object.assign(el, {
      widget: $('ai-widget'),
      fab: $('ai-fab'),
      fabDot: $('ai-fab-dot'),
      chat: $('ai-chat'),
      msgs: $('ai-msgs'),
      typing: $('ai-typing'),
      confirm: $('ai-confirm'),
      form: $('ai-form'),
      input: $('ai-input'),
      send: $('ai-send'),
      file: $('ai-file'),
      close: $('ai-close'),
      min: $('ai-min'),
      status: $('ai-chat-status'),
    });
    if (!el.fab) return;

    state.history = loadHistory();
    if (state.history.length) renderAll();

    el.fab.addEventListener('click', toggle);
    el.close.addEventListener('click', () => setOpen(false, true));
    el.min.addEventListener('click', () => setOpen(false, false));
    el.form.addEventListener('submit', onSubmit);
    el.file.addEventListener('change', onFile);
  }

  // ----------------------------------------------------------------
  // Apertura / cierre (el estado del chat se conserva al navegar por
  // las pestanas: es la misma pagina, nunca se recarga).
  // ----------------------------------------------------------------
  function setOpen(open, clearPending) {
    state.open = open;
    el.chat.classList.toggle('hidden', !open);
    el.fab.classList.toggle('hidden', open);
    if (open) {
      el.fabDot.classList.add('hidden');
      el.msgs.scrollTop = el.msgs.scrollHeight;
      el.input.focus();
      if (clearPending) hideConfirm();
    }
  }

  function toggle() {
    setOpen(!state.open, false);
  }

  // ----------------------------------------------------------------
  // Markdown ligero y seguro: TODO se escapa antes de transformar.
  // Soporta: bloques de codigo, codigo inline, negritas, italica,
  // listas, titulos simples y enlaces http(s).
  // ----------------------------------------------------------------
  function mdLite(src) {
    let text = esc(src == null ? '' : String(src));
    const blocks = [];
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      blocks.push(code.replace(/^\n/, ''));
      return `\u0000B${blocks.length - 1}\u0000`;
    });
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>');
    // Listas con guion o asterisco
    text = text.replace(/(^|\n)((?:[ \t]*[-*] .*(?:\n|$))+)/g, (m, pre, block) => {
      const items = block
        .trim()
        .split('\n')
        .map((l) => `<li>${l.replace(/^[ \t]*[-*] /, '')}</li>`)
        .join('');
      return `${pre}<ul>${items}</ul>`;
    });
    // Enlaces seguros (solo http/https, sin HTML en el texto)
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    text = text.replace(/\n/g, '<br>');
    text = text.replace(/\u0000B(\d+)\u0000/g, (_, i) => `<pre><code>${blocks[Number(i)]}</code></pre>`);
    return text;
  }

  function bubble(role, content, isError) {
    const div = document.createElement('div');
    div.className = `ai-msg ${role === 'user' ? 'ai-user' : 'ai-bot'}${isError ? ' ai-error' : ''}`;
    div.innerHTML = mdLite(content);
    el.msgs.appendChild(div);
    el.msgs.scrollTop = el.msgs.scrollHeight;
    return div;
  }

  function renderAll() {
    el.msgs.innerHTML = '';
    for (const m of state.history) bubble(m.role, m.content);
  }

  function loadHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(raw) ? raw.slice(-MAX_STORED) : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(-MAX_STORED)));
    } catch {
      // Sin espacio: el chat sigue funcionando sin persistencia.
    }
  }

  function showTyping(show) {
    el.typing.classList.toggle('hidden', !show);
    if (show) el.msgs.scrollTop = el.msgs.scrollHeight;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.send.disabled = busy;
    el.input.disabled = busy;
    el.file.disabled = busy;
    el.status.textContent = busy ? 'Procesando...' : 'Asistente del panel';
  }

  function newConversation() {
    state.history = [];
    state.attachment = null;
    saveHistory();
    el.msgs.innerHTML = '';
    hideConfirm();
    el.input.focus();
  }

  // ----------------------------------------------------------------
  // Adjuntos (imagen/audio): se analizan con el mismo motor multimodal
  // de WhatsApp. SIN limite practico: los archivos grandes suben por
  // partes (~3 MB) hasta 15 MB; las imagenes primero se comprimen en
  // el navegador (max 1600px, JPEG 85%).
  // ----------------------------------------------------------------
  const MAX_DIRECT_BYTES = 3 * 1024 * 1024; // por encima: subida por partes
  const CHUNK_BYTES = 2800 * 1024; // ~2.7 MB en base64 ≈ 3.6 MB por request

  // Redimensiona una imagen con canvas. Devuelve un Blob JPEG o null si
  // no hace falta comprimir / no se pudo.
  function compressImage(file) {
    return new Promise((resolve) => {
      if (!/^image\//.test(file.type || '') || /gif|svg/i.test(file.type)) return resolve(null);
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const MAXPX = 1600;
          const scale = Math.min(1, MAXPX / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
        } catch (err) {
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // Sube un archivo grande por partes y devuelve el attachmentId.
  async function uploadInParts(file) {
    const total = Math.ceil(file.size / CHUNK_BYTES);
    const uploadId = `f${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < total; i += 1) {
      const chunk = file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
        r.onerror = () => reject(new Error('No se pudo leer el archivo'));
        r.readAsDataURL(chunk);
      });
      const res = await fetch(`${API_BASE}/api/assistant/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify({
          uploadId,
          index: i,
          total,
          name: file.name,
          mimetype: file.type || 'application/octet-stream',
          data: b64,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'La subida fallo');
      bubble('assistant', `⏳ Subiendo archivo grande... ${Math.round(((i + 1) / total) * 100)}%`, true);
      if (j.complete && j.attachmentId) return j.attachmentId;
    }
    throw new Error('La subida no se completo');
  }

  async function onFile() {
    const file = el.file.files && el.file.files[0];
    if (!file) return;
    let usable = file;
    let nombre = file.name;
    // Imagen grande: comprimir en el navegador (mas rapido que partir).
    if (file.size > MAX_DIRECT_BYTES) {
      const compressed = await compressImage(file);
      if (compressed && compressed.size <= MAX_DIRECT_BYTES) {
        usable = compressed;
        nombre = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      }
    }
    try {
      if (usable.size <= MAX_DIRECT_BYTES) {
        // Camino directo: base64 en el mismo request del chat.
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
          reader.onerror = () => reject(new Error('No pude leer el archivo'));
          reader.readAsDataURL(usable);
        });
        state.attachment = {
          name: nombre,
          mimetype: usable === file ? file.type || 'application/octet-stream' : 'image/jpeg',
          data,
        };
      } else {
        // Archivo grande: subida por partes (hasta 15 MB).
        const attachmentId = await uploadInParts(file);
        state.attachment = {
          name: file.name,
          mimetype: file.type || 'application/octet-stream',
          attachmentId,
        };
      }
      el.input.placeholder = `Archivo listo: ${nombre} (se analiza al enviar)`;
      el.input.focus();
    } catch (err) {
      bubble('assistant', `⚠️ ${err.message}`, true);
    }
    el.file.value = '';
  }

  // ----------------------------------------------------------------
  // Envio de solicitudes (todo pasa por el backend: sin claves en el
  // frontend, con timeouts y mensajes de error claros).
  // ----------------------------------------------------------------
  async function onSubmit(e) {
    e.preventDefault();
    const text = el.input.value.trim();
    if ((!text && !state.attachment) || state.busy) return;
    el.input.value = '';
    el.input.placeholder = 'Pideme lo que necesites...';

    const shown = text || (state.attachment ? `📎 ${state.attachment.name}` : '');
    state.history.push({ role: 'user', content: shown });
    bubble('user', shown);
    saveHistory();

    const attachment = state.attachment;
    state.attachment = null;

    await ask({ message: text || '(analiza el archivo adjunto)', history: state.history.slice(-MAX_STORED), attachment });
  }

  async function ask(payload) {
    setBusy(true);
    showTyping(true);
    try {
      const r = await apiFetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const reply = String(r.reply || '').trim() || 'No pude generar respuesta, intenta de nuevo.';
      state.history.push({ role: 'assistant', content: reply });
      bubble('assistant', reply);
      saveHistory();

      // Accion sensible propuesta por la IA: NUNCA ejecutada sola.
      if (r.pendingAction) showConfirm(r.pendingAction);
      if (!state.open) el.fabDot.classList.remove('hidden');
    } catch (err) {
      bubble(
        'assistant',
        `⚠️ ${err.message || 'No pude contactar al servidor. Revisa tu conexion e intenta de nuevo.'}`,
        true
      );
      if (!state.open) el.fabDot.classList.remove('hidden');
    } finally {
      showTyping(false);
      setBusy(false);
      el.input.focus();
    }
  }

  // Barra de confirmacion para el envio de WhatsApp propuesto por la IA.
  function showConfirm(action) {
    el.confirm.classList.remove('hidden');
    el.confirm.innerHTML = `
      <div class="ai-confirm-title">📨 La IA propone enviar un WhatsApp (requiere tu confirmacion)</div>
      <div class="ai-confirm-body">
        <strong>Para:</strong> +${esc(action.telefono)}<br>
        <strong>Mensaje:</strong> ${esc(action.texto)}
      </div>
      <div class="btn-row">
        <button type="button" class="btn" data-ai-act="confirm">✅ Confirmar y enviar</button>
        <button type="button" class="btn btn-secondary" data-ai-act="cancel">Cancelar</button>
      </div>`;
    el.confirm.querySelector('[data-ai-act="confirm"]').addEventListener('click', () => confirmSend(action));
    el.confirm.querySelector('[data-ai-act="cancel"]').addEventListener('click', hideConfirm);
    el.msgs.scrollTop = el.msgs.scrollHeight;
  }

  function hideConfirm() {
    el.confirm.classList.add('hidden');
    el.confirm.innerHTML = '';
  }

  async function confirmSend(action) {
    hideConfirm();
    setBusy(true);
    showTyping(true);
    try {
      const r = await apiFetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: { telefono: action.telefono, texto: action.texto } }),
      });
      const reply = String(r.reply || '✅ Enviado.');
      state.history.push({ role: 'assistant', content: reply });
      bubble('assistant', reply);
      saveHistory();
    } catch (err) {
      bubble('assistant', `⚠️ No se pudo enviar: ${err.message}`, true);
    } finally {
      showTyping(false);
      setBusy(false);
    }
  }

  // Arranque: el panel es una sola pagina; init cuando el DOM este listo.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
