'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_ELEMENTS = 50000;
const MAX_PAGES = 100;
const ROOM_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const PAGE_RE = /^[a-zA-Z0-9_-]{1,24}$/;
const TYPES = new Set(['stroke', 'shape', 'text', 'image', 'formula']);
const BGS = new Set(['grid', 'lines', 'dots', 'blank']);
const THEMES = new Set(['light', 'dark', 'green']);
const USER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000'];

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 25e6 });

const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false }));
// Knihovny načítané až při použití (vzorce, PDF) – hostované lokálně, bez CDN
app.use('/vendor/mathjax', express.static(path.join(__dirname, 'node_modules/mathjax/es5'), { maxAge: '7d' }));
app.get('/vendor/jspdf.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/jspdf/dist/jspdf.umd.min.js')));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/new', (req, res) => {
  // Nová tabule: kdo ji založí, dostane lektorský klíč (v # části odkazu, nikam se neposílá)
  const id = newRoomId();
  const room = getRoom(id);
  room.ownerKey = crypto.randomBytes(12).toString('base64url');
  saveRoom(room);
  room.unloadTimer = setTimeout(() => { if (!room.users.size) rooms.delete(id); }, 60000);
  res.redirect('/b/' + id + '#owner=' + room.ownerKey);
});
app.get('/b/:id', (req, res) => {
  if (!ROOM_RE.test(req.params.id)) return res.redirect('/');
  res.sendFile(path.join(pub, 'board.html'));
});

function newRoomId() {
  return crypto.randomBytes(6).toString('base64url');
}

/* ---------- Rooms & persistence ---------- */

const rooms = new Map();

function roomFile(id) {
  return path.join(DATA_DIR, id + '.json');
}

function defaultMeta() {
  return { bg: 'grid', theme: 'light', pages: [{ id: 'p1' }], title: '', locked: false };
}

function getRoom(id) {
  let room = rooms.get(id);
  if (room) {
    clearTimeout(room.unloadTimer);
    return room;
  }
  room = { id, elements: new Map(), meta: defaultMeta(), ownerKey: null, users: new Map(), saveTimer: null };
  try {
    const data = JSON.parse(fs.readFileSync(roomFile(id), 'utf8'));
    for (const el of data.elements || []) room.elements.set(el.id, el);
    if (data.meta) room.meta = { ...room.meta, ...data.meta };
    if (data.ownerKey) room.ownerKey = data.ownerKey;
  } catch (e) {
    /* nová tabule */
  }
  rooms.set(id, room);
  return room;
}

function serialize(room) {
  return JSON.stringify({ meta: room.meta, ownerKey: room.ownerKey, elements: [...room.elements.values()] });
}

function saveRoom(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = null;
  const file = roomFile(room.id);
  const tmp = file + '.tmp';
  fs.writeFile(tmp, serialize(room), (err) => {
    if (err) return console.error('Uložení selhalo', err);
    fs.rename(tmp, file, (err2) => err2 && console.error('Uložení selhalo', err2));
  });
}

function scheduleSave(room) {
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => saveRoom(room), 2000);
}

function validElement(el) {
  return el && typeof el === 'object' && typeof el.id === 'string' && el.id.length <= 64 && TYPES.has(el.type);
}

const pageOf = (el) => el.page || 'p1';

/* ---------- Realtime ---------- */

io.on('connection', (socket) => {
  const { room: roomId, name, clientId, ownerKey } = socket.handshake.auth || {};
  if (typeof roomId !== 'string' || !ROOM_RE.test(roomId)) {
    socket.disconnect(true);
    return;
  }
  const room = getRoom(roomId);
  const usedColors = new Set([...room.users.values()].map((u) => u.color));
  const color = USER_COLORS.find((c) => !usedColors.has(c)) || USER_COLORS[room.users.size % USER_COLORS.length];
  const isOwner = !!room.ownerKey && ownerKey === room.ownerKey;
  const user = {
    id: socket.id,
    clientId: String(clientId || '').slice(0, 64),
    name: String(name || 'Host').slice(0, 40),
    color,
    isOwner,
  };
  room.users.set(socket.id, user);
  socket.join(roomId);

  // Tabule bez lektora (starší) = všichni mají plná práva
  const hasOwner = () => !!room.ownerKey;
  const privileged = () => isOwner || !hasOwner();
  const canEdit = () => privileged() || !room.meta.locked;

  socket.emit('init', {
    you: user,
    hasOwner: hasOwner(),
    users: [...room.users.values()],
    meta: room.meta,
    elements: [...room.elements.values()],
  });
  socket.to(roomId).emit('user-joined', user);

  const to = () => socket.to(roomId);
  const denied = () => socket.emit('denied', 'Lektor tabuli uzamkl.');

  socket.on('add', (els) => {
    if (!canEdit()) return denied();
    if (!Array.isArray(els)) els = [els];
    const ok = [];
    for (const el of els) {
      if (!validElement(el)) continue;
      if (room.elements.size >= MAX_ELEMENTS && !room.elements.has(el.id)) break;
      room.elements.set(el.id, el);
      ok.push(el);
    }
    if (ok.length) {
      to().emit('add', ok);
      scheduleSave(room);
    }
  });

  socket.on('update', (msg) => {
    if (!canEdit()) return denied();
    if (!msg || typeof msg.id !== 'string' || !msg.props || typeof msg.props !== 'object') return;
    const el = room.elements.get(msg.id);
    if (!el) return;
    const props = { ...msg.props };
    delete props.id;
    delete props.type;
    Object.assign(el, props);
    to().emit('update', { id: msg.id, props });
    scheduleSave(room);
  });

  socket.on('delete', (ids) => {
    if (!canEdit()) return denied();
    if (!Array.isArray(ids)) return;
    const done = ids.filter((id) => room.elements.delete(id));
    if (done.length) {
      to().emit('delete', done);
      scheduleSave(room);
    }
  });

  // Vymazání strany – jen lektor
  socket.on('clear', (msg) => {
    if (!privileged()) return socket.emit('denied', 'Celou stranu může vymazat jen lektor.');
    const page = msg && typeof msg.page === 'string' ? msg.page : 'p1';
    for (const [id, el] of room.elements) if (pageOf(el) === page) room.elements.delete(id);
    to().emit('clear', { page });
    scheduleSave(room);
  });

  socket.on('meta', (m) => {
    if (!m || typeof m !== 'object') return;
    const meta = room.meta;
    const removedPages = [];
    if (canEdit()) {
      if (BGS.has(m.bg)) meta.bg = m.bg;
      if (THEMES.has(m.theme)) meta.theme = m.theme;
      if (Array.isArray(m.pages) && m.pages.length && m.pages.length <= MAX_PAGES) {
        const pages = m.pages.filter((p) => p && PAGE_RE.test(p.id)).map((p) => ({ id: p.id }));
        const ids = new Set(pages.map((p) => p.id));
        const removed = meta.pages.filter((p) => !ids.has(p.id)).map((p) => p.id);
        if (pages.length && (!removed.length || privileged())) {
          meta.pages = pages;
          removedPages.push(...removed);
        }
      }
    }
    if (privileged()) {
      if (typeof m.title === 'string') meta.title = m.title.slice(0, 80);
      if (typeof m.locked === 'boolean') meta.locked = m.locked;
    }
    if (removedPages.length) {
      const del = [];
      for (const [id, el] of room.elements) if (removedPages.includes(pageOf(el))) { room.elements.delete(id); del.push(id); }
      if (del.length) io.to(roomId).emit('delete', del);
    }
    io.to(roomId).emit('meta', meta);
    scheduleSave(room);
  });

  // Rozpracované tahy, kurzory, laser a pohled lektora (neukládá se, jen se přeposílá)
  socket.on('draft', (d) => d && to().volatile.emit('draft', { ...d, user: socket.id }));
  socket.on('draft-end', (id) => to().emit('draft-end', { id, user: socket.id }));
  socket.on('cursor', (c) => c && to().volatile.emit('cursor', { x: c.x, y: c.y, page: c.page, user: socket.id }));
  socket.on('laser', (l) => l && to().volatile.emit('laser', { ...l, user: socket.id }));
  socket.on('view', (v) => { if (isOwner && v) to().volatile.emit('teacher-view', { ...v, user: socket.id }); });
  socket.on('want-view', () => to().emit('want-view'));

  socket.on('rename', (newName) => {
    user.name = String(newName || 'Host').slice(0, 40);
    io.to(roomId).emit('user-updated', user);
  });

  socket.on('disconnect', () => {
    room.users.delete(socket.id);
    to().emit('user-left', socket.id);
    if (room.users.size === 0) {
      saveRoom(room);
      // Z paměti uvolníme až po chvíli (refresh stránky nemusí znovu číst disk)
      room.unloadTimer = setTimeout(() => {
        if (room.users.size === 0 && rooms.get(roomId) === room) {
          if (room.saveTimer) saveRoom(room);
          rooms.delete(roomId);
        }
      }, 60000);
    }
  });
});

function shutdown() {
  for (const room of rooms.values()) {
    try {
      fs.writeFileSync(roomFile(room.id), serialize(room));
    } catch (e) {
      console.error(e);
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`Online tabule běží na http://localhost:${PORT}`));
