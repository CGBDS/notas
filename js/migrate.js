/* Migración entre teléfonos: exportar / importar identidad + chats.
   El paquete va cifrado con AES-GCM; la clave se deriva (PBKDF2) de un
   código de 6 dígitos de un solo uso. Se transfiere por QR o copiando texto. */
const Migrate = (() => {
  const $ = id => document.getElementById(id);
  const PREFIX = 'CBCHATMIG1.';
  const QR_MAX = 2400;          // el QR solo se ofrece si el texto cabe con margen
  const SIZE_WARN = 150 * 1024; // si el paquete supera esto, se exporta sin fotos

  let ctx = null; // { getKey: () => CryptoKey, getPid: () => string, getState: () => object }
  const _test = { lastCode: null, lastPayload: null };

  /* ---------- base64url seguro para textos grandes ---------- */
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(t) {
    t = t.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  const genMigCode = () => String(Math.floor(100000 + Math.random() * 900000));
  const digitsOnly = s => String(s || '').replace(/\D/g, '').slice(0, 6);

  /* ---------- paquete ---------- */
  function stripMedia(messages) {
    const out = {};
    for (const [cid, arr] of Object.entries(messages || {})) {
      out[cid] = (arr || []).map(m => {
        if (m && m.kind === 'image' && m.media) {
          const { media, ...rest } = m;
          return { ...rest, mediaLost: true };
        }
        return m;
      });
    }
    return out;
  }

  function countMessages(messages) {
    return Object.values(messages || {}).reduce((n, a) => n + (a || []).length, 0);
  }

  function buildPackage() {
    const S = ctx.getState();
    const base = {
      v: 1,
      pid: ctx.getPid(), // 'cbchat-xxxxxx' exacto
      myName: S.myName || '',
      contacts: S.contacts || {},
      groups: S.groups || {},
      exportedAt: Date.now(),
    };
    let pkg = { ...base, messages: S.messages || {}, media: true };
    let mediaSkipped = false;
    if (JSON.stringify(pkg).length > SIZE_WARN) {
      pkg = { ...base, messages: stripMedia(S.messages), media: false };
      mediaSkipped = true;
    }
    return { pkg, mediaSkipped };
  }

  async function makeEnvelope(code) {
    const { pkg, mediaSkipped } = buildPackage();
    const salt = CryptoBox.randomSaltB64();
    const key = await CryptoBox.deriveKeyFrom('mig|' + code, salt);
    const encStr = await CryptoBox.encryptJSON(key, pkg);
    const env = JSON.stringify({ v: 1, salt, enc: encStr });
    return { text: PREFIX + b64urlEncode(env), mediaSkipped };
  }

  async function openEnvelope(text, code) {
    text = String(text || '').trim();
    if (!text.startsWith(PREFIX)) throw new Error('format');
    let env;
    try { env = JSON.parse(b64urlDecode(text.slice(PREFIX.length))); }
    catch (e) { throw new Error('format'); }
    if (!env || env.v !== 1 || !env.salt || !env.enc) throw new Error('format');
    const key = await CryptoBox.deriveKeyFrom('mig|' + code, env.salt);
    let pkg;
    try { pkg = await CryptoBox.decryptJSON(key, env.enc); }
    catch (e) { throw new Error('code'); } // AES-GCM no autentica: código mal o corrupto
    if (!pkg || pkg.v !== 1 || !pkg.pid || !pkg.contacts || !pkg.messages) throw new Error('format');
    return pkg;
  }

  /* ---------- EXPORTAR ---------- */
  function openExport() {
    $('mig-exp-step1').classList.remove('hidden');
    $('mig-exp-done').classList.add('hidden');
    $('btn-mig-generate').classList.remove('hidden');
    $('btn-mig-generate').textContent = 'Generar código';
    $('btn-mig-generate').disabled = false;
    const wipe = $('btn-mig-wipe');
    delete wipe.dataset.armed;
    wipe.textContent = 'Borrar todo en este teléfono';
    $('sheet-mig-export').classList.remove('hidden');
  }

  async function doExport() {
    const btn = $('btn-mig-generate');
    btn.disabled = true;
    btn.textContent = 'Generando…';
    try {
      const code = genMigCode();
      const { text, mediaSkipped } = await makeEnvelope(code);
      _test.lastCode = code;
      _test.lastPayload = text;
      $('mig-exp-code').textContent = code;
      const qrBox = $('mig-qr');
      qrBox.innerHTML = '';
      if (text.length <= QR_MAX && typeof QRCode !== 'undefined') {
        try {
          new QRCode(qrBox, { text, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
        } catch (e) {
          qrBox.innerHTML = '<p class="muted">No se pudo generar el QR. Usa "Copiar texto".</p>';
        }
      } else {
        qrBox.innerHTML = '<p class="muted">El paquete es grande: usa "Copiar texto" y pégalo en el otro teléfono.</p>';
      }
      $('mig-exp-warn-media').classList.toggle('hidden', !mediaSkipped);
      $('mig-exp-step1').classList.add('hidden');
      $('mig-exp-done').classList.remove('hidden');
      btn.classList.add('hidden'); // un solo uso
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      btn.textContent = 'Generar código';
      alert('No se pudo generar el paquete. Inténtalo de nuevo.');
    }
  }

  function copyPayload() {
    const done = () => {
      $('btn-mig-copy').textContent = '¡Copiado!';
      setTimeout(() => $('btn-mig-copy').textContent = 'Copiar texto', 1500);
    };
    const t = _test.lastPayload || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(() => window.prompt('Copia el texto:', t));
    } else {
      window.prompt('Copia el texto:', t);
    }
  }

  function wipePhone() {
    const btn = $('btn-mig-wipe');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Toca otra vez para confirmar el borrado';
      return;
    }
    try { localStorage.clear(); } catch (e) {}
    location.reload();
  }

  /* ---------- IMPORTAR ---------- */
  let scanStop = null;

  function impError(t) {
    const e = $('mig-imp-error');
    if (!t) { e.classList.add('hidden'); return; }
    e.textContent = t;
    e.classList.remove('hidden');
  }

  function openImport() {
    impError(null);
    $('mig-imp-step1').classList.remove('hidden');
    $('mig-imp-step2').classList.add('hidden');
    $('mig-imp-step3').classList.add('hidden');
    $('mig-scan-view').classList.add('hidden');
    $('mig-paste-wrap').classList.add('hidden');
    $('mig-imp-text').value = '';
    $('mig-imp-code').value = '';
    _test.lastPayload = null;
    $('sheet-mig-import').classList.remove('hidden');
  }

  function onPayload(text) {
    text = String(text || '').trim();
    if (!text.startsWith(PREFIX)) {
      impError('QR inválido. Escanea el código que muestra el otro teléfono.');
      return;
    }
    _test.lastPayload = text;
    impError(null);
    $('mig-imp-step1').classList.add('hidden');
    $('mig-scan-view').classList.add('hidden');
    $('mig-imp-step2').classList.remove('hidden');
    setTimeout(() => $('mig-imp-code').focus(), 100);
  }

  async function startScan() {
    impError(null);
    if (typeof jsQR === 'undefined') {
      impError('El escáner no está disponible. Usa "Pegar texto".');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      impError('No se pudo abrir la cámara. Usa "Pegar texto".');
      return;
    }
    $('mig-imp-step1').classList.add('hidden');
    $('mig-scan-view').classList.remove('hidden');
    const video = $('mig-video');
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    const canvas = document.createElement('canvas');
    const g2d = canvas.getContext('2d', { willReadFrequently: true });
    let done = false;
    scanStop = () => {
      done = true;
      try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      video.srcObject = null;
      $('mig-scan-view').classList.add('hidden');
      $('mig-imp-step1').classList.remove('hidden');
    };
    const tick = () => {
      if (done) return;
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        g2d.drawImage(video, 0, 0);
        try {
          const res = jsQR(g2d.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
          if (res && res.data) {
            const t = res.data;
            scanStop(); scanStop = null;
            onPayload(t);
            return;
          }
        } catch (e) { /* sigue intentando */ }
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  async function doDecrypt() {
    impError(null);
    const code = digitsOnly($('mig-imp-code').value);
    if (code.length !== 6) { impError('Escribe los 6 dígitos.'); return; }
    const btn = $('btn-mig-decrypt');
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    try {
      const pkg = await openEnvelope(_test.lastPayload, code);
      _test.lastPkg = pkg;
      const nContacts = Object.keys(pkg.contacts || {}).length;
      const nMsgs = countMessages(pkg.messages);
      const nGroups = Object.keys(pkg.groups || {}).length;
      $('mig-imp-found').textContent = String(pkg.pid || '').toUpperCase();
      $('mig-imp-summary').textContent =
        `${pkg.myName ? 'Nombre: ' + pkg.myName + ' · ' : ''}${nContacts} contacto(s) · ${nGroups} grupo(s) · ${nMsgs} mensaje(s)`;
      const S = ctx.getState();
      const hasData = Object.keys(S.contacts || {}).length > 0 || countMessages(S.messages) > 0;
      $('mig-imp-overwrite-warn').classList.toggle('hidden', !hasData);
      $('mig-imp-step2').classList.add('hidden');
      $('mig-imp-step3').classList.remove('hidden');
    } catch (e) {
      if (e && e.message === 'code') impError('Código incorrecto o paquete dañado. Revísalo e inténtalo de nuevo.');
      else impError('QR inválido o paquete corrupto.');
    }
    btn.disabled = false;
    btn.textContent = 'Recuperar';
  }

  async function doApply() {
    const pkg = _test.lastPkg;
    if (!pkg) return;
    const btn = $('btn-mig-apply');
    btn.disabled = true;
    btn.textContent = 'Pasando…';
    try {
      const suffix = String(pkg.pid).replace(/^cbchat-/i, '');
      localStorage.setItem('notas_pid', suffix);
      localStorage.setItem('notas_migrated', '1');
      const state = {
        myName: pkg.myName || '',
        contacts: pkg.contacts || {},
        groups: pkg.groups || {},
        messages: pkg.messages || {},
        unread: {},
        online: {},
      };
      localStorage.setItem('notas_chat_enc', await CryptoBox.encryptJSON(ctx.getKey(), state));
      location.reload();
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      btn.textContent = 'Pasar todo a este teléfono';
      impError('No se pudo guardar. Inténtalo de nuevo.');
    }
  }

  /* ---------- init ---------- */
  function init(c) {
    ctx = c;
    $('btn-mig-generate').onclick = doExport;
    $('btn-mig-copy').onclick = copyPayload;
    $('btn-mig-wipe').onclick = wipePhone;
    $('sheet-mig-export-close').onclick = () => $('sheet-mig-export').classList.add('hidden');
    $('btn-mig-scan').onclick = startScan;
    $('btn-mig-paste').onclick = () => $('mig-paste-wrap').classList.toggle('hidden');
    $('btn-mig-paste-go').onclick = () => onPayload($('mig-imp-text').value);
    $('mig-imp-code').addEventListener('input', e => { e.target.value = digitsOnly(e.target.value); });
    $('btn-mig-decrypt').onclick = doDecrypt;
    $('btn-mig-apply').onclick = doApply;
    $('sheet-mig-import-close').onclick = () => {
      if (scanStop) { scanStop(); scanStop = null; }
      $('sheet-mig-import').classList.add('hidden');
    };
    $('mig-scan-cancel').onclick = () => { if (scanStop) { scanStop(); scanStop = null; } };
  }

  return { init, openExport, openImport, _test };
})();
