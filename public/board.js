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
  const UNIT = 30; // jeden čtvereček mřížky (ve světových souřadnicích)
  const LASER_MS = 1200;
  const THEMES = {
    light: { bg: '#ffffff', line: '#e3e7ee', dot: '#c3c8d2' },
    dark: { bg: '#1b1f27', line: 'rgba(255,255,255,0.08)', dot: 'rgba(255,255,255,0.22)' },
    green: { bg: '#2f5d46', line: 'rgba(255,255,255,0.11)', dot: 'rgba(255,255,255,0.25)' },
  };
  const FORMULA_KEYS = [
    ['a/b', '\\frac{a}{b}'], ['√x', '\\sqrt{x}'], ['ⁿ√x', '\\sqrt[n]{x}'], ['x²', '^{2}'], ['xₙ', '_{n}'],
    ['±', '\\pm '], ['·', '\\cdot '], ['÷', '\\div '], ['≤', '\\le '], ['≥', '\\ge '], ['≠', '\\neq '], ['≈', '\\approx '],
    ['∞', '\\infty '], ['π', '\\pi '], ['α', '\\alpha '], ['β', '\\beta '], ['°', '^{\\circ}'], ['( )', '\\left( x \\right)'],
    ['|x|', '\\left| x \\right|'], ['→', '\\rightarrow '], ['vektor', '\\vec{v}'], ['∑', '\\sum_{i=1}^{n} '], ['∫', '\\int_{a}^{b} '],
    ['lim', '\\lim_{x \\to \\infty} '], ['{ soustava', '\\begin{cases} x + y = 1 \\\\ x - y = 3 \\end{cases}'],
  ];

  const roomId = location.pathname.split('/').pop();
  const clientId = getClientId();
  const ownerKey = readOwnerKey();

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
  const lasers = new Map(); // uživatel -> { page, pts: [{x, y, t, brk}] }
  let view = { x: 0, y: 0, scale: 1 };
  let dpr = window.devicePixelRatio || 1;
  let W = 0;
  let H = 0;
  let me = null;
  let hasOwner = false;
  let meta = { bg: 'grid', theme: 'light', pages: [{ id: 'p1' }], title: '', locked: false };
  let currentPage = 'p1';
  const pageViews = {};
  let following = false;

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
  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* nic */ }
  }
  function getClientId() {
    let id = lsGet('tabule-client');
    if (!id) lsSet('tabule-client', (id = Math.random().toString(36).slice(2)));
    return id;
  }
  function readOwnerKey() {
    const m = location.hash.match(/owner=([\w-]+)/);
    if (m) {
      lsSet('tabule-owner-' + roomId, m[1]);
      history.replaceState(null, '', location.pathname); // klíč nesmí zůstat v adrese, kterou člověk sdílí
    }
    return lsGet('tabule-owner-' + roomId) || '';
  }
  const storedName = () => lsGet('tabule-name') || '';
  const storeName = (n) => lsSet('tabule-name', n);
  const round = (n) => Math.round(n * 10) / 10;
  const snap = (v) => Math.round(v / UNIT) * UNIT;
  const pageOf = (el) => el.page || 'p1';
  const onPage = (el) => pageOf(el) === currentPage;
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
  function toast(msg, ms = 2400) {
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
  function fmtNum(n, digits = 1) {
    return n.toLocaleString('cs-CZ', { maximumFractionDigits: digits });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- Barvy podle vzhledu tabule ---------- */
  function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 1;
    const n = parseInt(m[1], 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  // Na tmavé/zelené tabuli se tmavý inkoust zobrazí jako křída
  function displayColor(c) {
    if (meta.theme === 'light') return c;
    return luminance(c) < 0.06 ? '#f1f5f9' : c;
  }
  const themeOf = () => THEMES[meta.theme] || THEMES.light;

  /* ---------- Oprávnění ---------- */
  const isOwner = () => !!(me && me.isOwner);
  const privileged = () => isOwner() || !hasOwner;
  const canEdit = () => privileged() || !meta.locked;
  function guardEdit() {
    if (canEdit()) return true;
    toast('Lektor tabuli uzamkl – teď můžete jen ukazovat laserem.');
    return false;
  }

  /* =========================================================
   *  Síť
   * ======================================================= */
  let socket = null;
  let ready = false; // true po přijetí 'init'

  function connect(name) {
    socket = io({ auth: { room: roomId, name, clientId, ownerKey } });
    socket.on('connect', () => setStatus(true));
    socket.on('disconnect', () => { ready = false; setStatus(false); });
    socket.on('connect_error', () => setStatus(false));

    socket.on('init', (data) => {
      me = data.you;
      hasOwner = !!data.hasOwner;
      ready = true;
      elements.clear();
      drafts.clear();
      for (const el of data.elements) elements.set(el.id, el);
      users.clear();
      for (const u of data.users) users.set(u.id, u);
      applyMeta(data.meta || meta);
      renderUsers();
      // odeslat, co se nakreslilo během výpadku
      const q = offlineQueue.splice(0);
      for (const [ev, payload] of q) {
        applyLocal(ev, payload);
        socket.emit(ev, payload);
      }
      if (selectedId && !elements.has(selectedId)) select(null);
      rememberBoard();
      if (isOwner()) sendView(true);
      bgDirty = true;
      invalidate();
    });

    socket.on('add', (els) => {
      for (const el of els) {
        drafts.delete(el.id);
        const appendOnly = !elements.has(el.id);
        elements.set(el.id, el);
        if (!onPage(el)) continue;
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
    socket.on('clear', (msg) => {
      const page = msg && msg.page;
      for (const [id, el] of elements) if (!page || pageOf(el) === page) elements.delete(id);
      if (selectedId && !elements.has(selectedId)) select(null);
      invalidate();
    });
    socket.on('meta', (m) => applyMeta(m));
    socket.on('denied', (msg) => {
      toast(msg || 'Akce není povolena.');
      // znovu načíst stav ze serveru
      socket.disconnect();
      socket.connect();
    });

    socket.on('draft', (d) => {
      let el = drafts.get(d.id);
      if (d.el) {
        // celý prvek (tvary)
        drafts.set(d.id, { ...d.el, _user: d.user });
      } else if (d.pts) {
        if (!el) {
          el = { id: d.id, type: 'stroke', pts: [], color: d.color, size: d.size, mode: d.mode, page: d.page, _user: d.user };
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
      remoteCursors.set(c.user, { x: c.x, y: c.y, page: c.page || 'p1' });
      positionCursor(c.user);
    });
    socket.on('laser', (l) => {
      let tr = lasers.get(l.user);
      if (!tr) lasers.set(l.user, (tr = { page: l.page, pts: [] }));
      tr.page = l.page;
      const now = performance.now();
      const p = l.pts || [];
      for (let i = 0; i < p.length; i += 3) tr.pts.push({ x: p[i], y: p[i + 1], brk: !!p[i + 2], t: now });
      requestFrame();
    });
    socket.on('teacher-view', (v) => { if (following) applyTeacherView(v); });
    socket.on('want-view', () => { if (isOwner()) sendView(true); });

    socket.on('user-joined', (u) => {
      users.set(u.id, u);
      renderUsers();
      toast(`${u.name} se připojil(a)`);
      if (isOwner()) setTimeout(() => sendView(true), 300);
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
      lasers.delete(id);
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
    else if (ev === 'clear') for (const [id, el] of elements) if (pageOf(el) === payload.page) elements.delete(id);
  }

  function setStatus(on) {
    const s = $('status');
    s.className = 'status ' + (on ? 'on' : 'off');
    s.title = on ? 'Připojeno' : 'Odpojeno – zkouším znovu…';
    if (!on && me) toast('Spojení přerušeno, zkouším se znovu připojit…');
  }

  /* ---------- Sdílená nastavení tabule ---------- */
  function applyMeta(m) {
    meta = { bg: 'grid', theme: 'light', title: '', locked: false, ...m };
    if (!Array.isArray(meta.pages) || !meta.pages.length) meta.pages = [{ id: 'p1' }];
    if (!meta.pages.some((p) => p.id === currentPage)) switchPage(meta.pages[0].id, false);
    document.body.classList.toggle('dark-ui', meta.theme !== 'light');
    document.body.classList.toggle('privileged', privileged());
    document.querySelectorAll('#bgMenu [data-bg]').forEach((b) => b.classList.toggle('checked', b.dataset.bg === meta.bg));
    document.querySelectorAll('#bgMenu [data-theme]').forEach((b) => b.classList.toggle('checked', b.dataset.theme === meta.theme));
    const locked = !!meta.locked;
    const lockBtn = $('lockBtn');
    lockBtn.classList.toggle('active', locked);
    lockBtn.querySelector('.shackle').setAttribute('d', locked ? 'M8 11V8a4 4 0 018 0v3' : 'M8 11V7a4 4 0 017.6-1.8');
    lockBtn.title = locked ? 'Tabule je zamčená – kliknutím povolíte studentům kreslit' : 'Zamknout kreslení studentům';
    $('lockBanner').hidden = !(locked && !privileged());
    const title = meta.title || 'Tabule';
    $('titleBtn').textContent = title;
    $('titleBtn').title = privileged() ? 'Kliknutím přejmenujete tabuli' : title;
    document.title = meta.title ? meta.title + ' – Tabule' : 'Tabule';
    renderColors();
    updatePager();
    updateFollowUI();
    if (!textEditor.hidden) positionTextEditor();
    rememberBoard();
    bgDirty = true;
    invalidate();
  }
  function setMeta(patch) {
    send('meta', patch);
    applyMeta({ ...meta, ...patch });
  }

  /* ---------- Seznam mých tabulí (na úvodní stránce) ---------- */
  function rememberBoard() {
    if (!me) return;
    let list = [];
    try { list = JSON.parse(lsGet('tabule-boards') || '[]'); } catch (e) { list = []; }
    list = list.filter((b) => b.id !== roomId);
    list.unshift({ id: roomId, title: meta.title || '', owner: isOwner(), visited: Date.now() });
    lsSet('tabule-boards', JSON.stringify(list.slice(0, 60)));
  }

  /* =========================================================
   *  Operace s historií (Zpět / Znovu)
   * ======================================================= */
  function doAdd(els, record = true) {
    if (!guardEdit()) return false;
    els = [].concat(els);
    let incremental = !cacheDirty;
    for (const el of els) {
      if (!el.page) el.page = currentPage;
      if (elements.has(el.id)) incremental = false;
      elements.set(el.id, el);
    }
    send('add', els.map(stripPrivate));
    if (record) pushHistory({ t: 'add', els: els.map(clone) });
    if (incremental) {
      for (const el of els) if (onPage(el)) drawElementToCache(el);
      requestFrame();
    } else invalidate();
    return true;
  }
  function doDelete(ids, record = true) {
    if (!guardEdit()) return false;
    const removed = [];
    for (const id of ids) {
      const el = elements.get(id);
      if (el) { removed.push(clone(el)); elements.delete(id); }
      if (id === selectedId) select(null);
    }
    if (!removed.length) return false;
    send('delete', removed.map((e) => e.id));
    if (record) pushHistory({ t: 'del', els: removed });
    invalidate();
    return true;
  }
  function doUpdate(id, props, before, record = true) {
    if (!guardEdit()) return false;
    const el = elements.get(id);
    if (!el) return false;
    Object.assign(el, props);
    resetDerived(el);
    send('update', { id, props });
    if (record) pushHistory({ t: 'upd', id, before, after: props });
    invalidate();
    return true;
  }
  function pushHistory(entry) {
    undoStack.push(entry);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }
  // Při Zpět/Znovu přepnout na stranu, které se změna týká
  function showEntryPage(e) {
    const el = e.els ? e.els[0] : elements.get(e.id);
    if (el && pageOf(el) !== currentPage && meta.pages.some((p) => p.id === pageOf(el))) switchPage(pageOf(el));
  }
  function undo() {
    if (!canEdit()) return guardEdit();
    const e = undoStack.pop();
    if (!e) return;
    showEntryPage(e);
    if (e.t === 'add') doDelete(e.els.map((x) => x.id), false);
    else if (e.t === 'del') doAdd(e.els.map(clone), false);
    else if (e.t === 'upd') doUpdate(e.id, e.before, null, false);
    redoStack.push(e);
    updateUndoButtons();
  }
  function redo() {
    if (!canEdit()) return guardEdit();
    const e = redoStack.pop();
    if (!e) return;
    showEntryPage(e);
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
    if (isOwner()) sendView();
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
    for (const d of drafts.values()) if (onPage(d)) drawElement(ctx, d);
    if (current) drawElement(ctx, current);
    drawSelection();
    drawEraserCursor();
    drawLasers();
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
      if (!onPage(el)) continue;
      const b = bounds(el);
      if (b && (b.x2 < tl.x || b.x1 > br.x || b.y2 < tl.y || b.y1 > br.y)) continue;
      drawElement(cacheCtx, el);
    }
  }
  function drawElementToCache(el) {
    applyView(cacheCtx);
    drawElement(cacheCtx, el);
  }

  // Vzor pozadí (s = pixely zařízení na jednotku světa, tx/ty = posun v pixelech)
  function drawPattern(c, width, height, s, tx, ty, minGap) {
    const th = themeOf();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = th.bg;
    c.fillRect(0, 0, width, height);
    if (meta.bg === 'blank') return;
    let step = UNIT;
    while (step * s < minGap) step *= 5;
    const g = step * s;
    const ox = ((tx % g) + g) % g;
    const oy = ((ty % g) + g) % g;
    c.lineWidth = 1;
    if (meta.bg === 'dots') {
      c.fillStyle = th.dot;
      const r = Math.max(1, minGap / 9);
      for (let x = ox; x < width; x += g)
        for (let y = oy; y < height; y += g) c.fillRect(x - r / 2, y - r / 2, r, r);
      return;
    }
    c.strokeStyle = th.line;
    c.beginPath();
    if (meta.bg === 'grid') {
      for (let x = ox; x < width; x += g) { c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, height); }
    }
    for (let y = oy; y < height; y += g) { c.moveTo(0, Math.round(y) + 0.5); c.lineTo(width, Math.round(y) + 0.5); }
    c.stroke();
  }
  function drawBackground() {
    bgDirty = false;
    drawPattern(bgCtx, bgCanvas.width, bgCanvas.height, view.scale * dpr, view.x * dpr, view.y * dpr, 12 * dpr);
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
          c.strokeStyle = displayColor(el.color);
          if (el.mode === 'marker') {
            c.globalAlpha = 0.35;
            c.globalCompositeOperation = meta.theme === 'light' ? 'multiply' : 'source-over';
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
      case 'formula':
        drawFormula(c, el);
        break;
    }
    c.restore();
  }

  function labelBox(c, text, x, y, color, size = 14) {
    c.save();
    c.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const w = c.measureText(text).width + size * 0.8;
    const h = size * 1.5;
    c.globalAlpha = 0.85;
    c.fillStyle = themeOf().bg;
    c.beginPath();
    if (c.roundRect) c.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    else c.rect(x - w / 2, y - h / 2, w, h);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = color;
    c.fillText(text, x, y + 0.5);
    c.restore();
  }

  function drawShape(c, el) {
    const { x1, y1, x2, y2 } = el;
    const col = displayColor(el.color);
    c.strokeStyle = col;
    c.fillStyle = col;
    c.lineWidth = el.size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    switch (el.shape) {
      case 'line':
      case 'arrow':
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.stroke();
        if (el.shape === 'arrow') arrowHead(c, x1, y1, x2, y2, Math.max(12, el.size * 4));
        return;
      case 'measure': {
        const a = Math.atan2(y2 - y1, x2 - x1);
        const nx = -Math.sin(a) * 7, ny = Math.cos(a) * 7;
        c.lineWidth = Math.min(el.size, 3);
        c.moveTo(x1, y1); c.lineTo(x2, y2);
        c.moveTo(x1 - nx, y1 - ny); c.lineTo(x1 + nx, y1 + ny);
        c.moveTo(x2 - nx, y2 - ny); c.lineTo(x2 + nx, y2 + ny);
        c.stroke();
        const len = Math.hypot(x2 - x1, y2 - y1) / UNIT;
        labelBox(c, fmtNum(len) + ' j', (x1 + x2) / 2 + nx * 2.6, (y1 + y2) / 2 + ny * 2.6, col);
        return;
      }
      case 'angle':
        drawAngle(c, el, col);
        return;
      case 'axes':
        drawAxes(c, el, col);
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

  function arrowHead(c, x1, y1, x2, y2, len) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - len * Math.cos(a - 0.45), y2 - len * Math.sin(a - 0.45));
    c.lineTo(x2 - len * Math.cos(a + 0.45), y2 - len * Math.sin(a + 0.45));
    c.closePath();
    c.fill();
    c.stroke();
  }

  function angleInfo(el) {
    const a1 = Math.atan2(el.y1 - el.y0, el.x1 - el.x0);
    const a2 = Math.atan2(el.y2 - el.y0, el.x2 - el.x0);
    let d = a2 - a1;
    while (d <= -Math.PI) d += Math.PI * 2;
    while (d > Math.PI) d -= Math.PI * 2;
    return { a1, d, deg: Math.abs(d) * 180 / Math.PI };
  }
  function drawAngle(c, el, col) {
    const { x0, y0, x1, y1, x2, y2 } = el;
    c.lineWidth = Math.min(el.size, 4);
    c.moveTo(x0, y0); c.lineTo(x1, y1);
    const second = !(x2 === x1 && y2 === y1);
    if (second) { c.moveTo(x0, y0); c.lineTo(x2, y2); }
    c.stroke();
    c.beginPath();
    c.arc(x0, y0, 3, 0, Math.PI * 2);
    c.fill();
    if (!second) return;
    const { a1, d, deg } = angleInfo(el);
    const l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(x2 - x0, y2 - y0);
    const r = Math.max(10, Math.min(40, l1 * 0.6, l2 * 0.6));
    c.lineWidth = 1.5;
    c.beginPath();
    if (Math.abs(Math.round(deg) - 90) === 0) {
      // pravý úhel = čtvereček
      const s = r * 0.6;
      const u1 = { x: Math.cos(a1), y: Math.sin(a1) }, u2 = { x: Math.cos(a1 + d), y: Math.sin(a1 + d) };
      c.moveTo(x0 + u1.x * s, y0 + u1.y * s);
      c.lineTo(x0 + (u1.x + u2.x) * s, y0 + (u1.y + u2.y) * s);
      c.lineTo(x0 + u2.x * s, y0 + u2.y * s);
    } else {
      c.arc(x0, y0, r, a1, a1 + d, d < 0);
    }
    c.stroke();
    const mid = a1 + d / 2;
    labelBox(c, fmtNum(deg, 0) + '°', x0 + Math.cos(mid) * (r + 20), y0 + Math.sin(mid) * (r + 20), col);
  }

  function axesBox(el) {
    return { l: Math.min(el.x1, el.x2), r: Math.max(el.x1, el.x2), t: Math.min(el.y1, el.y2), b: Math.max(el.y1, el.y2) };
  }
  function drawAxes(c, el, col) {
    const { l, r, t, b } = axesBox(el);
    const ox = el.ox, oy = el.oy;
    c.lineWidth = 2;
    c.moveTo(l, oy); c.lineTo(r, oy);
    c.moveTo(ox, b); c.lineTo(ox, t);
    c.stroke();
    c.lineWidth = 1.5;
    arrowHead(c, l, oy, r + 4, oy, 11);
    arrowHead(c, ox, b, ox, t - 4, 11);
    c.beginPath();
    c.lineWidth = 1.5;
    c.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    c.fillStyle = col;
    c.textAlign = 'center';
    c.textBaseline = 'top';
    for (let x = ox + UNIT, k = 1; x < r - 6; x += UNIT, k++) { c.moveTo(x, oy - 4); c.lineTo(x, oy + 4); c.fillText(String(k), x, oy + 7); }
    for (let x = ox - UNIT, k = -1; x > l + 2; x -= UNIT, k--) { c.moveTo(x, oy - 4); c.lineTo(x, oy + 4); c.fillText('−' + -k, x, oy + 7); }
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (let y = oy - UNIT, k = 1; y > t + 6; y -= UNIT, k++) { c.moveTo(ox - 4, y); c.lineTo(ox + 4, y); c.fillText(String(k), ox - 8, y); }
    for (let y = oy + UNIT, k = -1; y < b - 2; y += UNIT, k--) { c.moveTo(ox - 4, y); c.lineTo(ox + 4, y); c.fillText('−' + -k, ox - 8, y); }
    c.stroke();
    c.fillText('0', ox - 6, oy + 12);
    c.font = 'italic 600 15px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    c.textAlign = 'right';
    c.fillText('x', r + 2, oy - 14);
    c.textAlign = 'left';
    c.fillText('y', ox + 10, t + 2);
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
    c.fillStyle = displayColor(el.color);
    c.textBaseline = 'top';
    const lines = String(el.text).split('\n');
    lines.forEach((l, i) => c.fillText(l, el.x, el.y + i * el.size * 1.25 + el.size * 0.1));
  }

  function getImage(src) {
    let img = images.get(src);
    if (!img) {
      img = new Image();
      img.onload = invalidate;
      img.src = src;
      images.set(src, img);
    }
    return img;
  }
  function drawImage(c, el) {
    const img = getImage(el.src);
    if (img.complete && img.naturalWidth) c.drawImage(img, el.x, el.y, el.w, el.h);
    else {
      c.fillStyle = '#eef0f3';
      c.fillRect(el.x, el.y, el.w, el.h);
    }
  }
  function formulaSrc(el) {
    const svg = el.svg.replace('<svg', `<svg color="${displayColor(el.color)}"`);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function drawFormula(c, el) {
    const key = displayColor(el.color) + '|' + el.svg.length + '|' + el.tex;
    if (el._imgKey !== key) {
      el._imgKey = key;
      el._img = new Image();
      el._img.onload = invalidate;
      el._img.src = formulaSrc(el);
    }
    if (el._img.complete && el._img.naturalWidth) c.drawImage(el._img, el.x, el.y, el.w, el.h);
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
      const xs = [el.x1, el.x2], ys = [el.y1, el.y2];
      if (el.x0 != null) { xs.push(el.x0); ys.push(el.y0); }
      let r = el.size / 2;
      if (el.shape === 'arrow') r += Math.max(12, el.size * 4);
      if (el.shape === 'measure' || el.shape === 'angle') r += 30;
      if (el.shape === 'axes') r = 18;
      b = { x1: Math.min(...xs) - r, y1: Math.min(...ys) - r, x2: Math.max(...xs) + r, y2: Math.max(...ys) + r };
    } else if (el.type === 'text') {
      measureText(el);
      b = { x1: el.x, y1: el.y, x2: el.x + el._w, y2: el.y + el._h };
    } else if (el.type === 'image' || el.type === 'formula') {
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
      switch (el.shape) {
        case 'line':
        case 'arrow':
        case 'measure':
          return distToSeg(x, y, x1, y1, x2, y2) <= r + (el.shape === 'measure' ? 6 : 0);
        case 'angle':
          return distToSeg(x, y, el.x0, el.y0, x1, y1) <= r || distToSeg(x, y, el.x0, el.y0, x2, y2) <= r;
        case 'axes': {
          const bx = axesBox(el);
          return distToSeg(x, y, bx.l, el.oy, bx.r, el.oy) <= 6 + tol || distToSeg(x, y, el.ox, bx.t, el.ox, bx.b) <= 6 + tol;
        }
        case 'rect': {
          const l = Math.min(x1, x2), rr = Math.max(x1, x2), t = Math.min(y1, y2), bt = Math.max(y1, y2);
          if (el.fill && x >= l && x <= rr && y >= t && y <= bt) return true;
          return distToSeg(x, y, l, t, rr, t) <= r || distToSeg(x, y, rr, t, rr, bt) <= r ||
            distToSeg(x, y, rr, bt, l, bt) <= r || distToSeg(x, y, l, bt, l, t) <= r;
        }
      }
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2 || 1, ry = Math.abs(y2 - y1) / 2 || 1;
      const nd = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (el.fill && nd <= 1) return true;
      return Math.abs(nd - 1) * Math.min(rx, ry) <= r;
    }
    return true; // text, obrázek, vzorec: stačí obdélník
  }

  function topHit(x, y, tol) {
    const arr = [...elements.values()];
    for (let i = arr.length - 1; i >= 0; i--) if (onPage(arr[i]) && hit(arr[i], x, y, tol)) return arr[i];
    return null;
  }

  /* ---------- Výběr ---------- */
  const RESIZABLE = (el) => el.type === 'image' || el.type === 'text' || el.type === 'formula' || (el.type === 'shape' && el.shape === 'axes');
  function select(id) {
    selectedId = id;
    $('selectionBar').hidden = !id;
    const el = id && elements.get(id);
    $('editSelBtn').hidden = !(el && el.type === 'formula');
    requestFrame();
  }
  function handleRect(el) {
    const b = bounds(el);
    const s = 12 / view.scale;
    return { x: b.x2 - s / 2, y: b.y2 - s / 2, s };
  }
  function drawSelection() {
    const el = selectedId && elements.get(selectedId);
    if (!el || !onPage(el)) return;
    const b = bounds(el);
    const pad = 4 / view.scale;
    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / view.scale;
    ctx.setLineDash([6 / view.scale, 4 / view.scale]);
    ctx.strokeRect(b.x1 - pad, b.y1 - pad, b.x2 - b.x1 + pad * 2, b.y2 - b.y1 + pad * 2);
    ctx.setLineDash([]);
    if (RESIZABLE(el)) {
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
    ctx.strokeStyle = meta.theme === 'light' ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1 / view.scale;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- Laserové ukazovátko ---------- */
  function drawLasers() {
    if (!lasers.size) return;
    const now = performance.now();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ff2d2d';
    ctx.fillStyle = '#ff2d2d';
    ctx.shadowColor = 'rgba(255, 30, 30, 0.9)';
    ctx.shadowBlur = 10 * dpr;
    for (const [key, tr] of lasers) {
      while (tr.pts.length && now - tr.pts[0].t > LASER_MS) tr.pts.shift();
      if (!tr.pts.length) { lasers.delete(key); continue; }
      if (tr.page !== currentPage) continue;
      const p = tr.pts;
      for (let i = 1; i < p.length; i++) {
        if (p[i].brk) continue;
        const age = (now - p[i].t) / LASER_MS;
        ctx.globalAlpha = Math.max(0, 1 - age);
        ctx.lineWidth = (5 * (1 - age * 0.6)) / view.scale;
        ctx.beginPath();
        ctx.moveTo(p[i - 1].x, p[i - 1].y);
        ctx.lineTo(p[i].x, p[i].y);
        ctx.stroke();
      }
      const last = p[p.length - 1];
      if (now - last.t < 250) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    if (lasers.size) requestFrame();
  }
  let laserBuf = [];
  let laserTimer = 0;
  function laserPoint(w, brk) {
    let tr = lasers.get('me');
    if (!tr) lasers.set('me', (tr = { page: currentPage, pts: [] }));
    tr.page = currentPage;
    tr.pts.push({ x: w.x, y: w.y, brk, t: performance.now() });
    laserBuf.push(round(w.x), round(w.y), brk ? 1 : 0);
    if (!laserTimer) {
      laserTimer = setTimeout(() => {
        laserTimer = 0;
        sendVolatile('laser', { page: currentPage, pts: laserBuf });
        laserBuf = [];
      }, 30);
    }
    requestFrame();
  }

  /* =========================================================
   *  Vstup (myš, pero, dotyk)
   * ======================================================= */
  const pointers = new Map(); // aktivní dotyky
  let action = null; // { kind: 'draw'|'pan'|'move'|'resize'|'erase'|'pinch'|'laser'|'angle1'|'angle2' ... }
  let spaceDown = false;
  let penSeen = false; // pokud uživatel používá stylus, prst jen posouvá
  let pointerType = 'mouse';
  let draftTimer = 0;
  let draftSent = 0;
  const FREE_TOOLS = new Set(['hand', 'laser']); // povolené i na zamčené tabuli

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { pointerWorld = null; requestFrame(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function snapAngle(x0, y0, x, y) {
    const a = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 12)) * (Math.PI / 12);
    const len = Math.hypot(x - x0, y - y0);
    return { x: x0 + Math.cos(a) * len, y: y0 + Math.sin(a) * len };
  }

  function onPointerDown(e) {
    closeMenu();
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
    if (!FREE_TOOLS.has(tool) && !guardEdit()) return;
    const base = { id: uid(), page: currentPage, color: state.color };

    if (tool === 'laser') {
      action = { kind: 'laser' };
      laserPoint(w, true);
    } else if (tool === 'pen' || tool === 'marker' || tool === 'eraser') {
      const mode = tool === 'pen' ? 'pen' : tool === 'marker' ? 'marker' : 'erase';
      current = { ...base, type: 'stroke', mode, size: currentSize(), pts: [round(w.x), round(w.y)] };
      draftSent = 0;
      action = { kind: 'draw' };
      requestFrame();
    } else if (tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse' || tool === 'measure') {
      current = { ...base, type: 'shape', shape: tool, size: currentSize('default'), fill: state.fill && (tool === 'rect' || tool === 'ellipse'), x1: round(w.x), y1: round(w.y), x2: round(w.x), y2: round(w.y) };
      action = { kind: 'shape' };
    } else if (tool === 'angle') {
      if (current && current._phase === 2) {
        action = { kind: 'angle2' };
        updateAngleArm(e, w);
      } else {
        const p = { x: round(w.x), y: round(w.y) };
        current = { ...base, type: 'shape', shape: 'angle', size: currentSize('default'), x0: p.x, y0: p.y, x1: p.x, y1: p.y, x2: p.x, y2: p.y, _phase: 1 };
        action = { kind: 'angle1' };
      }
    } else if (tool === 'strokeEraser') {
      action = { kind: 'erase', removed: [] };
      eraseAt(w);
    } else if (tool === 'text') {
      const t = topHit(w.x, w.y, 2 / view.scale);
      if (t && t.type === 'text') openTextEditor(t);
      else openTextEditor(null, w);
    } else if (tool === 'select') {
      const sel = selectedId && elements.get(selectedId);
      if (sel && onPage(sel) && RESIZABLE(sel)) {
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
        if (e.detail === 2 && t.type === 'formula') { openFormula(t); return; }
        action = { kind: 'move', id: t.id, start: w, before: pickProps(t) };
      }
    }
  }

  function updateAngleArm(e, w) {
    let p = { x: w.x, y: w.y };
    if (e.shiftKey) p = snapAngle(current.x0, current.y0, p.x, p.y);
    if (current._phase === 1) { current.x1 = current.x2 = round(p.x); current.y1 = current.y2 = round(p.y); }
    else { current.x2 = round(p.x); current.y2 = round(p.y); }
    scheduleDraft();
    requestFrame();
  }

  function onPointerMove(e) {
    const w = toWorld(e.clientX, e.clientY);
    pointerWorld = w;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    sendCursor(w);

    if (!action) {
      if (current && current._phase === 2) updateAngleArm(e, w);
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
      case 'laser': {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        for (const ev of evs.length ? evs : [e]) laserPoint(toWorld(ev.clientX, ev.clientY), false);
        break;
      }
      case 'draw': {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
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
          if (current.shape === 'line' || current.shape === 'arrow' || current.shape === 'measure') {
            ({ x: x2, y: y2 } = snapAngle(current.x1, current.y1, x2, y2));
          } else {
            const dx = x2 - current.x1, dy = y2 - current.y1;
            const m = Math.max(Math.abs(dx), Math.abs(dy));
            x2 = current.x1 + Math.sign(dx || 1) * m; y2 = current.y1 + Math.sign(dy || 1) * m;
          }
        }
        current.x2 = round(x2); current.y2 = round(y2);
        scheduleDraft();
        requestFrame();
        break;
      }
      case 'angle1':
      case 'angle2':
        updateAngleArm(e, w);
        break;
      case 'erase':
        eraseAt(w);
        break;
      case 'move': {
        const el = elements.get(action.id);
        if (!el) { action = null; return; }
        let dx = w.x - action.start.x, dy = w.y - action.start.y;
        if (el.shape === 'axes') { dx = snap(dx); dy = snap(dy); } // osy drží mřížku
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
    } else if (a.kind === 'angle1') {
      if (Math.hypot(current.x1 - current.x0, current.y1 - current.y0) < 4) {
        // Klik bez tažení: první rameno vznikne dalším kliknutím
        toast('Táhněte od vrcholu úhlu k prvnímu rameni.');
        cancelCurrent();
        return;
      }
      current._phase = 2;
      toast('Teď klikněte nebo táhněte pro druhé rameno (Esc = zrušit).');
    } else if (a.kind === 'angle2') {
      const el = current;
      current = null;
      clearTimeout(draftTimer); draftTimer = 0;
      delete el._phase;
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

  const COORD_KEYS = ['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'ox', 'oy'];
  function pickProps(el) {
    if (el.type === 'stroke') return { dx: el.dx || 0, dy: el.dy || 0 };
    if (el.type === 'shape') {
      const o = {};
      for (const k of COORD_KEYS) if (el[k] != null) o[k] = el[k];
      return o;
    }
    if (el.type === 'text') return { x: el.x, y: el.y, size: el.size };
    if (el.type === 'image' || el.type === 'formula') return { x: el.x, y: el.y, w: el.w, h: el.h };
    return {};
  }
  function movedProps(b, dx, dy) {
    if ('dx' in b) return { dx: round(b.dx + dx), dy: round(b.dy + dy) };
    if ('x1' in b) {
      const o = {};
      for (const k in b) o[k] = round(b[k] + (k.includes('x') ? dx : dy));
      return o;
    }
    return { ...b, x: round(b.x + dx), y: round(b.y + dy) };
  }
  function resizedProps(el, b, w) {
    if (el.type === 'image' || el.type === 'formula') {
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
    if (el.shape === 'axes') {
      // pravý dolní roh, vždy alespoň jeden dílek za počátkem
      return { x2: Math.max(b.ox + UNIT * 2, snap(w.x)), y2: Math.max(b.oy + UNIT * 2, snap(w.y)), x1: b.x1, y1: b.y1 };
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
        sendVolatile('draft', { id: current.id, page: current.page, color: current.color, size: current.size, mode: current.mode, pts });
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
      if (!onPage(el) || el.type === 'image' || el.type === 'formula') continue; // obrázky a vzorce mažte přes výběr
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
      if (lastCursor) sendVolatile('cursor', { x: round(lastCursor.x), y: round(lastCursor.y), page: currentPage });
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
  function viewChanged(byUser = true) {
    bgDirty = true;
    invalidate();
    if (!textEditor.hidden) positionTextEditor();
    if (byUser && following) stopFollow();
    if (isOwner()) sendView();
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
   *  Sledování lektora (volitelné)
   * ======================================================= */
  let viewTimer = 0;
  function sendView(now) {
    if (!isOwner()) return;
    const go = () => {
      viewTimer = 0;
      const a = toWorld(0, 0), b = toWorld(W, H);
      sendVolatile('view', { page: currentPage, x1: round(a.x), y1: round(a.y), x2: round(b.x), y2: round(b.y) });
    };
    if (now) { clearTimeout(viewTimer); go(); return; }
    if (!viewTimer) viewTimer = setTimeout(go, 100);
  }
  function applyTeacherView(v) {
    if (v.page && v.page !== currentPage && meta.pages.some((p) => p.id === v.page)) switchPage(v.page, false);
    const w = v.x2 - v.x1, h = v.y2 - v.y1;
    if (!(w > 0 && h > 0)) return;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(W / w, H / h)));
    view.scale = s;
    view.x = W / 2 - ((v.x1 + v.x2) / 2) * s;
    view.y = H / 2 - ((v.y1 + v.y2) / 2) * s;
    viewChanged(false);
  }
  function ownerOnline() {
    return [...users.values()].some((u) => u.isOwner && (!me || u.id !== me.id));
  }
  function updateFollowUI() {
    const show = hasOwner && !isOwner() && ownerOnline();
    $('followBtn').hidden = !show;
    if (!show && following) following = false;
    $('followBtn').classList.toggle('active', following);
  }
  function stopFollow() {
    following = false;
    updateFollowUI();
    toast('Sledování lektora vypnuto.');
  }
  $('followBtn').onclick = () => {
    following = !following;
    updateFollowUI();
    if (following) {
      socket && socket.emit('want-view');
      toast('Sledujete lektora – váš pohled se posouvá s ním.');
    } else toast('Sledování lektora vypnuto.');
  };

  /* =========================================================
   *  Strany
   * ======================================================= */
  function pageIndex() {
    return Math.max(0, meta.pages.findIndex((p) => p.id === currentPage));
  }
  function updatePager() {
    const i = pageIndex(), n = meta.pages.length;
    $('pageLabel').textContent = `${i + 1} / ${n}`;
    $('prevPage').disabled = i === 0;
    $('nextPage').disabled = i >= n - 1;
    $('delPage').disabled = n <= 1;
  }
  function switchPage(id, byUser = true) {
    if (id === currentPage) return;
    if (!textEditor.hidden) commitText();
    if (current) cancelCurrent();
    select(null);
    pageViews[currentPage] = { ...view };
    currentPage = id;
    view = pageViews[id] ? { ...pageViews[id] } : { x: 0, y: 0, scale: 1 };
    updatePager();
    viewChanged(byUser);
    for (const cid of remoteCursors.keys()) positionCursor(cid);
    if (lastCursor) sendCursor(lastCursor);
  }
  $('prevPage').onclick = () => { const i = pageIndex(); if (i > 0) switchPage(meta.pages[i - 1].id); };
  $('nextPage').onclick = () => { const i = pageIndex(); if (i < meta.pages.length - 1) switchPage(meta.pages[i + 1].id); };
  $('addPage').onclick = () => {
    if (!guardEdit()) return;
    const id = 'p' + uid().slice(-9);
    const pages = meta.pages.slice();
    pages.splice(pageIndex() + 1, 0, { id });
    setMeta({ pages });
    switchPage(id);
    toast(`Nová strana ${pageIndex() + 1}`);
  };
  $('delPage').onclick = () => {
    if (meta.pages.length <= 1) return;
    if (!confirm(`Smazat stranu ${pageIndex() + 1} i s obsahem pro všechny? Tuto akci nelze vrátit.`)) return;
    const i = pageIndex();
    const del = currentPage;
    const pages = meta.pages.filter((p) => p.id !== del);
    for (const [id, el] of elements) if (pageOf(el) === del) elements.delete(id);
    switchPage(pages[Math.min(i, pages.length - 1)].id);
    setMeta({ pages });
  };

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
    textEditor.style.color = displayColor(textStyle.color);
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
  $('imageBtn').onclick = () => { if (guardEdit()) $('imageInput').click(); };
  $('imageInput').addEventListener('change', (e) => {
    [...e.target.files].forEach((f, i) => addImageFile(f, i));
    e.target.value = '';
  });
  window.addEventListener('paste', (e) => {
    if (!textEditor.hidden || !$('formulaModal').hidden) return;
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
    if (!file || !guardEdit()) return;
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
        if (doAdd(el)) {
          setTool('select');
          select(el.id);
        }
      };
      img.onerror = () => toast('Obrázek se nepodařilo načíst.');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // Najde místo poblíž středu obrazovky, kde nový prvek nic nepřekryje
  function freeSpot(w, h) {
    const c = toWorld(W / 2, H / 2);
    const others = [...elements.values()].filter(onPage).map(bounds);
    const free = (x, y) => !others.some((b) => x < b.x2 && x + w > b.x1 && y < b.y2 && y + h > b.y1);
    const step = Math.max(UNIT, Math.min(w, h) / 2);
    for (let r = 0; r < 12; r++) {
      for (const [dx, dy] of r ? [[0, r], [0, -r], [r, 0], [-r, 0], [r, r], [-r, r], [r, -r], [-r, -r]] : [[0, 0]]) {
        const x = c.x - w / 2 + dx * step, y = c.y - h / 2 + dy * step;
        if (free(x, y)) return { x: round(x), y: round(y) };
      }
    }
    return { x: round(c.x - w / 2), y: round(c.y - h / 2) };
  }

  /* =========================================================
   *  Matematické pomůcky
   * ======================================================= */
  function insertAxes() {
    if (!guardEdit()) return;
    const c = toWorld(W / 2, H / 2);
    const ox = snap(c.x), oy = snap(c.y);
    const hw = Math.max(3, Math.min(8, Math.floor((W * 0.35) / view.scale / UNIT))) * UNIT;
    const hh = Math.max(3, Math.min(6, Math.floor((H * 0.35) / view.scale / UNIT))) * UNIT;
    const el = { id: uid(), type: 'shape', shape: 'axes', color: state.color, size: 2, ox, oy, x1: ox - hw, y1: oy - hh, x2: ox + hw, y2: oy + hh };
    if (doAdd(el)) {
      setTool('select');
      select(el.id);
      toast('Osy vloženy – posunete je nástrojem Výběr, za roh je zvětšíte.');
    }
  }

  /* ---------- Vzorce (LaTeX → SVG pomocí MathJax, načte se až při použití) ---------- */
  let mathJaxPromise = null;
  function loadMathJax() {
    if (window.MathJax && window.MathJax.tex2svg) return Promise.resolve();
    if (mathJaxPromise) return mathJaxPromise;
    window.MathJax = { svg: { fontCache: 'local' }, startup: { typeset: false } };
    mathJaxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mathjax/tex-svg.js';
      s.onload = () => window.MathJax.startup.promise.then(resolve, reject);
      s.onerror = () => { mathJaxPromise = null; reject(new Error('MathJax')); };
      document.head.appendChild(s);
    });
    return mathJaxPromise;
  }
  // Vrátí { svg, w, h } – svg používá currentColor, barvu doplníme při kreslení
  function texToSvg(tex, size) {
    const node = window.MathJax.tex2svg(tex, { display: true });
    const svg = node.querySelector('svg');
    const err = node.querySelector('[data-mjx-error]');
    if (err) throw new Error(err.getAttribute('data-mjx-error') || 'Chyba ve vzorci');
    const ex = size * 0.45;
    const w = parseFloat(svg.getAttribute('width')) * ex;
    const h = parseFloat(svg.getAttribute('height')) * ex;
    svg.removeAttribute('style');
    svg.setAttribute('width', w.toFixed(1) + 'px');
    svg.setAttribute('height', h.toFixed(1) + 'px');
    return { svg: new XMLSerializer().serializeToString(svg), w: round(w), h: round(h) };
  }

  let formulaEditId = null;
  let previewTimer = 0;
  function openFormula(el) {
    if (!guardEdit()) return;
    formulaEditId = el ? el.id : null;
    $('toast').hidden = true;
    $('formulaInput').value = el ? el.tex : '';
    $('formulaOk').textContent = el ? 'Uložit' : 'Vložit';
    $('formulaModal').hidden = false;
    $('formulaPreview').innerHTML = '<span class="muted">Načítám…</span>';
    loadMathJax().then(renderPreview, () => {
      $('formulaPreview').innerHTML = '<span class="error">Knihovnu pro vzorce se nepodařilo načíst.</span>';
    });
    setTimeout(() => $('formulaInput').focus(), 30);
  }
  function closeFormula() {
    $('formulaModal').hidden = true;
    formulaEditId = null;
  }
  function renderPreview() {
    const tex = $('formulaInput').value.trim();
    const box = $('formulaPreview');
    if (!tex) { box.innerHTML = '<span class="muted">Náhled vzorce</span>'; return; }
    if (!window.MathJax || !window.MathJax.tex2svg) return;
    try {
      const r = texToSvg(tex, 26);
      box.innerHTML = r.svg;
    } catch (e) {
      box.innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  }
  (function buildFormulaKeys() {
    const box = $('formulaKeys');
    for (const [label, tex] of FORMULA_KEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fkey';
      b.textContent = label;
      b.title = tex.trim();
      b.onclick = () => {
        const ta = $('formulaInput');
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + tex + ta.value.slice(e);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = s + tex.length;
        renderPreview();
      };
      box.appendChild(b);
    }
  })();
  $('formulaInput').addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 150);
  });
  $('formulaInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('formulaForm').requestSubmit(); }
    if (e.key === 'Escape') closeFormula();
  });
  $('formulaCancel').onclick = closeFormula;
  $('formulaModal').addEventListener('pointerdown', (e) => { if (e.target === $('formulaModal')) closeFormula(); });
  $('formulaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tex = $('formulaInput').value.trim();
    if (!tex) return closeFormula();
    try {
      await loadMathJax();
    } catch (err) {
      return toast('Knihovnu pro vzorce se nepodařilo načíst.');
    }
    const existing = formulaEditId && elements.get(formulaEditId);
    let r;
    try {
      r = texToSvg(tex, currentSize('text') * 1.2);
    } catch (err) {
      $('formulaPreview').innerHTML = `<span class="error">${esc(err.message)}</span>`;
      return;
    }
    if (existing) {
      // zachovat přibližně stejnou výšku písma jako dosud
      const k = existing.texH ? existing.h / existing.texH : 1;
      const before = { tex: existing.tex, svg: existing.svg, w: existing.w, h: existing.h, texH: existing.texH };
      doUpdate(existing.id, { tex, svg: r.svg, w: round(r.w * k), h: round(r.h * k), texH: r.h }, before);
    } else {
      const s = 1 / view.scale;
      const pos = freeSpot(r.w * s, r.h * s);
      const el = { id: uid(), type: 'formula', tex, svg: r.svg, color: state.color, x: pos.x, y: pos.y, w: round(r.w * s), h: round(r.h * s), texH: r.h };
      if (doAdd(el)) {
        setTool('select');
        select(el.id);
      }
    }
    closeFormula();
  });
  $('editSelBtn').onclick = () => {
    const el = selectedId && elements.get(selectedId);
    if (el && el.type === 'formula') openFormula(el);
  };

  /* =========================================================
   *  Export (PNG této strany, PDF všech stran)
   * ======================================================= */
  function waitForImages(els) {
    const waits = [];
    for (const el of els) {
      let img = null;
      if (el.type === 'image') img = getImage(el.src);
      if (el.type === 'formula') { drawFormula(cacheCtx, el); img = el._img; }
      if (img && !(img.complete && img.naturalWidth)) {
        waits.push(new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 4000); }));
      }
    }
    return Promise.all(waits);
  }
  async function renderPage(pageId, maxDim = 2400) {
    const els = [...elements.values()].filter((el) => pageOf(el) === pageId);
    if (!els.some((el) => !(el.type === 'stroke' && el.mode === 'erase'))) return null;
    await waitForImages(els);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const el of els) {
      const b = bounds(el);
      if (el.type === 'stroke' && el.mode === 'erase') continue;
      x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
    }
    const pad = 40;
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    const s = Math.min(2, maxDim / Math.max(x2 - x1, y2 - y1));
    const w = Math.ceil((x2 - x1) * s), h = Math.ceil((y2 - y1) * s);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const o = out.getContext('2d');
    drawPattern(o, w, h, s, -x1 * s, -y1 * s, 12 * Math.max(1, s));
    const ink = document.createElement('canvas');
    ink.width = w; ink.height = h;
    const ic = ink.getContext('2d');
    ic.setTransform(s, 0, 0, s, -x1 * s, -y1 * s);
    for (const el of els) drawElement(ic, el);
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.drawImage(ink, 0, 0);
    return out;
  }
  function fileBase() {
    const t = (meta.title || 'tabule').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'tabule';
    return `${t}-${new Date().toISOString().slice(0, 10)}`;
  }
  async function exportPng() {
    const c = await renderPage(currentPage);
    if (!c) return toast('Tato strana je prázdná.');
    const a = document.createElement('a');
    a.download = `${fileBase()}-strana-${pageIndex() + 1}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  }
  let jsPdfPromise = null;
  function loadJsPdf() {
    if (window.jspdf) return Promise.resolve();
    if (!jsPdfPromise) {
      jsPdfPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/jspdf.js';
        s.onload = resolve;
        s.onerror = () => { jsPdfPromise = null; reject(new Error('jsPDF')); };
        document.head.appendChild(s);
      });
    }
    return jsPdfPromise;
  }
  async function exportPdf() {
    toast('Připravuji PDF…', 8000);
    try {
      await loadJsPdf();
    } catch (e) {
      return toast('Knihovnu pro PDF se nepodařilo načíst.');
    }
    let pdf = null;
    let n = 0;
    for (const p of meta.pages) {
      const c = await renderPage(p.id, 2000);
      if (!c) continue;
      const orientation = c.width >= c.height ? 'landscape' : 'portrait';
      if (!pdf) pdf = new window.jspdf.jsPDF({ orientation, unit: 'pt', format: 'a4' });
      else pdf.addPage('a4', orientation);
      const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      const m = 24;
      const k = Math.min((pw - m * 2) / c.width, (ph - m * 2) / c.height);
      const iw = c.width * k, ih = c.height * k;
      pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
      n++;
      pdf.setFontSize(9);
      pdf.setTextColor(150);
      pdf.text(String(meta.pages.indexOf(p) + 1), pw - m, ph - 10, { align: 'right' });
    }
    if (!pdf) return toast('Tabule je prázdná.');
    pdf.save(`${fileBase()}.pdf`);
    toast(`PDF uloženo (${n} ${n === 1 ? 'strana' : n < 5 ? 'strany' : 'stran'}).`);
  }

  /* =========================================================
   *  Nabídky
   * ======================================================= */
  let openMenuEl = null;
  let openAnchor = null;
  function toggleMenu(menu, anchor, side = 'below') {
    if (openMenuEl === menu) return closeMenu();
    closeMenu();
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left, top;
    if (side === 'right' && window.innerWidth > 760) { left = r.right + 8; top = r.top; }
    else if (r.top > window.innerHeight / 2) { left = r.left; top = r.top - mh - 8; }
    else { left = r.left; top = r.bottom + 8; }
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    openMenuEl = menu;
    openAnchor = anchor;
    anchor.classList.add('open');
  }
  function closeMenu() {
    if (!openMenuEl) return;
    openMenuEl.hidden = true;
    openAnchor && openAnchor.classList.remove('open');
    openMenuEl = openAnchor = null;
  }
  document.addEventListener('pointerdown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target) && !(openAnchor && openAnchor.contains(e.target))) closeMenu();
  });
  window.addEventListener('resize', closeMenu);

  $('bgBtn').onclick = () => toggleMenu($('bgMenu'), $('bgBtn'));
  $('bgMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !guardEdit()) return;
    if (b.dataset.bg) setMeta({ bg: b.dataset.bg });
    if (b.dataset.theme) setMeta({ theme: b.dataset.theme });
  });
  $('exportBtn').onclick = () => toggleMenu($('exportMenu'), $('exportBtn'));
  $('exportMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    if (b.dataset.export === 'png') exportPng();
    else exportPdf();
  });
  $('mathBtn').onclick = () => toggleMenu($('mathMenu'), $('mathBtn'), 'right');
  $('mathMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    const m = b.dataset.math;
    if (m === 'measure' || m === 'angle') {
      setTool(m);
      toast(m === 'measure' ? 'Pravítko: táhněte mezi dvěma body (1 j = 1 čtvereček).' : 'Úhloměr: táhněte od vrcholu k prvnímu rameni.');
    } else if (m === 'axes') insertAxes();
    else if (m === 'formula') openFormula(null);
  });

  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
    } catch (err) {
      prompt('Zkopírujte odkaz:', text);
    }
  }
  const studentLink = () => location.origin + location.pathname;
  async function shareStudent() {
    const url = studentLink();
    if (navigator.share && /Mobi|Android|iPad|iPhone/i.test(navigator.userAgent)) {
      try { await navigator.share({ title: meta.title || 'Online tabule', url }); return; } catch (e) { /* zrušeno */ }
    }
    copyText(url, 'Odkaz zkopírován – pošlete ho studentovi.');
  }
  $('shareBtn').onclick = () => {
    if (isOwner() && ownerKey) toggleMenu($('shareMenu'), $('shareBtn'));
    else shareStudent();
  };
  $('shareMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    if (b.dataset.share === 'student') shareStudent();
    else copyText(studentLink() + '#owner=' + ownerKey, 'Lektorský odkaz zkopírován – neposílejte ho studentům.');
  });

  /* =========================================================
   *  Panel nástrojů
   * ======================================================= */
  function setTool(t) {
    if (!textEditor.hidden) commitText();
    if (current && current._phase) cancelCurrent();
    state.tool = t;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('mathBtn').classList.toggle('active', t === 'measure' || t === 'angle');
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
      b.innerHTML = `<span style="background:${displayColor(c)}"></span>`;
      b.onclick = () => setColor(c);
      box.appendChild(b);
    }
    $('customColorWrap').style.setProperty('--c', displayColor(state.color));
  }
  function setColor(c) {
    state.color = c;
    $('customColor').value = c;
    $('customColorWrap').classList.toggle('active', !COLORS.includes(c));
    renderColors();
    // změna barvy vybraného prvku
    const el = selectedId && elements.get(selectedId);
    if (el && el.type !== 'image' && el.color !== c) doUpdate(el.id, { color: c }, { color: el.color });
    if (['eraser', 'strokeEraser', 'select', 'hand', 'laser'].includes(state.tool)) {
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
    const ids = [...elements.values()].filter(onPage).map((el) => el.id);
    if (!ids.length) return;
    if (!confirm('Opravdu vymazat celou tuto stranu pro všechny? (Lze vrátit tlačítkem Zpět.)')) return;
    const all = ids.map((id) => clone(elements.get(id)));
    for (const id of ids) elements.delete(id);
    select(null);
    send('clear', { page: currentPage });
    pushHistory({ t: 'del', els: all });
    invalidate();
  };
  $('lockBtn').onclick = () => {
    const locked = !meta.locked;
    setMeta({ locked });
    toast(locked ? 'Tabule zamčena – studenti se jen dívají a mohou ukazovat laserem.' : 'Tabule odemčena – studenti mohou kreslit.');
  };
  $('titleBtn').onclick = () => {
    if (!privileged()) return;
    const t = prompt('Název tabule (např. „Petr – rovnice“):', meta.title || '');
    if (t !== null) setMeta({ title: t.trim().slice(0, 80) });
  };

  function duplicateSelected() {
    const el = selectedId && elements.get(selectedId);
    if (!el) return;
    const c = clone(el);
    c.id = uid();
    const off = el.shape === 'axes' ? UNIT : 20 / view.scale;
    Object.assign(c, movedProps(pickProps(c), off, off));
    if (doAdd(c)) select(c.id);
  }

  /* ---------- Klávesnice ---------- */
  const KEYS = { v: 'select', h: 'hand', p: 'pen', m: 'marker', e: 'eraser', x: 'strokeEraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text', k: 'laser' };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (!$('formulaModal').hidden || !$('nameModal').hidden) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); if (!spaceDown) { spaceDown = true; updateCursorStyle(); } return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { doDelete([selectedId]); return; }
    if (e.key === 'Escape') { closeMenu(); if (current) cancelCurrent(); select(null); return; }
    if (e.key === 'PageDown') { e.preventDefault(); $('nextPage').click(); return; }
    if (e.key === 'PageUp') { e.preventDefault(); $('prevPage').click(); return; }
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
  function renderUsers() {
    const box = $('users');
    box.innerHTML = '';
    const list = [...users.values()].sort((a, b) => (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0));
    for (const u of list) {
      const isMe = me && u.id === me.id;
      const chip = document.createElement('div');
      chip.className = 'user-chip' + (isMe ? ' me' : '');
      chip.title = (isMe ? 'To jste vy – kliknutím změníte jméno' : u.name) + (u.isOwner ? ' (lektor)' : '');
      chip.innerHTML = `<span class="avatar" style="background:${esc(u.color)}">${esc(initials(u.name))}</span><span class="uname">${esc(u.name)}${isMe ? ' (vy)' : ''}</span>${u.isOwner ? '<span class="badge">lektor</span>' : ''}`;
      if (isMe) chip.onclick = () => {
        const n = prompt('Vaše jméno:', u.name);
        if (n && n.trim()) { storeName(n.trim()); socket.emit('rename', n.trim()); }
      };
      box.appendChild(chip);
    }
    // kurzory
    for (const el of [...cursorsEl.children]) if (!users.has(el.dataset.id)) el.remove();
    document.body.classList.toggle('privileged', privileged());
    updateFollowUI();
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
    el.hidden = c.page !== currentPage;
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
  updatePager();
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
