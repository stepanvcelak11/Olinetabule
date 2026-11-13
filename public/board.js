(() => {
  'use strict';

  /* =========================================================
   *  Konfigurace
   * ======================================================= */
  const COLORS = ['#1f2430', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#9333ea', '#facc15', '#ffffff'];
  const SIZES = { default: [2, 4, 8, 14], marker: [12, 20, 30, 44], eraser: [10, 24, 48, 90], text: [16, 24, 36, 56] };
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const IMG_MAX_DIM = 1800;

  const roomId = location.pathname.split('/').pop();
  const clientId = getClientId();

  /* =========================================================
   *  DOM
   * ======================================================= */
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const bgCanvas = $('bg');
  const canvas = $('board');
  const bgCtx = bgCanvas.getContext('2d');
  const ctx = canvas.getContext('2d');
  const cursorsEl = $('cursors');
  const textEditor = $('textEditor');

  // Vrstva s hotovými prvky (kreslí se jen při změně)
  const cache = document.createElement('canvas');
  const cacheCtx = cache.getContext('2d');

  /* =========================================================
   *  Stav
   * ======================================================= */
  const elements = new Map(); // id -> prvek (pořadí = pořadí vykreslení)
  const drafts = new Map(); // rozpracované prvky ostatních
  const users = new Map();
  const remoteCursors = new Map();
  const images = new Map(); // src -> HTMLImageElement
  const view = { x: 0, y: 0, scale: 1 };
  let dpr = window.devicePixelRatio || 1;
  let W = 0;
  let H = 0;
  let me = null;
  let meta = { bg: 'grid' };

  const state = {
    tool: 'pen',
    color: COLORS[0],
    sizeIdx: { default: 1, marker: 1, eraser: 1, text: 1 },
    fill: false,
  };

  let current = null; // právě kreslený prvek
  let selectedId = null;
  let cacheDirty = true;
  let frameRequested = false;
  let bgDirty = true;

  const undoStack = [];
  const redoStack = [];
  const offlineQueue = [];

  /* =========================================================
   *  Pomocné
   * ======================================================= */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
  function getClientId() {
    try {
      let id = localStorage.getItem('tabule-client');
      if (!id) localStorage.setItem('tabule-client', (id = Math.random().toString(36).slice(2)));
      return id;
    } catch (e) {
      return Math.random().toString(36).slice(2);
    }
  }
  function storedName() {
    try { return localStorage.getItem('tabule-name') || ''; } catch (e) { return ''; }
  }
  function storeName(n) {
    try { localStorage.setItem('tabule-name', n); } catch (e) { /* nic */ }
  }
  const round = (n) => Math.round(n * 10) / 10;
  function toWorld(sx, sy) {
    return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
  }
  function toScreen(wx, wy) {
    return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
  }
  function clone(o) {
    return JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : v)));
  }
  function stripPrivate(el) {
    const o = {};
    for (const k in el) if (!k.startsWith('_')) o[k] = el[k];
    return o;
  }
  function toast(msg, ms = 2200) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  function currentSize(kind) {
    const k = kind || sizeKind();
    return SIZES[k][state.sizeIdx[k]];
  }
  function sizeKind() {
    if (state.tool === 'marker') return 'marker';
    if (state.tool === 'eraser' || state.tool === 'strokeEraser') return 'eraser';
    if (state.tool === 'text') return 'text';
    return 'default';
  }

  /* =========================================================
   *  Síť
   * ======================================================= */
  let socket = null;
  let ready = false; // true po přijetí 'init'

  function connect(name) {
    socket = io({ auth: { room: roomId, name, clientId } });
    socket.on('connect', () => setStatus(true));
    socket.on('disconnect', () => { ready = false; setStatus(false); });
    socket.on('connect_error', () => setStatus(false));

    socket.on('init', (data) => {
      me = data.you;
      ready = true;
      meta = data.meta || meta;
      $('bgSelect').value = meta.bg;
      elements.clear();
      drafts.clear();
      for (const el of data.elements) elements.set(el.id, el);
      users.clear();
      for (const u of data.users) users.set(u.id, u);
      renderUsers();
      // odeslat, co se nakreslilo během výpadku
      const q = offlineQueue.splice(0);
      for (const [ev, payload] of q) {
        applyLocal(ev, payload);
        socket.emit(ev, payload);
      }
      if (selectedId && !elements.has(selectedId)) select(null);
      bgDirty = true;
      invalidate();
    });

    socket.on('add', (els) => {
      for (const el of els) {
        drafts.delete(el.id);
        const appendOnly = !elements.has(el.id);
        elements.set(el.id, el);
        if (appendOnly && !cacheDirty) drawElementToCache(el);
        else cacheDirty = true;
      }
      requestFrame();
    });
    socket.on('update', ({ id, props }) => {
      const el = elements.get(id);
      if (!el) return;
      Object.assign(el, props);
      resetDerived(el);
      invalidate();
    });
    socket.on('delete', (ids) => {
      for (const id of ids) {
        elements.delete(id);
        if (id === selectedId) select(null);
      }
      invalidate();
    });
    socket.on('clear', () => {
      elements.clear();
      select(null);
      invalidate();
    });
    socket.on('meta', (m) => {
      meta = m;
      $('bgSelect').value = meta.bg;
      bgDirty = true;
      requestFrame();
    });

    socket.on('draft', (d) => {
      let el = drafts.get(d.id);
      if (d.el) {
        // celý prvek (tvary, posun)
        drafts.set(d.id, { ...d.el, _user: d.user });
      } else if (d.pts) {
        if (!el) {
          el = { id: d.id, type: 'stroke', pts: [], color: d.color, size: d.size, mode: d.mode, _user: d.user };
          drafts.set(d.id, el);
        }
        for (const p of d.pts) el.pts.push(p);
        el._path = null;
      }
      requestFrame();
    });
    socket.on('draft-end', ({ id }) => {
      drafts.delete(id);
      requestFrame();
    });

    socket.on('cursor', (c) => {
      remoteCursors.set(c.user, { x: c.x, y: c.y });
      positionCursor(c.user);
    });
    socket.on('user-joined', (u) => {
      users.set(u.id, u);
      renderUsers();
      toast(`${u.name} se připojil(a)`);
    });
    socket.on('user-updated', (u) => {
      users.set(u.id, u);
      if (me && u.id === me.id) me = u;
      renderUsers();
    });
    socket.on('user-left', (id) => {
      const u = users.get(id);
      users.delete(id);
      remoteCursors.delete(id);
      for (const [k, d] of drafts) if (d._user === id) drafts.delete(k);
      renderUsers();
      requestFrame();
      if (u) toast(`${u.name} odešel/odešla`);
    });
  }

  // Odeslání operace (při výpadku do fronty)
  function send(ev, payload) {
    if (socket && socket.connected && ready) socket.emit(ev, payload);
    else offlineQueue.push([ev, payload]);
  }
  function sendVolatile(ev, payload) {
    if (socket && socket.connected && ready) socket.volatile.emit(ev, payload);
  }

  function applyLocal(ev, payload) {
    if (ev === 'add') for (const el of [].concat(payload)) elements.set(el.id, clone(el));
    else if (ev === 'update') {
      const el = elements.get(payload.id);
      if (el) { Object.assign(el, payload.props); resetDerived(el); }
    } else if (ev === 'delete') for (const id of payload) elements.delete(id);
    else if (ev === 'clear') elements.clear();
  }

  function setStatus(on) {
    const s = $('status');
    s.className = 'status ' + (on ? 'on' : 'off');
    s.title = on ? 'Připojeno' : 'Odpojeno – zkouším znovu…';
    if (!on && me) toast('Spojení přerušeno, zkouším se znovu připojit…');
  }

  /* =========================================================
   *  Operace s historií (Zpět / Znovu)
   * ======================================================= */
  function doAdd(els, record = true) {
    els = [].concat(els);
    let incremental = !cacheDirty;
    for (const el of els) {
      if (elements.has(el.id)) incremental = false;
      elements.set(el.id, el);
    }
    send('add', els.map(stripPrivate));
    if (record) pushHistory({ t: 'add', els: els.map(clone) });
    if (incremental) {
      for (const el of els) drawElementToCache(el);
      requestFrame();
    } else invalidate();
  }
  function doDelete(ids, record = true) {
    const removed = [];
    for (const id of ids) {
      const el = elements.get(id);
      if (el) { removed.push(clone(el)); elements.delete(id); }
      if (id === selectedId) select(null);
    }
    if (!removed.length) return;
    send('delete', removed.map((e) => e.id));
    if (record) pushHistory({ t: 'del', els: removed });
    invalidate();
  }
  function doUpdate(id, props, before, record = true) {
    const el = elements.get(id);
    if (!el) return;
    Object.assign(el, props);
    resetDerived(el);
    send('update', { id, props });
    if (record) pushHistory({ t: 'upd', id, before, after: props });
    invalidate();
  }
  function pushHistory(entry) {
    undoStack.push(entry);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }
  function undo() {
    const e = undoStack.pop();
    if (!e) return;
    if (e.t === 'add') doDelete(e.els.map((x) => x.id), false);
    else if (e.t === 'del') doAdd(e.els.map(clone), false);
    else if (e.t === 'upd') doUpdate(e.id, e.before, null, false);
    redoStack.push(e);
    updateUndoButtons();
  }
  function redo() {
    const e = redoStack.pop();
    if (!e) return;
    if (e.t === 'add') doAdd(e.els.map(clone), false);
    else if (e.t === 'del') doDelete(e.els.map((x) => x.id), false);
    else if (e.t === 'upd') doUpdate(e.id, e.after, null, false);
    undoStack.push(e);
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
  }

  /* =========================================================
   *  Vykreslování
   * ======================================================= */
  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = stage.clientWidth;
    H = stage.clientHeight;
    for (const c of [bgCanvas, canvas, cache]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    bgDirty = true;
    invalidate();
  }

  function invalidate() {
    cacheDirty = true;
    requestFrame();
  }
  function requestFrame() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    frameRequested = false;
    if (bgDirty) drawBackground();
    if (cacheDirty) rebuildCache();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cache, 0, 0);
    applyView(ctx);
    for (const d of drafts.values()) drawElement(ctx, d);
    if (current) drawElement(ctx, current);
    drawSelection();
    drawEraserCursor();
    for (const id of remoteCursors.keys()) positionCursor(id);
    $('zoomReset').textContent = Math.round(view.scale * 100) + '%';
  }
  function applyView(c) {
    c.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
  }
  function rebuildCache() {
    cacheDirty = false;
    cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
    cacheCtx.clearRect(0, 0, cache.width, cache.height);
    applyView(cacheCtx);
    const tl = toWorld(0, 0);
    const br = toWorld(W, H);
    for (const el of elements.values()) {
      const b = bounds(el);
      if (b && (b.x2 < tl.x || b.x1 > br.x || b.y2 < tl.y || b.y1 > br.y)) continue;
      drawElement(cacheCtx, el);
    }
  }
  function drawElementToCache(el) {
    applyView(cacheCtx);
    drawElement(cacheCtx, el);
  }

  function drawBackground() {
    bgDirty = false;
    const c = bgCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
    if (meta.bg === 'blank') return;
    let step = 30;
    while (step * view.scale < 12) step *= 5;
    const s = step * view.scale * dpr;
    const ox = (((view.x * dpr) % s) + s) % s;
    const oy = (((view.y * dpr) % s) + s) % s;
    c.lineWidth = 1;
    if (meta.bg === 'dots') {
      c.fillStyle = '#c3c8d2';
      const r = Math.max(1, 1.3 * dpr);
      for (let x = ox; x < bgCanvas.width; x += s)
        for (let y = oy; y < bgCanvas.height; y += s) c.fillRect(x - r / 2, y - r / 2, r, r);
      return;
    }
    c.strokeStyle = '#e3e7ee';
    c.beginPath();
    if (meta.bg === 'grid') {
      for (let x = ox; x < bgCanvas.width; x += s) { c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, bgCanvas.height); }
    }
    for (let y = oy; y < bgCanvas.height; y += s) { c.moveTo(0, Math.round(y) + 0.5); c.lineTo(bgCanvas.width, Math.round(y) + 0.5); }
    c.stroke();
  }

  function strokePath(el) {
    if (el._path) return el._path;
    const p = new Path2D();
    const pts = el.pts;
    const n = pts.length / 2;
    if (n === 0) return p;
    p.moveTo(pts[0], pts[1]);
    if (n === 1) {
      p.lineTo(pts[0] + 0.01, pts[1]);
    } else if (n === 2) {
      p.lineTo(pts[2], pts[3]);
    } else {
      for (let i = 1; i < n - 1; i++) {
        const x = pts[i * 2], y = pts[i * 2 + 1];
        const nx = pts[i * 2 + 2], ny = pts[i * 2 + 3];
        p.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      p.lineTo(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
    }
    el._path = p;
    return p;
  }

  function drawElement(c, el) {
    c.save();
    if (el.dx || el.dy) c.translate(el.dx || 0, el.dy || 0);
    switch (el.type) {
      case 'stroke': {
        c.lineCap = 'round';
        c.lineJoin = 'round';
        c.lineWidth = el.size;
        if (el.mode === 'erase') {
          c.globalCompositeOperation = 'destination-out';
          c.strokeStyle = '#000';
        } else {
          c.strokeStyle = el.color;
          if (el.mode === 'marker') {
            c.globalAlpha = 0.35;
            c.globalCompositeOperation = 'multiply';
          }
        }
        c.stroke(strokePath(el));
        break;
      }
      case 'shape':
        drawShape(c, el);
        break;
      case 'text':
        drawText(c, el);
        break;
      case 'image':
        drawImage(c, el);
        break;
    }
    c.restore();
  }

  function drawShape(c, el) {
    const { x1, y1, x2, y2 } = el;
    c.strokeStyle = el.color;
    c.fillStyle = el.color;
    c.lineWidth = el.size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    if (el.shape === 'line' || el.shape === 'arrow') {
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
      if (el.shape === 'arrow') {
        const a = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.max(12, el.size * 4);
        c.beginPath();
        c.moveTo(x2, y2);
        c.lineTo(x2 - len * Math.cos(a - 0.45), y2 - len * Math.sin(a - 0.45));
        c.lineTo(x2 - len * Math.cos(a + 0.45), y2 - len * Math.sin(a + 0.45));
        c.closePath();
        c.fill();
        c.stroke();
      }
      return;
    }
    if (el.shape === 'rect') c.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    else c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    if (el.fill) {
      c.globalAlpha = 0.25;
      c.fill();
      c.globalAlpha = 1;
    }
    c.stroke();
  }

  function fontFor(el) {
    return `${el.size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  }
  function measureText(el) {
    if (el._w != null) return;
    ctx.save();
    ctx.font = fontFor(el);
    const lines = String(el.text).split('\n');
    el._w = Math.max(...lines.map((l) => ctx.measureText(l).width), el.size * 0.5);
    el._h = lines.length * el.size * 1.25;
    ctx.restore();
  }
  function drawText(c, el) {
    if (el.id === editingTextId) return;
    measureText(el);
    c.font = fontFor(el);
    c.fillStyle = el.color;
    c.textBaseline = 'top';
    const lines = String(el.text).split('\n');
    lines.forEach((l, i) => c.fillText(l, el.x, el.y + i * el.size * 1.25 + el.size * 0.1));
  }

  function drawImage(c, el) {
    let img = images.get(el.src);
    if (!img) {
      img = new Image();
      img.onload = invalidate;
      img.src = el.src;
      images.set(el.src, img);
    }
    if (img.complete && img.naturalWidth) c.drawImage(img, el.x, el.y, el.w, el.h);
    else {
      c.fillStyle = '#eef0f3';
      c.fillRect(el.x, el.y, el.w, el.h);
    }
  }

  function resetDerived(el) {
    el._path = null;
    el._b = null;
    el._w = null;
  }

  /* ---------- Hranice a zásahy ---------- */
  function bounds(el) {
    if (el._b) return el._b;
    let b;
    const dx = el.dx || 0, dy = el.dy || 0;
    if (el.type === 'stroke') {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let i = 0; i < el.pts.length; i += 2) {
        const x = el.pts[i], y = el.pts[i + 1];
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
      const r = el.size / 2;
      b = { x1: x1 - r + dx, y1: y1 - r + dy, x2: x2 + r + dx, y2: y2 + r + dy };
    } else if (el.type === 'shape') {
      const r = el.size / 2 + (el.shape === 'arrow' ? Math.max(12, el.size * 4) : 0);
      b = { x1: Math.min(el.x1, el.x2) - r, y1: Math.min(el.y1, el.y2) - r, x2: Math.max(el.x1, el.x2) + r, y2: Math.max(el.y1, el.y2) + r };
    } else if (el.type === 'text') {
      measureText(el);
      b = { x1: el.x, y1: el.y, x2: el.x + el._w, y2: el.y + el._h };
    } else if (el.type === 'image') {
      b = { x1: el.x, y1: el.y, x2: el.x + el.w, y2: el.y + el.h };
    }
    el._b = b;
    return b;
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function hit(el, x, y, tol) {
    const b = bounds(el);
    if (!b || x < b.x1 - tol || x > b.x2 + tol || y < b.y1 - tol || y > b.y2 + tol) return false;
    if (el.type === 'stroke') {
      if (el.mode === 'erase') return false;
      const px = x - (el.dx || 0), py = y - (el.dy || 0);
      const r = el.size / 2 + tol;
      const p = el.pts;
      if (p.length === 2) return Math.hypot(px - p[0], py - p[1]) <= r;
      for (let i = 0; i < p.length - 2; i += 2) if (distToSeg(px, py, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r) return true;
      return false;
    }
    if (el.type === 'shape') {
      const r = el.size / 2 + tol;
      const { x1, y1, x2, y2 } = el;
      if (el.shape === 'line' || el.shape === 'arrow') return distToSeg(x, y, x1, y1, x2, y2) <= r;
      if (el.shape === 'rect') {
        const l = Math.min(x1, x2), rr = Math.max(x1, x2), t = Math.min(y1, y2), bt = Math.max(y1, y2);
        if (el.fill && x >= l && x <= rr && y >= t && y <= bt) return true;
        return distToSeg(x, y, l, t, rr, t) <= r || distToSeg(x, y, rr, t, rr, bt) <= r ||
          distToSeg(x, y, rr, bt, l, bt) <= r || distToSeg(x, y, l, bt, l, t) <= r;
      }
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2 || 1, ry = Math.abs(y2 - y1) / 2 || 1;
      const nd = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (el.fill && nd <= 1) return true;
      return Math.abs(nd - 1) * Math.min(rx, ry) <= r;
    }
    return true; // text, obrázek: stačí obdélník
  }

  function topHit(x, y, tol) {
    const arr = [...elements.values()];
    for (let i = arr.length - 1; i >= 0; i--) if (hit(arr[i], x, y, tol)) return arr[i];
    return null;
  }

  /* ---------- Výběr ---------- */
  function select(id) {
    selectedId = id;
    $('selectionBar').hidden = !id;
    requestFrame();
  }
  function handleRect(el) {
    const b = bounds(el);
    const s = 12 / view.scale;
    return { x: b.x2 - s / 2, y: b.y2 - s / 2, s };
  }
  function drawSelection() {
    const el = selectedId && elements.get(selectedId);
    if (!el) return;
    const b = bounds(el);
    const pad = 4 / view.scale;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5 / view.scale;
    ctx.setLineDash([6 / view.scale, 4 / view.scale]);
    ctx.strokeRect(b.x1 - pad, b.y1 - pad, b.x2 - b.x1 + pad * 2, b.y2 - b.y1 + pad * 2);
    ctx.setLineDash([]);
    if (el.type === 'image' || el.type === 'text') {
      const h = handleRect(el);
      ctx.fillStyle = '#fff';
      ctx.fillRect(h.x, h.y, h.s, h.s);
      ctx.strokeRect(h.x, h.y, h.s, h.s);
    }
    ctx.restore();
  }

  let pointerWorld = null;
  function drawEraserCursor() {
    if (!pointerWorld || (state.tool !== 'eraser' && state.tool !== 'strokeEraser') || pointerType === 'touch') return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(pointerWorld.x, pointerWorld.y, currentSize('eraser') / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.lineWidth = 1 / view.scale;
    ctx.stroke();
    ctx.restore();
  }

  /* =========================================================
   *  Vstup (myš, pero, dotyk)
   * ======================================================= */
  const pointers = new Map(); // aktivní dotyky
  let action = null; // { kind: 'draw'|'pan'|'move'|'resize'|'erase'|'pinch' ... }
  let spaceDown = false;
  let penSeen = false; // pokud uživatel používá stylus, prst jen posouvá
  let pointerType = 'mouse';
  let draftTimer = 0;
  let draftSent = 0;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { pointerWorld = null; requestFrame(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function onPointerDown(e) {
    if (editingTextId !== null || !textEditor.hidden) { commitText(); if (state.tool === 'text') return; }
    pointerType = e.pointerType;
    if (e.pointerType === 'pen') penSeen = true;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // dva prsty => posun / zoom
    if (e.pointerType === 'touch' && pointers.size === 2) {
      cancelCurrent();
      const [a, b] = [...pointers.values()];
      action = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.size > 2) return;

    const w = toWorld(e.clientX, e.clientY);
    const panRequested = state.tool === 'hand' || spaceDown || e.button === 1 || e.button === 2 ||
      (e.pointerType === 'touch' && penSeen);
    if (panRequested) {
      action = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    const tool = state.tool;
    if (tool === 'pen' || tool === 'marker' || tool === 'eraser') {
      const mode = tool === 'pen' ? 'pen' : tool === 'marker' ? 'marker' : 'erase';
      current = { id: uid(), type: 'stroke', mode, color: state.color, size: currentSize(), pts: [round(w.x), round(w.y)] };
      draftSent = 0;
      action = { kind: 'draw' };
      requestFrame();
    } else if (tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse') {
      current = { id: uid(), type: 'shape', shape: tool, color: state.color, size: currentSize(), fill: state.fill && (tool === 'rect' || tool === 'ellipse'), x1: round(w.x), y1: round(w.y), x2: round(w.x), y2: round(w.y) };
      action = { kind: 'shape' };
    } else if (tool === 'strokeEraser') {
      action = { kind: 'erase', removed: [] };
      eraseAt(w);
    } else if (tool === 'text') {
      const t = topHit(w.x, w.y, 2 / view.scale);
      if (t && t.type === 'text') openTextEditor(t);
      else openTextEditor(null, w);
    } else if (tool === 'select') {
      const sel = selectedId && elements.get(selectedId);
      if (sel && (sel.type === 'image' || sel.type === 'text')) {
        const h = handleRect(sel);
        const pad = 6 / view.scale;
        if (w.x >= h.x - pad && w.x <= h.x + h.s + pad && w.y >= h.y - pad && w.y <= h.y + h.s + pad) {
          action = { kind: 'resize', id: sel.id, start: w, before: pickProps(sel) };
          return;
        }
      }
      const t = topHit(w.x, w.y, 6 / view.scale);
      select(t ? t.id : null);
      if (t) {
        if (e.detail === 2 && t.type === 'text') { openTextEditor(t); return; }
        action = { kind: 'move', id: t.id, start: w, before: pickProps(t) };
      }
    }
  }

  function onPointerMove(e) {
    const w = toWorld(e.clientX, e.clientY);
    pointerWorld = w;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    sendCursor(w);

    if (!action) {
      if (state.tool === 'eraser' || state.tool === 'strokeEraser') requestFrame();
      return;
    }
    switch (action.kind) {
      case 'pinch': {
        if (pointers.size < 2) return;
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        view.x += cx - action.cx;
        view.y += cy - action.cy;
        zoomAt(cx, cy, dist / action.dist);
        action.dist = dist; action.cx = cx; action.cy = cy;
        break;
      }
      case 'pan':
        view.x = action.vx + (e.clientX - action.sx);
        view.y = action.vy + (e.clientY - action.sy);
        viewChanged();
        break;
      case 'draw': {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        const pts = current.pts;
        for (const ev of evs.length ? evs : [e]) {
          const p = toWorld(ev.clientX, ev.clientY);
          const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
          if (Math.hypot(p.x - lx, p.y - ly) < 0.6 / view.scale) continue;
          pts.push(round(p.x), round(p.y));
        }
        current._path = null;
        scheduleDraft();
        requestFrame();
        break;
      }
      case 'shape': {
        let x2 = w.x, y2 = w.y;
        if (e.shiftKey) {
          const dx = x2 - current.x1, dy = y2 - current.y1;
          if (current.shape === 'line' || current.shape === 'arrow') {
            const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
            const len = Math.hypot(dx, dy);
            x2 = current.x1 + Math.cos(a) * len; y2 = current.y1 + Math.sin(a) * len;
          } else {
            const m = Math.max(Math.abs(dx), Math.abs(dy));
            x2 = current.x1 + Math.sign(dx || 1) * m; y2 = current.y1 + Math.sign(dy || 1) * m;
          }
        }
        current.x2 = round(x2); current.y2 = round(y2);
        scheduleDraft();
        requestFrame();
        break;
      }
      case 'erase':
        eraseAt(w);
        break;
      case 'move': {
        const el = elements.get(action.id);
        if (!el) { action = null; return; }
        const dx = w.x - action.start.x, dy = w.y - action.start.y;
        Object.assign(el, movedProps(action.before, dx, dy));
        resetDerived(el);
        action.moved = true;
        throttledLiveUpdate(el);
        invalidate();
        break;
      }
      case 'resize': {
        const el = elements.get(action.id);
        if (!el) { action = null; return; }
        Object.assign(el, resizedProps(el, action.before, w));
        resetDerived(el);
        action.moved = true;
        throttledLiveUpdate(el);
        invalidate();
        break;
      }
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (!action) return;
    const a = action;
    if (a.kind === 'pinch') {
      if (pointers.size === 0) action = null;
      return;
    }
    action = null;
    canvas.style.cursor = '';
    updateCursorStyle();
    if (a.kind === 'draw' || a.kind === 'shape') {
      const el = current;
      current = null;
      clearTimeout(draftTimer); draftTimer = 0;
      if (a.kind === 'shape' && Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 2) {
        send('draft-end', el.id);
        requestFrame();
        return;
      }
      doAdd(el);
    } else if (a.kind === 'erase') {
      if (a.removed.length) {
        send('delete', a.removed.map((x) => x.id));
        pushHistory({ t: 'del', els: a.removed });
      }
    } else if ((a.kind === 'move' || a.kind === 'resize') && a.moved) {
      const el = elements.get(a.id);
      if (el) doUpdate(a.id, pickProps(el), a.before);
    }
  }

  function cancelCurrent() {
    if (current) {
      send('draft-end', current.id);
      current = null;
    }
    if (action && (action.kind === 'move' || action.kind === 'resize')) {
      const el = elements.get(action.id);
      if (el) { Object.assign(el, action.before); resetDerived(el); send('update', { id: el.id, props: action.before }); }
    }
    action = null;
    requestFrame();
  }

  function pickProps(el) {
    if (el.type === 'stroke') return { dx: el.dx || 0, dy: el.dy || 0 };
    if (el.type === 'shape') return { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 };
    if (el.type === 'text') return { x: el.x, y: el.y, size: el.size };
    if (el.type === 'image') return { x: el.x, y: el.y, w: el.w, h: el.h };
    return {};
  }
  function movedProps(b, dx, dy) {
    if ('dx' in b) return { dx: round(b.dx + dx), dy: round(b.dy + dy) };
    if ('x1' in b) return { x1: round(b.x1 + dx), y1: round(b.y1 + dy), x2: round(b.x2 + dx), y2: round(b.y2 + dy) };
    const o = { ...b, x: round(b.x + dx), y: round(b.y + dy) };
    return o;
  }
  function resizedProps(el, b, w) {
    if (el.type === 'image') {
      const ratio = b.h / b.w;
      const nw = Math.max(20, w.x - b.x);
      return { w: round(nw), h: round(nw * ratio) };
    }
    if (el.type === 'text') {
      measureText(el);
      const startH = el._h * (b.size / el.size);
      const nh = Math.max(8, w.y - b.y);
      return { size: Math.max(8, Math.round(b.size * (nh / startH))) };
    }
    return {};
  }

  let liveUpdTimer = 0;
  function throttledLiveUpdate(el) {
    if (liveUpdTimer) return;
    liveUpdTimer = setTimeout(() => {
      liveUpdTimer = 0;
      if (elements.has(el.id)) sendVolatile('update', { id: el.id, props: pickProps(el) });
    }, 50);
  }

  function scheduleDraft() {
    if (draftTimer) return;
    draftTimer = setTimeout(() => {
      draftTimer = 0;
      if (!current) return;
      if (current.type === 'stroke') {
        const pts = current.pts.slice(draftSent);
        if (!pts.length) return;
        // posíláme jen nové body, dvojice x,y
        sendVolatile('draft', { id: current.id, color: current.color, size: current.size, mode: current.mode, pts });
        draftSent = current.pts.length;
      } else {
        sendVolatile('draft', { id: current.id, el: stripPrivate(current) });
      }
    }, 40);
  }

  function eraseAt(w) {
    const r = currentSize('eraser') / 2;
    const arr = [...elements.values()];
    let changed = false;
    for (let i = arr.length - 1; i >= 0; i--) {
      const el = arr[i];
      if (el.type === 'image') continue; // obrázky mažte přes výběr
      if (hit(el, w.x, w.y, r)) {
        action.removed.push(clone(el));
        elements.delete(el.id);
        if (el.id === selectedId) select(null);
        changed = true;
      }
    }
    if (changed) invalidate();
  }

  let cursorTimer = 0;
  let lastCursor = null;
  function sendCursor(w) {
    lastCursor = w;
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = 0;
      if (lastCursor) sendVolatile('cursor', { x: round(lastCursor.x), y: round(lastCursor.y) });
    }, 50);
  }

  /* ---------- Zoom & posun ---------- */
  function zoomAt(sx, sy, factor) {
    const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const f = ns / view.scale;
    view.x = sx - (sx - view.x) * f;
    view.y = sy - (sy - view.y) * f;
    view.scale = ns;
    viewChanged();
  }
  function viewChanged() {
    bgDirty = true;
    invalidate();
    if (!textEditor.hidden) positionTextEditor();
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)));
    } else {
      const k = e.deltaMode ? 30 : 1;
      view.x -= (e.shiftKey ? e.deltaY : e.deltaX) * k;
      view.y -= (e.shiftKey ? 0 : e.deltaY) * k;
      viewChanged();
    }
  }, { passive: false });

  $('zoomIn').onclick = () => zoomAt(W / 2, H / 2, 1.25);
  $('zoomOut').onclick = () => zoomAt(W / 2, H / 2, 0.8);
  $('zoomReset').onclick = () => { view.x = 0; view.y = 0; view.scale = 1; viewChanged(); };

  // Safari gesta
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  /* =========================================================
   *  Text
   * ======================================================= */
  let editingTextId = null; // id upravovaného existujícího textu
  let textPos = null;
  let textStyle = null;

  function openTextEditor(el, w) {
    if (el) {
      editingTextId = el.id;
      textPos = { x: el.x, y: el.y };
      textStyle = { color: el.color, size: el.size };
      textEditor.value = el.text;
      invalidate();
    } else {
      editingTextId = null;
      textStyle = { color: state.color, size: currentSize('text') };
      textPos = { x: w.x, y: w.y - textStyle.size * 0.6 };
      textEditor.value = '';
    }
    textEditor.hidden = false;
    positionTextEditor();
    autosizeText();
    setTimeout(() => textEditor.focus(), 0);
  }
  function positionTextEditor() {
    const p = toScreen(textPos.x, textPos.y);
    textEditor.style.left = p.x + 'px';
    textEditor.style.top = p.y + 'px';
    textEditor.style.fontSize = textStyle.size + 'px';
    textEditor.style.color = textStyle.color;
    textEditor.style.transform = `scale(${view.scale})`;
  }
  function autosizeText() {
    textEditor.style.width = '0px';
    textEditor.style.height = '0px';
    textEditor.style.width = textEditor.scrollWidth + textStyle.size + 'px';
    textEditor.style.height = textEditor.scrollHeight + 'px';
  }
  textEditor.addEventListener('input', autosizeText);
  textEditor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { textEditor.value = editingTextId ? textEditor.value : ''; commitText(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitText();
  });
  textEditor.addEventListener('blur', () => {
    // přepnutí okna/aplikace text nezavírá
    setTimeout(() => { if (document.hasFocus() && document.activeElement !== textEditor) commitText(); }, 0);
  });

  function commitText() {
    if (textEditor.hidden) return;
    const value = textEditor.value.replace(/\s+$/, '');
    textEditor.hidden = true;
    const id = editingTextId;
    editingTextId = null;
    if (id) {
      const el = elements.get(id);
      if (el) {
        if (!value) doDelete([id]);
        else if (value !== el.text) doUpdate(id, { text: value }, { text: el.text });
      }
      invalidate();
    } else if (value) {
      doAdd({ id: uid(), type: 'text', x: round(textPos.x), y: round(textPos.y), text: value, color: textStyle.color, size: textStyle.size });
    }
  }

  /* =========================================================
   *  Obrázky
   * ======================================================= */
  $('imageBtn').onclick = () => $('imageInput').click();
  $('imageInput').addEventListener('change', (e) => {
    [...e.target.files].forEach((f, i) => addImageFile(f, i));
    e.target.value = '';
  });
  window.addEventListener('paste', (e) => {
    if (!textEditor.hidden) return;
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
    if (!items.length) return;
    e.preventDefault();
    items.forEach((it, i) => addImageFile(it.getAsFile(), i));
  });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    files.forEach((f, i) => addImageFile(f, i, toWorld(e.clientX, e.clientY)));
  });

  function addImageFile(file, idx = 0, at) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { naturalWidth: w, naturalHeight: h } = img;
        const k = Math.min(1, IMG_MAX_DIM / Math.max(w, h));
        w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        let src = c.toDataURL('image/png');
        if (src.length > 1.2e6) src = c.toDataURL('image/jpeg', 0.85);
        // velikost na tabuli: max ~60 % viditelné plochy
        const vw = (W * 0.6) / view.scale, vh = (H * 0.6) / view.scale;
        const s = Math.min(1 / view.scale, vw / w, vh / h);
        const dw = round(w * s), dh = round(h * s);
        const center = at || toWorld(W / 2, H / 2);
        const off = idx * 24 / view.scale;
        const el = { id: uid(), type: 'image', src, x: round(center.x - dw / 2 + off), y: round(center.y - dh / 2 + off), w: dw, h: dh };
        doAdd(el);
        setTool('select');
        select(el.id);
      };
      img.onerror = () => toast('Obrázek se nepodařilo načíst.');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* =========================================================
   *  Panel nástrojů
   * ======================================================= */
  function setTool(t) {
    if (!textEditor.hidden) commitText();
    state.tool = t;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    if (t !== 'select') select(null);
    renderSizes();
    updateCursorStyle();
    requestFrame();
  }
  function updateCursorStyle() {
    const t = state.tool;
    canvas.style.cursor = spaceDown || t === 'hand' ? 'grab'
      : t === 'select' ? 'default'
        : t === 'text' ? 'text'
          : t === 'eraser' || t === 'strokeEraser' ? 'none'
            : 'crosshair';
  }
  document.querySelectorAll('.tool[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  function renderColors() {
    const box = $('colors');
    box.innerHTML = '';
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === state.color ? ' active' : '');
      b.title = c;
      b.innerHTML = `<span style="background:${c}"></span>`;
      b.onclick = () => setColor(c);
      box.appendChild(b);
    }
  }
  function setColor(c) {
    state.color = c;
    $('customColor').value = c;
    const wrap = $('customColorWrap');
    wrap.style.setProperty('--c', c);
    wrap.classList.toggle('active', !COLORS.includes(c));
    renderColors();
    // změna barvy vybraného prvku
    const el = selectedId && elements.get(selectedId);
    if (el && el.type !== 'image' && el.color !== c) doUpdate(el.id, { color: c }, { color: el.color });
    if (state.tool === 'eraser' || state.tool === 'strokeEraser' || state.tool === 'select' || state.tool === 'hand') {
      if (!el) setTool('pen');
    }
  }
  $('customColor').addEventListener('input', (e) => setColor(e.target.value));

  function renderSizes() {
    const box = $('sizes');
    box.innerHTML = '';
    const kind = sizeKind();
    SIZES[kind].forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'size-btn' + (state.sizeIdx[kind] === i ? ' active' : '');
      b.title = kind === 'text' ? `Písmo ${s}px` : `Tloušťka ${s}`;
      const d = Math.max(3, Math.min(24, kind === 'default' ? s * 1.6 : (i + 1) * 5));
      b.innerHTML = kind === 'text' ? `<b style="font-size:${10 + i * 3}px">A</b>` : `<span style="width:${d}px;height:${d}px"></span>`;
      b.onclick = () => { state.sizeIdx[kind] = i; renderSizes(); };
      box.appendChild(b);
    });
  }
  $('fillShapes').addEventListener('change', (e) => (state.fill = e.target.checked));

  $('undoBtn').onclick = undo;
  $('redoBtn').onclick = redo;
  $('delBtn').onclick = () => selectedId && doDelete([selectedId]);
  $('dupBtn').onclick = duplicateSelected;
  $('clearBtn').onclick = () => {
    if (!elements.size) return;
    if (!confirm('Opravdu vymazat celou tabuli pro všechny? (Lze vrátit tlačítkem Zpět.)')) return;
    const all = [...elements.values()].map(clone);
    elements.clear();
    select(null);
    send('clear');
    pushHistory({ t: 'del', els: all });
    invalidate();
  };
  $('bgSelect').addEventListener('change', (e) => {
    meta.bg = e.target.value;
    send('meta', { bg: meta.bg });
    bgDirty = true;
    requestFrame();
    e.target.blur();
  });
  $('exportBtn').onclick = exportPng;
  $('shareBtn').onclick = async () => {
    const url = location.href;
    try {
      if (navigator.share && /Mobi|Android|iPad|iPhone/i.test(navigator.userAgent)) await navigator.share({ title: 'Online tabule', url });
      else { await navigator.clipboard.writeText(url); toast('Odkaz zkopírován – pošlete ho studentovi.'); }
    } catch (err) {
      prompt('Zkopírujte odkaz:', url);
    }
  };

  function duplicateSelected() {
    const el = selectedId && elements.get(selectedId);
    if (!el) return;
    const c = clone(el);
    c.id = uid();
    Object.assign(c, movedProps(pickProps(c), 20 / view.scale, 20 / view.scale));
    doAdd(c);
    select(c.id);
  }

  function exportPng() {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const o = out.getContext('2d');
    o.drawImage(bgCanvas, 0, 0);
    if (cacheDirty) rebuildCache();
    o.drawImage(cache, 0, 0);
    const a = document.createElement('a');
    a.download = `tabule-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
    a.href = out.toDataURL('image/png');
    a.click();
  }

  /* ---------- Klávesnice ---------- */
  const KEYS = { v: 'select', h: 'hand', p: 'pen', m: 'marker', e: 'eraser', x: 'strokeEraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); if (!spaceDown) { spaceDown = true; updateCursorStyle(); } return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { doDelete([selectedId]); return; }
    if (e.key === 'Escape') { select(null); return; }
    if (KEYS[k]) setTool(KEYS[k]);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { spaceDown = false; updateCursorStyle(); }
  });

  /* =========================================================
   *  Uživatelé a kurzory
   * ======================================================= */
  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function renderUsers() {
    const box = $('users');
    box.innerHTML = '';
    for (const u of users.values()) {
      const isMe = me && u.id === me.id;
      const chip = document.createElement('div');
      chip.className = 'user-chip' + (isMe ? ' me' : '');
      chip.title = isMe ? 'To jste vy – kliknutím změníte jméno' : u.name;
      chip.innerHTML = `<span class="avatar" style="background:${esc(u.color)}">${esc(initials(u.name))}</span><span class="uname">${esc(u.name)}${isMe ? ' (vy)' : ''}</span>`;
      if (isMe) chip.onclick = () => {
        const n = prompt('Vaše jméno:', u.name);
        if (n && n.trim()) { storeName(n.trim()); socket.emit('rename', n.trim()); }
      };
      box.appendChild(chip);
    }
    // kurzory
    for (const el of [...cursorsEl.children]) if (!users.has(el.dataset.id)) el.remove();
  }
  function positionCursor(id) {
    const u = users.get(id);
    const c = remoteCursors.get(id);
    if (!u || !c) return;
    let el = cursorsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'rcursor';
      el.dataset.id = id;
      el.innerHTML = '<svg class="arrow" viewBox="0 0 20 20"><path d="M2 1l6 17 2.6-6.9L17 8.8z"/></svg><div class="label"></div>';
      cursorsEl.appendChild(el);
    }
    el.querySelector('.arrow path').setAttribute('fill', u.color);
    const label = el.querySelector('.label');
    label.style.background = u.color;
    if (label.textContent !== u.name) label.textContent = u.name;
    const p = toScreen(c.x, c.y);
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  /* =========================================================
   *  Start
   * ======================================================= */
  window.addEventListener('resize', resize);
  resize();
  renderColors();
  setTool('pen');
  updateUndoButtons();
  setStatus(false);

  const name = storedName();
  if (name) connect(name);
  else {
    $('nameModal').hidden = false;
    setTimeout(() => $('nameInput').focus(), 50);
    $('nameForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const n = $('nameInput').value.trim();
      if (!n) return;
      storeName(n);
      $('nameModal').hidden = true;
      connect(n);
    });
  }
})();
