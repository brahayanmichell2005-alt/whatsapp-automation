// Voz de Nova = reconocimiento de voz (STT) + lectura en voz alta (TTS) del
// propio navegador. No se graba ni se sube audio: solo viaja el texto que el
// navegador transcribe al endpoint existente /api/assistant/chat (misma IA,
// mismo historial y mismas acciones que el chat de texto).
//
// Requiere Web Speech API:
//   - SpeechRecognition / webkitSpeechRecognition  (dictado; Chrome/Edge/Safari)
//   - speechSynthesis                              (lectura; todos los modernos)
// Si el navegador no lo soporta, el chat de texto sigue funcionando igual.

(function () {
  'use strict';

  const PREFS_KEY = 'wa_nova_voice';
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const synth = window.speechSynthesis || null;
  const SR_LANG = (navigator.language || 'es-PE').toLowerCase().startsWith('es')
    ? navigator.language
    : 'es-PE';

  const state = {
    enabled: false, // leer en voz alta todas las respuestas
    continuous: false, // volver a escuchar al terminar de hablar
    listening: false,
    speaking: false,
    paused: false,
    sending: false,
    failed: false, // la sesion de dictado termino con error
    cancelled: false,
    finalText: '',
    voiceURI: '',
    rate: 1,
    voices: [],
    chunkTimer: null,
    silencioTimer: null,
    relanzarTimer: null,
    avisoTimer: null,
  };

  const el = {};
  let recognition = null;

  function $(id) {
    return document.getElementById(id);
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          enabled: state.enabled,
          continuous: state.continuous,
          voiceURI: state.voiceURI,
          rate: state.rate,
        })
      );
    } catch {
      // Sin almacenamiento: se mantiene solo en esta sesion.
    }
  }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      state.enabled = p.enabled === true;
      state.continuous = p.continuous === true;
      state.voiceURI = typeof p.voiceURI === 'string' ? p.voiceURI : '';
      const rate = Number(p.rate);
      state.rate = Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : 1;
    } catch {
      // Preferencias corruptas: valores por defecto.
    }
  }

  // ------------------------------------------------------------------
  // Interfaz: modo voz, continuo, voces, velocidad, micrófono y controles
  // ------------------------------------------------------------------
  function bindUI() {
    Object.assign(el, {
      voice: $('ai-voice'),
      toggle: $('ai-voice-toggle'),
      extra: $('ai-voice-extra'),
      select: $('ai-voice-select'),
      rate: $('ai-voice-rate'),
      cont: $('ai-voice-cont'),
      live: $('ai-voice-live'),
      liveText: $('ai-voice-text'),
      cancel: $('ai-voice-cancel'),
      player: $('ai-voice-player'),
      speakText: $('ai-voice-speaking'),
      pause: $('ai-voice-pause'),
      resume: $('ai-voice-resume'),
      stop: $('ai-voice-stop'),
      mic: $('ai-mic'),
      form: $('ai-form'),
      input: $('ai-input'),
      chat: $('ai-chat'),
      widget: $('ai-widget'),
      close: $('ai-close'),
      min: $('ai-min'),
    });
    if (!el.mic || !el.voice) return false;

    el.toggle.addEventListener('click', () => {
      setEnabled(!state.enabled);
      if (state.enabled) primeAudio();
    });

    el.cont.addEventListener('click', () => {
      state.continuous = !state.continuous;
      if (state.continuous) setEnabled(true);
      savePrefs();
      paintUI();
      if (state.continuous && state.enabled && !state.speaking) startListening();
    });

    el.rate.value = String(state.rate);
    el.rate.addEventListener('change', () => {
      const v = Number(el.rate.value);
      state.rate = Number.isFinite(v) ? v : 1;
      savePrefs();
      if (state.speaking) {
        // Aplicar la nueva velocidad releyendo la respuesta actual.
        const texto = el.speakText && el.speakText.dataset.texto;
        if (texto) speak(texto);
      }
    });

    el.select.addEventListener('change', () => {
      state.voiceURI = el.select.value || '';
      savePrefs();
    });

    el.mic.addEventListener('click', onMicPress);
    el.cancel.addEventListener('click', () => cancelListening(true));
    el.pause.addEventListener('click', pauseSpeaking);
    el.resume.addEventListener('click', resumeSpeaking);
    el.stop.addEventListener('click', () => stopSpeaking({ reanudar: state.continuous }));

    // Si el usuario escribe mientras Nova habla, se calla (no se pisan).
    el.form.addEventListener(
      'submit',
      () => {
        stopSpeaking({});
      },
      true
    );

    // Cerrar o minimizar detiene voz y micrófono (privacidad).
    [el.close, el.min].forEach((b) => {
      if (!b) return;
      b.addEventListener('click', () => {
        stopSpeaking({});
        cancelListening(false);
      });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelListening(false);
    });

    el.mic.title = SpeechRec
      ? 'Hablar con Nova'
      : 'Tu navegador no permite dictado por voz (usa Chrome, Edge o Safari)';
    if (!SpeechRec) el.mic.classList.add('ai-mic-off');
    if (!synth) el.toggle.disabled = true;
    return true;
  }

  function paintUI() {
    if (!el.toggle) return;
    el.toggle.classList.toggle('on', state.enabled);
    el.toggle.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    el.toggle.textContent = state.enabled ? '🔊 Modo voz' : '🔈 Modo voz';
    el.cont.classList.toggle('on', state.continuous);
    el.cont.setAttribute('aria-pressed', state.continuous ? 'true' : 'false');
    el.extra.classList.toggle('hidden', !state.enabled && !state.continuous);
    el.mic.classList.toggle('active', state.listening);
    el.mic.setAttribute('aria-pressed', state.listening ? 'true' : 'false');
    el.mic.textContent = state.listening ? '⏹' : '🎤';
    el.mic.title = state.listening
      ? 'Detener el dictado'
      : state.speaking
      ? 'Interrumpir a Nova y hablar'
      : 'Hablar con Nova';
    if (el.widget) el.widget.classList.toggle('ai-listening', state.listening);
    if (el.widget) el.widget.classList.toggle('ai-speaking', state.speaking);
    if (window.NovaChat) {
      window.NovaChat.setStatus(
        state.listening
          ? 'Escuchándote…'
          : state.speaking
          ? 'Hablando…'
          : state.enabled
          ? 'Modo voz activo'
          : 'Asistente del panel'
      );
    }
  }

  function setEnabled(on) {
    state.enabled = on === true;
    if (!state.enabled) {
      state.continuous = false;
      stopSpeaking({});
      cancelListening(false);
    }
    savePrefs();
    paintUI();
  }

  function showLive(show, texto) {
    el.live.classList.toggle('hidden', !show);
    if (texto) setLiveText(texto);
  }

  function setLiveText(texto) {
    if (el.liveText) el.liveText.textContent = texto;
  }

  function showPlayer(show) {
    el.player.classList.toggle('hidden', !show);
    el.pause.classList.toggle('hidden', state.paused);
    el.resume.classList.toggle('hidden', !state.paused);
  }

  function aviso(texto, ms) {
    showLive(true, texto);
    el.live.classList.add('aviso');
    el.cancel.classList.add('hidden');
    clearTimeout(state.avisoTimer);
    state.avisoTimer = setTimeout(() => {
      el.live.classList.remove('aviso');
      el.cancel.classList.remove('hidden');
      if (!state.listening && !state.sending) showLive(false);
    }, ms || 6000);
  }

  // ------------------------------------------------------------------
  // Voces disponibles (se cargan de forma asincrona en Chrome)
  // ------------------------------------------------------------------
  const BONUS = [
    /natural|neural|premium|enhanced|wavenet/i,
    /google/i,
    /microsoft/i,
    /paulina|monica|mónica|helena|lucia|lucía|sabina|elvira|esperanza|estrella|camila|marisol/i,
  ];

  function scoreVoice(v) {
    let score = 0;
    if (/^es-pe/i.test(v.lang)) score += 6;
    else if (/^es-419/i.test(v.lang)) score += 5;
    else if (/^es/i.test(v.lang)) score += 4;
    else score -= 10;
    BONUS.forEach((re, i) => {
      if (re.test(v.name || '')) score += 4 - i * 0.5;
    });
    return score;
  }

  function loadVoices() {
    if (!synth) return;
    const all = synth.getVoices() || [];
    state.voices = all.filter((v) => /^es/i.test(v.lang));
    if (!state.voices.length) state.voices = all;
    if (!all.length) return;

    const order = [...state.voices].sort((a, b) => scoreVoice(b) - scoreVoice(a));
    const keep = state.voiceURI;
    el.select.innerHTML = order
      .map((v) => `<option value="${String(v.voiceURI).replace(/"/g, '&quot;')}">${v.name} (${v.lang})</option>`)
      .join('');

    let chosen = order.find((v) => v.voiceURI === keep);
    if (!chosen) chosen = order[0];
    state.voiceURI = chosen ? chosen.voiceURI : '';
    el.select.value = state.voiceURI;
  }

  function pickVoice() {
    if (!state.voices.length) return null;
    return (
      state.voices.find((v) => v.voiceURI === state.voiceURI) ||
      [...state.voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ||
      null
    );
  }

  // Desbloquea la sintesis en moviles (debe ocurrir dentro de un gesto).
  function primeAudio() {
    if (!synth) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch {
      // Sin problema: solo era un desbloqueo preventivo.
    }
  }

  // ------------------------------------------------------------------
  // Texto listo para leer: sin markdown, codigo, URLs ni emojis
  // ------------------------------------------------------------------
  function speakable(text) {
    let s = String(text || '');
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/`([^`]*)`/g, '$1');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]+)\]\((?:https?:)?\/\/[^)]+\)/g, '$1');
    s = s.replace(/https?:\/\/\S+/gi, ' ');
    s = s.replace(/[*_#>|~]/g, ' ');
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  // Parte la respuesta en frases cortas: se oye mas natural y evita el
  // corte de frases largas que hacen algunos navegadores.
  function chunkText(text, max) {
    const out = [];
    const frases = String(text || '').match(/[^.!?…]+[.!?…]*/g) || [String(text || '')];
    let actual = '';
    const empujar = (t) => {
      const limpio = t.trim();
      if (limpio) out.push(limpio);
    };
    frases.forEach((f) => {
      const s = f.trim();
      if (!s) return;
      if (!actual) actual = s;
      else if ((actual + ' ' + s).length <= max) actual += ' ' + s;
      else {
        empujar(actual);
        actual = s;
      }
      while (actual.length > max * 1.5) {
        const corte = actual.lastIndexOf(',', max);
        const at = corte > 40 ? corte + 1 : max;
        empujar(actual.slice(0, at));
        actual = actual.slice(at).trim();
      }
    });
    empujar(actual);
    return out;
  }

  // ------------------------------------------------------------------
  // Lectura en voz alta
  // ------------------------------------------------------------------
  function speak(text) {
    if (!synth || !text) return;
    const limpio = speakable(text);
    if (!limpio) return;
    stopSpeaking({});
    if (el.speakText) el.speakText.dataset.texto = text;
    el.speakText.textContent = 'Nova está hablando…';
    showLive(false);
    state.speaking = true;
    state.paused = false;
    showPlayer(true);
    paintUI();

    const partes = chunkText(limpio, 240);
    const voice = pickVoice();
    if (!voice && !state.voices.length) {
      el.speakText.textContent = 'Nova está hablando (voz del sistema)…';
    }

    let indice = 0;
    const siguiente = () => {
      if (!state.speaking) return;
      if (indice >= partes.length) {
        finishSpeaking();
        return;
      }
      const u = new SpeechSynthesisUtterance(partes[indice]);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : SR_LANG;
      u.rate = state.rate;
      u.pitch = 1;
      u.onend = () => {
        indice += 1;
        siguiente();
      };
      u.onerror = (ev) => {
        const err = String((ev && ev.error) || '');
        if (err === 'interrupted' || err === 'canceled') return;
        indice += 1;
        siguiente();
      };
      try {
        synth.speak(u);
      } catch {
        indice += 1;
        siguiente();
      }
    };

    // Chrome pierde la primera frase si se habla justo despues de cancel();
    // un respiro de 80 ms lo evita.
    clearTimeout(state.chunkTimer);
    state.chunkTimer = setTimeout(siguiente, 80);
  }

  function finishSpeaking() {
    state.speaking = false;
    state.paused = false;
    showPlayer(false);
    paintUI();
    if (state.enabled && state.continuous) {
      clearTimeout(state.relanzarTimer);
      state.relanzarTimer = setTimeout(() => {
        if (!state.speaking && state.enabled && state.continuous) startListening();
      }, 420);
    }
  }

  function stopSpeaking(opts = {}) {
    if (!synth) return;
    state.speaking = false;
    state.paused = false;
    clearTimeout(state.chunkTimer);
    clearTimeout(state.relanzarTimer);
    try {
      synth.cancel();
    } catch {
      // Algunos navegadores lanzan si no hay nada en cola.
    }
    showPlayer(false);
    paintUI();
    if (opts.reanudar && state.enabled && state.continuous) {
      state.relanzarTimer = setTimeout(() => {
        if (!state.speaking) startListening();
      }, 380);
    }
  }

  function pauseSpeaking() {
    if (!synth || !state.speaking) return;
    try {
      synth.pause();
      state.paused = true;
      showPlayer(true);
    } catch {
      // Si el navegador no permite pausar, el boton no hace nada.
    }
  }

  function resumeSpeaking() {
    if (!synth || !state.speaking) return;
    try {
      synth.resume();
      state.paused = false;
      showPlayer(true);
    } catch {
      // Ignorado.
    }
  }

  // ------------------------------------------------------------------
  // Dictado (Speech-to-Text)
  // ------------------------------------------------------------------
  function ensureRecognition() {
    if (!SpeechRec) return null;
    if (recognition) return recognition;
    recognition = new SpeechRec();
    recognition.lang = SR_LANG;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      state.listening = true;
      state.failed = false;
      setLiveText('Escuchando… habla con naturalidad');
      el.live.classList.remove('aviso');
      showLive(true);
      paintUI();
    };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const txt = String((res[0] && res[0].transcript) || '');
        if (!txt) continue;
        if (res.isFinal) state.finalText += `${txt} `;
        else interim += txt;
      }
      const visible = (state.finalText + interim).trim();
      if (visible) setLiveText(`“${visible}”`);
      // Deteccion de fin de habla: si el navegador no cierra solo, cerramos
      // tras 1.4 s sin nuevas palabras.
      clearTimeout(state.silencioTimer);
      state.silencioTimer = setTimeout(() => {
        try {
          recognition.stop();
        } catch {
          // Ya estaba detenido.
        }
      }, 1400);
    };

    recognition.onerror = (event) => {
      const code = String((event && event.error) || '');
      state.failed = true;
      clearTimeout(state.silencioTimer);
      if (code === 'aborted' || code === 'canceled') return;
      if (code === 'no-speech') {
        aviso('No te escuché. Pulsa el micrófono e inténtalo otra vez.', 4500);
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        aviso('Permiso de micrófono denegado. Habilítalo en el candado de la barra del navegador.', 9000);
      } else if (code === 'audio-capture') {
        aviso('No encontré un micrófono conectado. Revisa tu dispositivo.', 8000);
      } else if (code === 'network') {
        aviso('Sin conexión para el dictado. El reconocimiento necesita internet; revisa tu red.', 8000);
      } else if (code === 'language-not-supported') {
        aviso('El dictado en español no está disponible en este navegador. Prueba con Chrome o Edge.', 9000);
      } else {
        aviso(`No pude escucharte (${code || 'error de micrófono'}). Inténtalo de nuevo.`, 6000);
      }
    };

    recognition.onend = () => {
      clearTimeout(state.silencioTimer);
      const eraCancelado = state.cancelled;
      const fallo = state.failed;
      const texto = state.finalText.trim();
      state.listening = false;
      state.finalText = '';
      state.cancelled = false;
      state.failed = false;
      if (!state.sending && !el.live.classList.contains('aviso')) showLive(false);
      paintUI();
      if (eraCancelado || fallo || !texto) return;
      sendToNova(texto);
    };

    return recognition;
  }

  function startListening() {
    if (!SpeechRec) {
      showLive(true, 'Dictado no disponible en este navegador. Usa Chrome, Edge o Safari actualizado.');
      el.live.classList.add('aviso');
      el.cancel.classList.remove('hidden');
      return;
    }
    if (state.listening || state.sending) return;
    stopSpeaking({});
    cancelListening(false);
    if (window.NovaChat) window.NovaChat.open();
    primeAudio();
    const rec = ensureRecognition();
    state.cancelled = false;
    state.failed = false;
    state.finalText = '';
    try {
      rec.start();
      state.listening = true;
      el.live.classList.remove('aviso');
      showLive(true, 'Escuchando… habla con naturalidad');
      paintUI();
    } catch (err) {
      // "already started" puede pasar si el navegador aun cierra la sesion
      // anterior: se reintenta una vez en 350 ms.
      if (/already|started/i.test(String(err && err.message))) {
        clearTimeout(state.relanzarTimer);
        state.relanzarTimer = setTimeout(() => startListening(), 350);
      } else {
        aviso('No pude activar el micrófono. Inténtalo de nuevo.', 6000);
      }
    }
  }

  function cancelListening(mensaje) {
    clearTimeout(state.silencioTimer);
    clearTimeout(state.relanzarTimer);
    state.cancelled = true;
    if (recognition && state.listening) {
      try {
        recognition.abort();
      } catch {
        // Ignorado.
      }
    }
    state.listening = false;
    state.finalText = '';
    showLive(false);
    paintUI();
    if (mensaje) aviso('Dictado cancelado.', 2600);
  }

  function onMicPress() {
    if (state.listening) {
      cancelListening(true);
      return;
    }
    // Interrumpir a Nova para poder hablar (requisito: interrumpible).
    if (state.speaking) stopSpeaking({});
    if (state.sending) {
      aviso('Espera a que Nova termine de responder…', 3000);
      return;
    }
    startListening();
  }

  // ------------------------------------------------------------------
  // Envio al mismo asistente del panel y lectura de la respuesta
  // ------------------------------------------------------------------
  async function sendToNova(texto) {
    if (!window.NovaChat) {
      aviso('El asistente no está disponible en esta página.', 6000);
      return;
    }
    state.sending = true;
    el.live.classList.remove('aviso');
    el.cancel.classList.add('hidden');
    showLive(true, 'Nova está pensando…');
    paintUI();
    try {
      const reply = await window.NovaChat.send(texto, { voice: true });
      showLive(false);
      el.cancel.classList.remove('hidden');
      if (!reply) return;
      if (typeof reply === 'object' && reply.error) {
        // El chat ya mostro el error; se avisa tambien en voz alta si se pidio.
        if (state.enabled) speak(`No pude responder. ${reply.error}`);
        return;
      }
      if (state.enabled || state.continuous) speak(reply);
    } finally {
      state.sending = false;
      el.cancel.classList.remove('hidden');
      paintUI();
      if (state.enabled && state.continuous && !state.speaking) {
        clearTimeout(state.relanzarTimer);
        state.relanzarTimer = setTimeout(() => {
          if (!state.speaking && state.enabled && state.continuous) startListening();
        }, 500);
      }
    }
  }

  // ------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------
  function init() {
    loadPrefs();
    if (!bindUI()) return;
    if (synth) {
      loadVoices();
      synth.addEventListener?.('voiceschanged', loadVoices);
      synth.onvoiceschanged = loadVoices;
      // Algunos navegadores tardan en publicar las voces.
      let intentos = 0;
      const t = setInterval(() => {
        intentos += 1;
        loadVoices();
        if (state.voices.length || intentos > 12) clearInterval(t);
      }, 400);
    }
    el.rate.value = String(state.rate);
    paintUI();
    if (!SpeechRec && el.mic) {
      el.mic.classList.add('ai-mic-off');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
