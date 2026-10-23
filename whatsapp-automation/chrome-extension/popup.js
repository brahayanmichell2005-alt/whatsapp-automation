const connectButton = document.getElementById('connect-whatsapp');
const apiButton = document.getElementById('connect-api');
const status = document.getElementById('status');

connectButton.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    status.textContent = 'WhatsApp Web está abierto';
  } else {
    await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
    status.textContent = 'Abriendo WhatsApp Web…';
  }
  window.close();
});

chrome.storage.local.get(['micierro_api_base', 'micierro_auth_token']).then(({ micierro_api_base, micierro_auth_token }) => {
  if (micierro_api_base) document.getElementById('api-url').value = micierro_api_base;
  if (micierro_auth_token) status.textContent = 'API conectada';
});

apiButton.addEventListener('click', async () => {
  apiButton.disabled = true;
  status.textContent = 'Conectando…';
  try {
    const input = document.getElementById('api-url').value.trim();
    const url = new URL(input);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Usa HTTPS; HTTP solo se permite en localhost.');
    }
    const apiBase = url.origin.replace(/\/+$/, '');
    const permissionOrigin = `${url.protocol}//${url.hostname}/*`;
    const permission = await chrome.permissions.request({ origins: [permissionOrigin] });
    if (!permission) throw new Error('Chrome no concedió permiso para conectar con este backend.');

    const response = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) throw new Error(data.error || `No se pudo iniciar sesión (${response.status}).`);

    await chrome.storage.local.set({ micierro_api_base: apiBase, micierro_auth_token: data.token });
    document.getElementById('password').value = '';
    status.textContent = `API conectada · ${data.user?.email || 'sesión activa'}`;
  } catch (error) {
    status.textContent = error.message || 'No se pudo conectar';
  } finally {
    apiButton.disabled = false;
  }
});

chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }).then((tabs) => {
  if (tabs.length && status.textContent === 'API sin conectar') status.textContent = 'WhatsApp Web está abierto';
});
