chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'MICIERRO_GENERATE_REPLY') return false;
  if (!sender.url?.startsWith('https://web.whatsapp.com/')) return false;

  (async () => {
    const { micierro_api_base: apiBase, micierro_auth_token: token } = await chrome.storage.local.get([
      'micierro_api_base',
      'micierro_auth_token',
    ]);
    if (!apiBase || !token) throw new Error('Conecta tu API desde el botón de MiCierro en Chrome.');

    const response = await fetch(`${apiBase}/api/extension/reply`, {
      signal: AbortSignal.timeout(25000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(message.payload),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await chrome.storage.local.set({ micierro_auto_reply_enabled: false });
      await chrome.storage.local.remove('micierro_auth_token');
      throw new Error('La sesión de la API expiró. Vuelve a conectar el backend desde el menú de la extensión.');
    }
    if (!response.ok) throw new Error(data.error || `Error de API (${response.status})`);
    return data;
  })().then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error.message || 'No se pudo generar la respuesta' })
  );

  return true;
});
