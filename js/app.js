/* App de notas (disfraz) + PIN táctil */
const NotesApp = (() => {
  const LS_NOTES = 'notas_notes';
  let editingId = null;
  const $ = id => document.getElementById(id);
  const load = () => { try { return JSON.parse(localStorage.getItem(LS_NOTES) || '[]'); } catch { return []; } };
  const save = n => localStorage.setItem(LS_NOTES, JSON.stringify(n));

  function render(filter = '') {
    const list = $('notes-list');
    const notes = load().filter(n =>
      (n.title + ' ' + n.body).toLowerCase().includes(filter.toLowerCase()));
    if (!notes.length) {
      list.innerHTML = '<div class="empty-notes">Sin notas todavía.<br>Toca + para crear una.</div>';
      return;
    }
    list.innerHTML = '';
    notes.sort((a, b) => b.updated - a.updated).forEach(n => {
      const d = document.createElement('div');
      d.className = 'note-card';
      const date = new Date(n.updated).toLocaleDateString('es', { day: 'numeric', month: 'short' });
      const h = document.createElement('h4'); h.textContent = n.title || 'Sin título';
      const p = document.createElement('p'); p.textContent = n.body || '';
      const s = document.createElement('small'); s.textContent = date;
      d.append(h, p, s);
      d.onclick = () => openEditor(n.id);
      list.appendChild(d);
    });
  }

  function openEditor(id) {
    editingId = id || null;
    const notes = load();
    const n = id ? notes.find(x => x.id === id) : null;
    $('note-title-input').value = n ? n.title : '';
    $('note-body-input').value = n ? n.body : '';
    $('note-delete').classList.toggle('hidden', !n);
    $('note-editor').classList.remove('hidden');
    setTimeout(() => $('note-title-input').focus(), 50);
  }
  function closeEditor() { $('note-editor').classList.add('hidden'); editingId = null; }

  function init() {
    render();
    $('notes-fab').onclick = () => openEditor(null);
    $('note-cancel').onclick = closeEditor;
    $('note-save').onclick = () => {
      const notes = load();
      const title = $('note-title-input').value.trim();
      const body = $('note-body-input').value.trim();
      if (!title && !body) { closeEditor(); return; }
      if (editingId) {
        const n = notes.find(x => x.id === editingId);
        if (n) { n.title = title; n.body = body; n.updated = Date.now(); }
      } else {
        notes.push({ id: 'n' + Date.now().toString(36), title, body, updated: Date.now() });
      }
      save(notes); closeEditor(); render($('notes-search').value);
    };
    $('note-delete').onclick = () => {
      save(load().filter(x => x.id !== editingId));
      closeEditor(); render($('notes-search').value);
    };
    $('notes-search').oninput = e => render(e.target.value);

    if (!localStorage.getItem('notas_seeded')) {
      const now = Date.now();
      save([
        { id: 'nseed1', title: 'Lista de compras', body: 'Pan\nLeche\nCafé\nQueso', updated: now - 86400000 * 2 },
        { id: 'nseed2', title: 'Ideas', body: 'Terminar el informe del viernes.', updated: now - 86400000 },
      ]);
      localStorage.setItem('notas_seeded', '1');
      render();
    }
  }
  return { init };
})();

/* PIN: triple-tap o long-press en el encabezado abre el teclado */
const LockScreen = (() => {
  const $ = id => document.getElementById(id);
  const LS_HASH = 'notas_pw_hash';
  let mode = 'unlock';       // 'setup' | 'setup2' | 'unlock'
  let pin = '', firstPin = '';
  let taps = 0, tapTimer = null, pressTimer = null;

  const hasPIN = () => !!localStorage.getItem(LS_HASH);

  function paintDots() {
    const dots = $('pin-dots').children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < pin.length);
  }
  function err(t) {
    const e = $('lock-error');
    if (!t) { e.classList.add('hidden'); return; }
    e.textContent = t; e.classList.remove('hidden');
  }

  function show() {
    $('notes-app').classList.add('hidden');
    $('lock-screen').classList.remove('hidden');
    pin = ''; firstPin = ''; err(null); paintDots();
    if (!hasPIN()) {
      mode = 'setup';
      $('lock-title').textContent = 'Crea tu PIN';
      $('lock-sub').textContent = 'De 4 a 8 dígitos. Solo tú podrás entrar aquí.';
    } else {
      mode = 'unlock';
      $('lock-title').textContent = 'Escribe tu PIN';
      $('lock-sub').textContent = '';
    }
  }
  function hide() {
    $('lock-screen').classList.add('hidden');
    if ($('chat-app').classList.contains('hidden')) $('notes-app').classList.remove('hidden');
  }

  function press(d) {
    err(null);
    if (pin.length >= 8) return;
    pin += d; paintDots();
    if (mode === 'unlock' && pin.length === 8) submit();
  }
  function del() { pin = pin.slice(0, -1); paintDots(); err(null); }

  async function submit() {
    if (pin.length < 4) { err('Mínimo 4 dígitos.'); return; }
    if (mode === 'setup') {
      firstPin = pin; pin = ''; paintDots();
      mode = 'setup2';
      $('lock-title').textContent = 'Repite tu PIN';
      $('lock-sub').textContent = '';
      return;
    }
    if (mode === 'setup2') {
      if (pin !== firstPin) {
        err('No coinciden. Empieza de nuevo.');
        pin = ''; firstPin = ''; paintDots(); mode = 'setup';
        $('lock-title').textContent = 'Crea tu PIN';
        return;
      }
      localStorage.setItem(LS_HASH, await CryptoBox.sha256Hex('notas|' + pin));
      enterChat(await CryptoBox.deriveKey(pin));
      pin = '';
      return;
    }
    const hash = await CryptoBox.sha256Hex('notas|' + pin);
    if (hash !== localStorage.getItem(LS_HASH)) {
      err('PIN incorrecto.'); pin = ''; paintDots(); return;
    }
    enterChat(await CryptoBox.deriveKey(pin));
    pin = '';
  }

  async function enterChat(k) {
    $('lock-screen').classList.add('hidden');
    $('notes-app').classList.add('hidden');
    try { await ChatApp.init(k); }
    catch (e) { console.error(e); hide(); }
  }

  function init() {
    document.querySelectorAll('#pin-pad [data-d]').forEach(b =>
      b.addEventListener('click', () => press(b.dataset.d)));
    $('pin-del').addEventListener('click', del);
    $('pin-ok').addEventListener('click', submit);
    $('lock-back').onclick = hide;

    const title = $('notes-title');
    title.addEventListener('click', () => {
      taps++; clearTimeout(tapTimer);
      tapTimer = setTimeout(() => taps = 0, 600);
      if (taps >= 3) { taps = 0; show(); }
    });
    const header = $('notes-header');
    const start = () => { pressTimer = setTimeout(show, 700); };
    const cancel = () => clearTimeout(pressTimer);
    header.addEventListener('touchstart', start, { passive: true });
    ['touchend', 'touchcancel', 'touchmove'].forEach(ev => header.addEventListener(ev, cancel, { passive: true }));
    header.addEventListener('mousedown', start);
    ['mouseup', 'mouseleave'].forEach(ev => header.addEventListener(ev, cancel));
  }
  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  NotesApp.init();
  LockScreen.init();
});
