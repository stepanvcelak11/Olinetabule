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
const ROOM_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const TYPES = new Set(['stroke', 'shape', 'text', 'image']);
const USER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000'];

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 25e6 });

const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/new', (req, res) => res.redirect('/b/' + newRoomId()));
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

function getRoom(id) {
  let room = rooms.get(id);
  if (room) {
    clearTimeout(room.unloadTimer);
    return room;
  }
  room = { id, elements: new Map(), meta: { bg: 'grid' }, users: new Map(), saveTimer: null };
  try {
    const data = JSON.parse(fs.readFileSync(roomFile(id), 'utf8'));
    for (const el of data.elements || []) room.elements.set(el.id, el);
    if (data.meta) room.meta = { ...room.meta, ...data.meta };
  } catch (e) {
    /* nová tabule */
  }
  rooms.set(id, room);
  return room;
}

function saveRoom(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = null;
  const file = roomFile(room.id);
  const tmp = file + '.tmp';
  const data = JSON.stringify({ meta: room.meta, elements: [...room.elements.values()] });
  fs.writeFile(tmp, data, (err) => {
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

/* ---------- Realtime ---------- */

io.on('connection', (socket) => {
  const { room: roomId, name, clientId } = socket.handshake.auth || {};
  if (typeof roomId !== 'string' || !ROOM_RE.test(roomId)) {
    socket.disconnect(true);
    return;
  }
  const room = getRoom(roomId);
  const usedColors = new Set([...room.users.values()].map((u) => u.color));
  const color = USER_COLORS.find((c) => !usedColors.has(c)) || USER_COLORS[room.users.size % USER_COLORS.length];
  const user = {
    id: socket.id,
    clientId: String(clientId || '').slice(0, 64),
    name: String(name || 'Host').slice(0, 40),
    color,
  };
  room.users.set(socket.id, user);
  socket.join(roomId);

  socket.emit('init', {
    you: user,
    users: [...room.users.values()],
    meta: room.meta,
    elements: [...room.elements.values()],
  });
  socket.to(roomId).emit('user-joined', user);

  const to = () => socket.to(roomId);

  socket.on('add', (els) => {
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
    if (!Array.isArray(ids)) return;
    const done = ids.filter((id) => room.elements.delete(id));
    if (done.length) {
      to().emit('delete', done);
      scheduleSave(room);
    }
  });

  socket.on('clear', () => {
    room.elements.clear();
    to().emit('clear');
    scheduleSave(room);
  });

  socket.on('meta', (meta) => {
    if (!meta || typeof meta !== 'object') return;
    if (typeof meta.bg === 'string') room.meta.bg = meta.bg.slice(0, 20);
    to().emit('meta', room.meta);
    scheduleSave(room);
  });

  // Rozpracované tahy a pohyb (neukládá se, jen se přeposílá ostatním)
  socket.on('draft', (d) => d && to().volatile.emit('draft', { ...d, user: socket.id }));
  socket.on('draft-end', (id) => to().emit('draft-end', { id, user: socket.id }));
  socket.on('cursor', (c) => c && to().volatile.emit('cursor', { x: c.x, y: c.y, user: socket.id }));

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
      fs.writeFileSync(roomFile(room.id), JSON.stringify({ meta: room.meta, elements: [...room.elements.values()] }));
    } catch (e) {
      console.error(e);
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`Online tabule běží na http://localhost:${PORT}`));
