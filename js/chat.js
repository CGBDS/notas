/* Chat P2P estilo WhatsApp — mobile-first, todo P2P sin servidor */
const ChatApp = (() => {
  const $ = id => document.getElementById(id);
  const LS_DATA = 'notas_chat_enc';
  const CHUNK = 64 * 1024;

  let key = null, peer = null, myId = null;
  let S = null;                       // estado cifrado
  const conns = {};                   // pid -> DataConnection
  const incomingFiles = {};           // msgId -> {parts, received, total, meta, gid}
  const mediaBlobs = {};              // msgId -> Blob (videos/archivos, sesión actual)
  const blobURLs = {};                // msgId -> objectURL cache
  let currentChat = null;

  /* ---------- utilidades ---------- */
  const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const isGroup = chatId => chatId.startsWith('g:');
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkify = s => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const fmtTime = ts => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = ts => {
    const d = new Date(ts), t = new Date();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Ayer';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const AV_HUES = [4, 140, 200, 265, 20, 320, 90, 170];
  const hueOf = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 997; return AV_HUES[h % AV_HUES.length]; };
  const avatarBg = s => `background:hsl(${hueOf(s)} 55% 42%)`;
  const initialOf = n => (n || '?').trim().charAt(0).toUpperCase();
  const blobURL = msgId => {
    if (!mediaBlobs[msgId]) return null;
    if (!blobURLs[msgId]) blobURLs[msgId] = URL.createObjectURL(mediaBlobs[msgId]);
    return blobURLs[msgId];
  };
  function toast(t) { console.log('[chat]', t); }

  function blankState() {
    return { myName: '', contacts: {}, groups: {}, messages: {}, unread: {}, online: {} };
  }

  async function persist() {
    try {
      localStorage.setItem(LS_DATA, await CryptoBox.encryptJSON(key, S));
    } catch (e) {
      try {
        for (const cid of Object.keys(S.messages))
          S.messages[cid].forEach(m => { if (m.kind === 'image' && m.media) { m.media = null; m.mediaLost = true; } });
        localStorage.setItem(LS_DATA, await CryptoBox.encryptJSON(key, S));
      } catch (e2) { /* noop */ }
    }
  }

  function myPeerId() {
    let suf = localStorage.getItem('notas_pid');
    if (!suf) { suf = Math.random().toString(36).slice(2, 8); localStorage.setItem('notas_pid', suf); }
    return 'cbchat-' + suf;
  }

  /* ---------- init ---------- */
  async function init(k) {
    key = k;
    const raw = localStorage.getItem(LS_DATA);
    try { S = raw ? await CryptoBox.decryptJSON(key, raw) : blankState(); }
    catch (e) { S = blankState(); }
    if (!S.myName) {
      const n = prompt('¿Cómo te llamas? (tus contactos lo verán)');
      S.myName = (n || 'Yo').trim().slice(0, 30) || 'Yo';
      await persist();
    }
    myId = myPeerId();
    if (typeof Peer === 'undefined') {
      $('chat-app').classList.remove('hidden');
      bindUI();
      $('chat-list').innerHTML = '<div class="empty-chats">Sin conexión a internet.<br>El chat necesita internet<br>para conectar con tus contactos.</div>';
      return;
    }
    startPeer();
    $('chat-app').classList.remove('hidden');
    bindUI(); renderAll(); handleInviteParam();
  }

  function startPeer() {
    peer = new Peer(myId, { debug: 0 });
    peer.on('open', () => renderAll());
    peer.on('connection', onIncomingConn);
    peer.on('call', onIncomingCall);
    peer.on('error', err => {
      if (err && err.type === 'unavailable-id') {
        localStorage.removeItem('notas_pid');
        myId = myPeerId();
        try { peer.destroy(); } catch (e) {}
        startPeer();
      }
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
  }

  /* ---------- conexiones ---------- */
  function ensureConn(pid) {
    return new Promise((resolve, reject) => {
      if (!peer) return reject(new Error('sin-peer'));
      const c = conns[pid];
      if (c && c.open) return resolve(c);
      let conn;
      try { conn = peer.connect(pid, { reliable: true }); }
      catch (e) { return reject(e); }
      const to = setTimeout(() => reject(new Error('timeout')), 15000);
      conn.on('open', () => {
        clearTimeout(to);
        conns[pid] = conn; wireConn(conn);
        conn.send({ kind: 'hello', name: S.myName });
        resolve(conn);
      });
      conn.on('error', () => { clearTimeout(to); reject(new Error('conn-error')); });
    });
  }

  function onIncomingConn(conn) {
    conn.on('open', () => {
      conns[conn.peer] = conn; wireConn(conn);
      conn.send({ kind: 'hello', name: S.myName });
    });
  }

  function wireConn(conn) {
    conn.on('data', d => onData(conn, d));
    conn.on('close', () => {
      delete conns[conn.peer];
      if (S.online[conn.peer]) { S.online[conn.peer] = false; updateStatus(); }
    });
    conn.on('error', () => {});
  }

  function upsertContact(pid, name) {
    if (!pid || pid === myId) return;
    const c = S.contacts[pid] || { id: pid, name: '' };
    if (name) c.name = String(name).slice(0, 30);
    if (!c.name) c.name = pid;
    S.contacts[pid] = c;
    S.online[pid] = true;
  }

  /* ---------- protocolo ---------- */
  async function onData(conn, d) {
    if (!d || !d.kind) return;
    const pid = conn.peer;
    switch (d.kind) {
      case 'hello':
      case 'hello-ack':
        upsertContact(pid, d.name);
        if (d.kind === 'hello') conn.send({ kind: 'hello-ack', name: S.myName });
        conn.send({ kind: 'presence', status: 'online' });
        renderAll(); persist(); updateStatus();
        break;
      case 'presence':
        S.online[pid] = d.status === 'online';
        updateStatus(); break;
      case 'msg':
        receiveMsg(pid, d.m); break;
      case 'read':
        markRead(pid, d.msgId); break;
      case 'typing':
        if (currentChat === pid) showTyping(!!d.on); break;
      case 'file-start': case 'file-chunk': case 'file-end':
        onFileChunk(conn, d); break;
      case 'group-invite':
        S.groups[d.group.gid] = d.group;
        toast('Nuevo grupo: ' + d.group.name);
        renderAll(); persist(); break;
      case 'group-msg':
        onGroupMsg(conn, d); break;
      case 'group-members':
        if (S.groups[d.gid]) { S.groups[d.gid].members = d.members; renderAll(); persist(); updateStatus(); } break;
      case 'group-leave':
        onGroupLeave(d); break;
    }
  }

  function appendMessage(chatId, m) {
    if (!S.messages[chatId]) S.messages[chatId] = [];
    S.messages[chatId].push(m);
    if (S.messages[chatId].length > 500) S.messages[chatId] = S.messages[chatId].slice(-500);
  }

  function receiveMsg(pid, m) {
    appendMessage(pid, { ...m, from: pid, read: false });
    if (currentChat !== pid) {
      S.unread[pid] = (S.unread[pid] || 0) + 1;
      pushNotify((S.contacts[pid] || {}).name || 'Nuevo mensaje', m.kind === 'text' ? m.text : '📎 Archivo');
    } else {
      markRemoteRead(pid, m.id);
    }
    renderAll(); persist();
  }

  function markRead(pid, msgId) {
    const m = (S.messages[pid] || []).find(x => x.id === msgId);
    if (m && m.from === 'me') { m.read = true; if (currentChat === pid) renderMessages(); persist(); }
  }

  function markRemoteRead(pid, msgId) {
    const m = (S.messages[pid] || []).find(x => x.id === msgId);
    if (m) m.read = true;
    const c = conns[pid];
    if (c && c.open) c.send({ kind: 'read', msgId });
  }

  function pushNotify(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body: String(body || '').slice(0, 80) }); } catch (e) {}
    }
  }

  /* ---------- grupos (creador = relay) ---------- */
  function onGroupMsg(conn, d) {
    const g = S.groups[d.gid];
    if (!g) return;
    const chatId = 'g:' + d.gid;
    appendMessage(chatId, { ...d.m });
    if (g.creator === myId) {
      g.members.forEach(mb => {
        if (mb.id !== myId && mb.id !== d.m.from)
          ensureConn(mb.id).then(c => c.send({ kind: 'group-msg', gid: d.gid, m: d.m })).catch(() => {});
      });
    } else if (currentChat !== chatId) {
      S.unread[chatId] = (S.unread[chatId] || 0) + 1;
      pushNotify(g.name, d.m.kind === 'text' ? d.m.name + ': ' + d.m.text : '📎 Archivo');
    }
    renderAll(); persist();
  }

  function onGroupLeave(d) {
    const g = S.groups[d.gid];
    if (!g) return;
    const chatId = 'g:' + d.gid;
    g.members = g.members.filter(mb => mb.id !== d.peerId);
    if (g.creator === myId) {
      broadcastMembers(g);
      systemMsg(chatId, d.name + ' salió del grupo');
    }
    renderAll(); persist();
  }

  function broadcastMembers(g) {
    g.members.forEach(mb => {
      if (mb.id === myId) return;
      ensureConn(mb.id).then(c => c.send({ kind: 'group-members', gid: g.gid, members: g.members })).catch(() => {});
    });
  }

  function systemMsg(chatId, text) {
    appendMessage(chatId, { id: uid(), from: 'sys', name: '', text, ts: Date.now(), kind: 'sys' });
  }

  function sendGroupMsg(chatId, m) {
    const g = S.groups[chatId.slice(2)];
    appendMessage(chatId, m);
    if (!g) return;
    if (g.creator === myId) {
      g.members.forEach(mb => {
        if (mb.id === myId) return;
        ensureConn(mb.id).then(c => c.send({ kind: 'group-msg', gid: g.gid, m })).catch(() => {});
      });
    } else {
      ensureConn(g.creator)
        .then(c => c.send({ kind: 'group-msg', gid: g.gid, m }))
        .catch(() => toast('Grupo no disponible (creador offline)'));
    }
    renderAll(); persist();
  }

  /* ---------- archivos por chunks ---------- */
  function onFileChunk(conn, d) {
    const pid = conn.peer;
    if (d.kind === 'file-start') {
      incomingFiles[d.msgId] = { parts: new Array(d.total), received: 0, total: d.total, meta: d.meta, gid: d.meta.gid };
      if (d.meta.gid) relayFileChunk(pid, d.meta.gid, d);
      return;
    }
    const f = incomingFiles[d.msgId];
    if (!f) return;
    if (d.kind === 'file-chunk') {
      if (f.gid) relayFileChunk(pid, f.gid, d);
      if (!f.parts[d.idx]) { f.parts[d.idx] = d.data; f.received++; }
      updateFileProgress(d.msgId, f.received / f.total);
      return;
    }
    // file-end
    if (f.gid) relayFileChunk(pid, f.gid, d);
    const bin = f.parts.join('');
    const bytes = Uint8Array.from(atob(bin), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: f.meta.mime });
    mediaBlobs[d.msgId] = blob;
    const chatId = f.gid ? 'g:' + f.gid : pid;
    const m = {
      id: d.msgId, from: pid, name: f.meta.senderName, text: '',
      ts: Date.now(), kind: f.meta.kind, fileName: f.meta.name,
      fileSize: f.meta.size, mime: f.meta.mime, read: false
    };
    if (f.meta.kind === 'image') m.media = 'data:' + f.meta.mime + ';base64,' + bin;
    appendMessage(chatId, m);
    delete incomingFiles[d.msgId];
    if (currentChat !== chatId) {
      S.unread[chatId] = (S.unread[chatId] || 0) + 1;
      pushNotify(f.gid ? (S.groups[f.gid] || {}).name || 'Grupo' : (S.contacts[pid] || {}).name || 'Nuevo', '📎 Archivo');
    } else if (!f.gid) markRemoteRead(pid, d.msgId);
    renderAll(); persist();
  }

  function relayFileChunk(senderPid, gid, d) {
    const g = S.groups[gid];
    if (!g || g.creator !== myId) return;
    g.members.forEach(mb => {
      if (mb.id === myId || mb.id === senderPid) return;
      ensureConn(mb.id).then(c => c.send(d)).catch(() => {});
    });
  }

  function dataURLtoBytes(dataUrl) {
    const bin = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
  }
  function downscaleImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function sendFile(chatId, file) {
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
    const msgId = uid();
    const payload = kind === 'image' ? dataURLtoBytes(await downscaleImage(file)) : new Uint8Array(await file.arrayBuffer());
    const total = Math.max(1, Math.ceil(payload.length / CHUNK));
    const m = {
      id: msgId, from: 'me', name: S.myName, text: '', ts: Date.now(), kind,
      fileName: file.name, fileSize: file.size, mime: file.type || 'application/octet-stream',
      ticks: 1, progress: 0
    };
    if (kind === 'image') m.media = 'data:image/jpeg;base64,' + bytesToB64(payload);
    else mediaBlobs[msgId] = new Blob([payload], { type: m.mime });
    appendMessage(chatId, m);
    renderMessages();

    const gid = isGroup(chatId) ? chatId.slice(2) : null;
    const meta = { name: file.name, size: file.size, mime: m.mime, kind, senderName: S.myName, gid };
    let targets = [];
    if (gid) {
      const g = S.groups[gid];
      if (!g) return;
      targets = g.creator === myId
        ? g.members.map(mb => mb.id).filter(id => id !== myId)
        : [g.creator];
    } else targets = [chatId];

    for (const pid of targets) {
      try {
        const c = await ensureConn(pid);
        c.send({ kind: 'file-start', msgId, total, meta });
        for (let i = 0; i < total; i++) {
          c.send({ kind: 'file-chunk', msgId, idx: i, data: bytesToB64(payload.subarray(i * CHUNK, (i + 1) * CHUNK)) });
          m.progress = (i + 1) / total;
          if (i % 4 === 0 || i === total - 1) updateFileProgress(msgId, m.progress);
        }
        c.send({ kind: 'file-end', msgId, meta });
        m.ticks = 2; m.progress = 1;
      } catch (e) { /* siguiente */ }
    }
    renderMessages(); persist();
  }

  function updateFileProgress(msgId, p) {
    const el = document.querySelector('[data-prog="' + msgId + '"]');
    if (el) el.style.width = Math.round(p * 100) + '%';
  }

  /* ---------- UI: lista de chats ---------- */
  function chatEntries() {
    const out = [];
    for (const [gid, g] of Object.entries(S.groups)) {
      const msgs = S.messages['g:' + gid] || [];
      out.push({ chatId: 'g:' + gid, name: g.name, group: true, last: msgs[msgs.length - 1], unread: S.unread['g:' + gid] || 0 });
    }
    for (const [pid, c] of Object.entries(S.contacts)) {
      const msgs = S.messages[pid] || [];
      out.push({ chatId: pid, name: c.name, group: false, last: msgs[msgs.length - 1], unread: S.unread[pid] || 0 });
    }
    out.sort((a, b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0));
    return out;
  }

  function previewOf(m) {
    if (!m) return 'Sin mensajes';
    if (m.kind === 'image') return '📷 Foto';
    if (m.kind === 'video') return '🎬 Video';
    if (m.kind === 'file') return '📄 ' + (m.fileName || 'Archivo');
    if (m.kind === 'sys') return m.text;
    return String(m.text).slice(0, 60);
  }

  function renderChatList() {
    const list = $('chat-list');
    const entries = chatEntries();
    list.innerHTML = '';
    if (!entries.length) {
      list.innerHTML = '<div class="empty-chats">Todavía no tienes chats.<br>Toca 💬 para agregar a alguien<br>con su código.</div>';
      return;
    }
    entries.forEach(e => {
      const row = document.createElement('div');
      row.className = 'chat-row';
      const av = document.createElement('div');
      av.className = 'avatar'; av.setAttribute('style', avatarBg(e.name));
      av.textContent = initialOf(e.name) + (e.group ? ' 👥' : '');
      const meta = document.createElement('div'); meta.className = 'chat-meta';
      const top = document.createElement('div'); top.className = 'chat-top';
      const nm = document.createElement('span'); nm.className = 'chat-name'; nm.textContent = e.name;
      const tm = document.createElement('span'); tm.className = 'chat-time'; tm.textContent = e.last ? fmtTime(e.last.ts) : '';
      top.append(nm, tm);
      const bot = document.createElement('div'); bot.className = 'chat-bottom';
      const pv = document.createElement('span'); pv.className = 'chat-preview'; pv.textContent = previewOf(e.last);
      bot.append(pv);
      if (e.unread) {
        const b = document.createElement('span'); b.className = 'unread'; b.textContent = e.unread;
        bot.append(b);
      }
      meta.append(top, bot);
      row.append(av, meta);
      row.onclick = () => openChat(e.chatId);
      list.appendChild(row);
    });
  }

  /* ---------- UI: conversación ---------- */
  function openChat(chatId) {
    currentChat = chatId;
    $('view-chats').classList.add('hidden');
    $('view-conv').classList.remove('hidden');
    const name = isGroup(chatId) ? ((S.groups[chatId.slice(2)] || {}).name || 'Grupo') : ((S.contacts[chatId] || {}).name || chatId);
    $('conv-name').textContent = name;
    const av = $('conv-avatar');
    av.textContent = initialOf(name); av.setAttribute('style', avatarBg(name));
    const grp = isGroup(chatId);
    $('btn-call-voice').style.display = grp ? 'none' : '';
    $('btn-call-video').style.display = grp ? 'none' : '';
    updateStatus();
    (S.messages[chatId] || []).forEach(m => { if (m.from !== 'me' && m.from !== 'sys' && !m.read) markRemoteRead(chatId, m.id); });
    S.unread[chatId] = 0;
    renderMessages(); renderChatList(); persist();
  }

  function closeChat() {
    currentChat = null; showTyping(false);
    $('view-conv').classList.add('hidden');
    $('view-chats').classList.remove('hidden');
    renderChatList();
  }

  function updateStatus() {
    if (!currentChat) return;
    if (isGroup(currentChat)) {
      const g = S.groups[currentChat.slice(2)];
      $('conv-status').textContent = g ? g.members.length + ' participantes' : '';
    } else {
      $('conv-status').textContent = S.online[currentChat] ? 'en línea' : 'desconectado';
    }
  }

  function showTyping(on) { $('typing-bar').classList.toggle('hidden', !on); }

  function renderMessages() {
    if (!currentChat) return;
    const box = $('messages');
    const arr = S.messages[currentChat] || [];
    box.innerHTML = '';
    let lastDay = '';
    const grp = isGroup(currentChat);
    arr.forEach(m => {
      const day = fmtDay(m.ts);
      if (day !== lastDay) {
        lastDay = day;
        const dv = document.createElement('div');
        dv.className = 'day-divider'; dv.textContent = day;
        box.appendChild(dv);
      }
      box.appendChild(msgEl(m, grp));
    });
    box.scrollTop = box.scrollHeight;
  }

  function msgEl(m, showSender) {
    const d = document.createElement('div');
    if (m.from === 'sys') {
      d.className = 'msg';
      d.style.cssText = 'align-self:center;background:var(--panel2);color:var(--muted);font-size:13px;font-style:italic';
      d.textContent = m.text;
      return d;
    }
    d.className = 'msg ' + (m.from === 'me' ? 'out' : 'in');
    if (showSender && m.from !== 'me') {
      const s = document.createElement('div'); s.className = 'sender'; s.textContent = m.name || ''; d.append(s);
    }
    if (m.kind === 'text') {
      const t = document.createElement('div'); t.innerHTML = linkify(m.text); d.append(t);
    } else if (m.kind === 'image') {
      if (m.media) {
        const img = document.createElement('img');
        img.className = 'msg-img'; img.src = m.media;
        img.onclick = () => { $('viewer-img').src = m.media; $('image-viewer').classList.remove('hidden'); };
        d.append(img);
      } else {
        const t = document.createElement('div'); t.innerHTML = '📷 <i>Foto no disponible</i>'; d.append(t);
      }
    } else if (m.kind === 'video') {
      const url = blobURL(m.id);
      if (url) { const v = document.createElement('video'); v.controls = true; v.src = url; v.setAttribute('playsinline', ''); d.append(v); }
      else { const t = document.createElement('div'); t.innerHTML = '🎬 <i>Video no disponible</i>'; d.append(t); }
    } else if (m.kind === 'file') {
      const chip = document.createElement('div'); chip.className = 'file-chip';
      chip.innerHTML = '📄 <span></span>';
      const sp = chip.querySelector('span');
      sp.innerHTML = '<br><small></small>';
      sp.childNodes[0].textContent = m.fileName || 'Archivo';
      sp.querySelector('small').textContent = fmtSize(m.fileSize || 0);
      if (blobURL(m.id)) chip.onclick = () => {
        const a = document.createElement('a');
        a.href = blobURL(m.id); a.download = m.fileName || 'archivo'; a.click();
      };
      d.append(chip);
    }
    if (m.progress !== undefined && m.progress < 1) {
      const pr = document.createElement('div'); pr.className = 'progress';
      pr.innerHTML = `<div data-prog="${m.id}" style="width:${Math.round(m.progress * 100)}%"></div>`;
      d.append(pr);
    }
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.append(document.createTextNode(fmtTime(m.ts) + ' '));
    if (m.from === 'me') {
      const tk = document.createElement('span');
      tk.className = 'ticks' + (m.read ? ' read' : ''); tk.textContent = '✓✓';
      meta.append(tk);
    }
    d.append(meta);
    return d;
  }

  /* ---------- enviar texto ---------- */
  function sendText() {
    const inp = $('msg-input');
    const text = inp.value.trim();
    if (!text || !currentChat) return;
    const m = { id: uid(), from: 'me', name: S.myName, text, ts: Date.now(), kind: 'text', ticks: 1 };
    inp.value = '';
    sendTyping(false);
    if (isGroup(currentChat)) sendGroupMsg(currentChat, m);
    else {
      appendMessage(currentChat, m);
      renderMessages();
      ensureConn(currentChat)
        .then(c => { c.send({ kind: 'msg', m }); m.ticks = 2; renderMessages(); persist(); })
        .catch(() => toast('Sin conexión con esa persona'));
      persist();
    }
  }

  let typingDeb = null;
  function sendTyping(on) {
    if (!currentChat || isGroup(currentChat)) return;
    const c = conns[currentChat];
    if (c && c.open) { try { c.send({ kind: 'typing', on }); } catch (e) {} }
  }

  /* ---------- contactos y grupos (UI) ---------- */
  async function addContact() {
    const err = $('add-error');
    err.classList.add('hidden');
    const code = $('add-code').value.trim().toLowerCase();
    const name = $('add-name').value.trim().slice(0, 30);
    if (!code) { err.textContent = 'Escribe el código.'; err.classList.remove('hidden'); return; }
    if (code === myId) { err.textContent = 'Ese es tu propio código.'; err.classList.remove('hidden'); return; }
    $('add-ok').textContent = 'Conectando…';
    try {
      await ensureConn(code);
      if (name && S.contacts[code]) S.contacts[code].name = name;
      await persist();
      $('sheet-new').classList.add('hidden');
      $('add-code').value = ''; $('add-name').value = '';
      renderAll(); openChat(code);
    } catch (e) {
      err.textContent = 'No se pudo conectar. Revisa el código y que la otra persona tenga la app abierta.';
      err.classList.remove('hidden');
    }
    $('add-ok').textContent = 'Agregar';
  }

  function renderGroupPick() {
    const box = $('group-pick');
    const cs = Object.values(S.contacts);
    box.innerHTML = '';
    if (!cs.length) { box.innerHTML = '<p class="muted">Primero agrega personas.</p>'; return; }
    cs.forEach(c => {
      const r = document.createElement('label');
      r.className = 'pick-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c.id;
      const av = document.createElement('div');
      av.className = 'avatar'; av.setAttribute('style', avatarBg(c.name) + ';width:40px;height:40px;font-size:16px');
      av.textContent = initialOf(c.name);
      const nm = document.createElement('span'); nm.textContent = c.name;
      r.append(cb, av, nm);
      box.appendChild(r);
    });
  }

  async function createGroup() {
    const err = $('group-error');
    err.classList.add('hidden');
    const name = $('group-name').value.trim().slice(0, 40);
    const picked = [...document.querySelectorAll('#group-pick input:checked')].map(i => i.value);
    if (!name) { err.textContent = 'Ponle nombre al grupo.'; err.classList.remove('hidden'); return; }
    if (!picked.length) { err.textContent = 'Elige al menos una persona.'; err.classList.remove('hidden'); return; }
    const gid = 'g' + Date.now().toString(36);
    const members = [{ id: myId, name: S.myName },
      ...picked.map(pid => ({ id: pid, name: (S.contacts[pid] || {}).name || pid }))];
    const group = { gid, name, creator: myId, members };
    S.groups[gid] = group;
    const chatId = 'g:' + gid;
    systemMsg(chatId, 'Creaste el grupo');
    for (const pid of picked) {
      try { (await ensureConn(pid)).send({ kind: 'group-invite', group }); } catch (e) { /* offline */ }
    }
    await persist();
    $('sheet-new').classList.add('hidden');
    $('group-name').value = '';
    renderAll(); openChat(chatId);
  }

  function handleInviteParam() {
    const p = new URLSearchParams(location.search).get('add');
    if (p) {
      $('sheet-new').classList.remove('hidden');
      $('add-code').value = p.toUpperCase();
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
    }
  }

  /* ---------- llamadas ---------- */
  let activeCall = null, callInt = null, localStream = null, pendingCall = null;

  function showActiveCall(chatId, mode, call, remoteName) {
    $('active-call').classList.remove('hidden');
    $('call-name').textContent = remoteName + (mode === 'screen' ? ' · pantalla' : mode === 'video' ? ' · video' : '');
    const voiceOnly = mode === 'voice';
    $('remote-video').style.display = voiceOnly ? 'none' : '';
    $('remote-avatar-fallback').classList.toggle('hidden', !voiceOnly);
    $('remote-avatar-fallback').textContent = initialOf(remoteName);
    activeCall = { chatId, mode, call };
    const t0 = Date.now();
    clearInterval(callInt);
    callInt = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('call-timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
    call.on('stream', st => { $('remote-video').srcObject = st; });
    call.on('close', () => hangup());
    call.on('error', () => hangup());
  }

  function stopTracks() {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    $('local-video').srcObject = null; $('remote-video').srcObject = null;
  }

  function hangup() {
    if (activeCall) { try { activeCall.call.close(); } catch (e) {} activeCall = null; }
    clearInterval(callInt);
    stopTracks();
    $('active-call').classList.add('hidden');
  }

  async function startCall(chatId, mode) {
    if (!chatId || isGroup(chatId) || !peer) return;
    try {
      localStream = mode === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({ video: mode === 'video', audio: true });
    } catch (e) { alert('No se pudo acceder a cámara/micrófono/pantalla.'); return; }
    $('local-video').srcObject = localStream;
    let call;
    try { call = peer.call(chatId, localStream, { metadata: { mode, name: S.myName } }); }
    catch (e) { stopTracks(); alert('No se pudo iniciar la llamada.'); return; }
    showActiveCall(chatId, mode, call, (S.contacts[chatId] || {}).name || chatId);
  }

  function onIncomingCall(call) {
    const md = call.metadata || {};
    pendingCall = call;
    $('incoming-name').textContent = md.name || call.peer;
    const av = $('incoming-avatar');
    av.textContent = initialOf(md.name || '?');
    av.setAttribute('style', avatarBg(md.name || '?'));
    $('incoming-type').textContent = md.mode === 'video' ? 'Videollamada entrante…' : md.mode === 'screen' ? 'Quiere compartir pantalla…' : 'Llamada entrante…';
    $('incoming-call').classList.remove('hidden');
    try {
      const ring = new Audio();
      // tono simple con WebAudio
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 440; g.gain.value = 0.08;
      o.start(); o.stop(ctx.currentTime + 0.8);
    } catch (e) {}
    call.on('close', () => { $('incoming-call').classList.add('hidden'); pendingCall = null; });
  }

  async function acceptCall() {
    const call = pendingCall;
    if (!call) return;
    $('incoming-call').classList.add('hidden');
    const mode = (call.metadata || {}).mode || 'voice';
    try {
      localStream = mode === 'screen' ? null
        : await navigator.mediaDevices.getUserMedia({ video: mode === 'video', audio: true });
    } catch (e) { localStream = null; }
    if (localStream) $('local-video').srcObject = localStream;
    try { call.answer(localStream || undefined); } catch (e) {}
    const pid = call.peer;
    showActiveCall(pid, mode, call, (S.contacts[pid] || {}).name || (call.metadata || {}).name || pid);
    pendingCall = null;
  }

  function rejectCall() {
    if (pendingCall) { try { pendingCall.close(); } catch (e) {} pendingCall = null; }
    $('incoming-call').classList.add('hidden');
  }

  async function toggleScreen() {
    if (!activeCall) return;
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const track = screen.getVideoTracks()[0];
      const pc = activeCall.call.peerConnection;
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      else pc.addTrack(track, screen);
      if (localStream) localStream.getVideoTracks().forEach(t => t.stop());
      localStream = screen;
      $('local-video').srcObject = screen;
      $('remote-video').style.display = '';
      $('remote-avatar-fallback').classList.add('hidden');
      $('call-name').textContent += ' · pantalla';
      activeCall.mode = 'screen';
    } catch (e) { /* cancelado */ }
  }

  /* ---------- bind UI ---------- */
  function bindUI() {
    $('chat-back-notes').onclick = () => {
      if (currentChat) closeChat();
      $('chat-app').classList.add('hidden');
      $('notes-app').classList.remove('hidden');
    };
    $('conv-back').onclick = closeChat;
    $('chat-fab').onclick = () => $('sheet-new').classList.remove('hidden');
    $('sheet-new-close').onclick = () => $('sheet-new').classList.add('hidden');
    $('tab-add').onclick = () => {
      $('tab-add').classList.add('active'); $('tab-group').classList.remove('active');
      $('pane-add').classList.remove('hidden'); $('pane-group').classList.add('hidden');
    };
    $('tab-group').onclick = () => {
      $('tab-group').classList.add('active'); $('tab-add').classList.remove('active');
      $('pane-group').classList.remove('hidden'); $('pane-add').classList.add('hidden');
      renderGroupPick();
    };
    $('add-ok').onclick = addContact;
    $('group-ok').onclick = createGroup;
    $('btn-profile').onclick = () => {
      $('profile-name').value = S.myName;
      $('profile-code').textContent = myId.toUpperCase();
      $('sheet-profile').classList.remove('hidden');
    };
    $('sheet-profile-close').onclick = () => {
      const n = $('profile-name').value.trim().slice(0, 30);
      if (n) { S.myName = n; persist(); }
      $('sheet-profile').classList.add('hidden');
    };
    $('btn-copy-code').onclick = () => {
      const done = () => { $('btn-copy-code').textContent = '¡Copiado!'; setTimeout(() => $('btn-copy-code').textContent = 'Copiar', 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(myId.toUpperCase()).then(done).catch(() => {});
      else done();
    };
    $('btn-copy-invite').onclick = () => {
      const link = location.origin + location.pathname + '?add=' + myId.toUpperCase();
      const done = () => { $('btn-copy-invite').textContent = '¡Link copiado!'; setTimeout(() => $('btn-copy-invite').textContent = 'Copiar link de invitación', 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(link).then(done).catch(() => {});
      else done();
    };
    $('btn-send').onclick = sendText;
    $('msg-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
    $('msg-input').addEventListener('input', () => {
      sendTyping(true);
      clearTimeout(typingDeb);
      typingDeb = setTimeout(() => sendTyping(false), 2500);
    });
    $('file-input').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f && currentChat) sendFile(currentChat, f).catch(() => toast('No se pudo enviar'));
      e.target.value = '';
    });
    $('btn-call-voice').onclick = () => startCall(currentChat, 'voice');
    $('btn-call-video').onclick = () => startCall(currentChat, 'video');
    $('viewer-close').onclick = () => $('image-viewer').classList.add('hidden');
    $('incoming-reject').onclick = rejectCall;
    $('incoming-accept').onclick = acceptCall;
    $('btn-hangup').onclick = hangup;
    $('btn-toggle-screen').onclick = toggleScreen;
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) {}
    }
  }

  function renderAll() { renderChatList(); if (currentChat) { renderMessages(); updateStatus(); } }

  return { init };
})();
