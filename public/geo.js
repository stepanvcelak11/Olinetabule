/* Geometrické útvary a tělesa pro tabuli.
 * Model se počítá ve světových souřadnicích tabule; 1 jednotka rozměru = 1 čtvereček mřížky.
 * Tělesa se kreslí ve volném rovnoběžném promítání (hloubka pod 45°, zkrácená na polovinu),
 * neviditelné hrany čárkovaně – stejně jako ve školních učebnicích.
 */
(function () {
  'use strict';

  const K = 0.5 * Math.SQRT1_2; // posun hloubky (cos 45° · 1/2)
  const ELL = 0.35; // zploštění podstav rotačních těles

  const KINDS = {
    square: { name: 'Čtverec', group: '2d', d: { a: 4 } },
    rect: { name: 'Obdélník', group: '2d', d: { a: 5, b: 3 } },
    triangle: { name: 'Trojúhelník', group: '2d', d: { a: 5, v: 3, p: 2 } },
    rtriangle: { name: 'Pravoúhlý trojúhelník', group: '2d', d: { a: 4, b: 3 } },
    parallelogram: { name: 'Rovnoběžník', group: '2d', d: { a: 5, v: 3, p: 1.5 } },
    trapezoid: { name: 'Lichoběžník', group: '2d', d: { a: 6, c: 3, v: 3 } },
    polygon: { name: 'Pravidelný n-úhelník', group: '2d', d: { n: 6, a: 2 } },
    circle: { name: 'Kruh', group: '2d', d: { r: 2.5 } },
    cube: { name: 'Krychle', group: '3d', d: { a: 3 } },
    cuboid: { name: 'Kvádr', group: '3d', d: { a: 5, b: 3, c: 3 } },
    prism: { name: 'Trojboký hranol', group: '3d', d: { a: 4, v: 4 } },
    pyramid: { name: 'Jehlan', group: '3d', d: { a: 4, v: 5 } },
    cone: { name: 'Kužel', group: '3d', d: { r: 2, v: 5 } },
    cylinder: { name: 'Válec', group: '3d', d: { r: 2, v: 4 } },
    sphere: { name: 'Koule', group: '3d', d: { r: 2.5 } },
  };

  // Popisky polí v panelu rozměrů
  const DIM_INFO = {
    a: { label: 'a', title: 'strana / délka a' },
    b: { label: 'b', title: 'strana b' },
    c: { label: 'c', title: 'strana / výška c' },
    v: { label: 'v', title: 'výška v' },
    r: { label: 'r', title: 'poloměr r' },
    p: { label: 'posun', title: 'vodorovný posun horního vrcholu', min: -50, step: 0.5 },
    n: { label: 'n', title: 'počet stran', min: 3, max: 12, step: 1 },
  };

  function dims(el) {
    return { ...KINDS[el.kind].d, ...(el.d || {}) };
  }

  /* ---------- Model: čáry, elipsy, popisky ---------- */
  function model(el, U) {
    const d = dims(el);
    const ox = el.x, oy = el.y;
    const P = (x, y, z = 0) => ({ x: ox + (x + z * K) * U, y: oy - (y + z * K) * U });
    const m = { lines: [], aux: [], ell: [], verts: [], dims: [], poly: null, marks: [], pts: [] };
    const L = (p, q, dash = false) => { m.lines.push({ p, q, dash }); m.pts.push(p, q); };
    const A = (p, q) => m.aux.push({ p, q }); // pomocné čáry (výška, poloměr) – jen s popisky
    const V = (name, p) => m.verts.push({ name, p });
    const D = (key, p, q, off, val) => m.dims.push({ key, p, q, off, val: val != null ? val : d[key] });
    const E = (cx, cy, rx, ry, part, dash = false) => {
      m.ell.push({ cx, cy, rx, ry, part, dash });
      m.pts.push({ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry });
    };
    const poly = (ps) => { for (let i = 0; i < ps.length; i++) L(ps[i], ps[(i + 1) % ps.length]); m.poly = ps; };
    const names = (ns, ps) => ns.forEach((n, i) => V(n, ps[i]));

    switch (el.kind) {
      case 'square':
      case 'rect': {
        const a = d.a, b = el.kind === 'square' ? d.a : d.b;
        const ps = [P(0, 0), P(a, 0), P(a, b), P(0, b)];
        poly(ps); names(['A', 'B', 'C', 'D'], ps);
        D('a', ps[0], ps[1]);
        if (el.kind === 'rect') D('b', ps[1], ps[2]);
        m.marks.push({ p: ps[0], u: { x: 1, y: 0 }, w: { x: 0, y: -1 } });
        break;
      }
      case 'triangle': {
        const ps = [P(0, 0), P(d.a, 0), P(d.p, d.v)];
        poly(ps); names(['A', 'B', 'C'], ps);
        const f = P(d.p, 0);
        A(ps[2], f);
        if (d.p < 0) A(f, ps[0]);
        if (d.p > d.a) A(ps[1], f);
        D('a', ps[0], ps[1]);
        D('v', ps[2], f, { x: 16, y: 0 });
        break;
      }
      case 'rtriangle': {
        // pravý úhel u C, odvěsny a (CB) a b (CA), přepona c
        const C = P(0, 0), B = P(d.a, 0), Aa = P(0, d.b);
        poly([Aa, B, C]); names(['A', 'B', 'C'], [Aa, B, C]);
        D('a', C, B); D('b', C, Aa); D('c', Aa, B, undefined, Math.hypot(d.a, d.b));
        m.marks.push({ p: C, u: { x: 1, y: 0 }, w: { x: 0, y: -1 } });
        break;
      }
      case 'parallelogram': {
        const ps = [P(0, 0), P(d.a, 0), P(d.a + d.p, d.v), P(d.p, d.v)];
        poly(ps); names(['A', 'B', 'C', 'D'], ps);
        const f = P(d.p, 0);
        A(ps[3], f);
        D('a', ps[0], ps[1]);
        D('v', ps[3], f, { x: 16, y: 0 });
        break;
      }
      case 'trapezoid': {
        const o = (d.a - d.c) / 2;
        const ps = [P(0, 0), P(d.a, 0), P(o + d.c, d.v), P(o, d.v)];
        poly(ps); names(['A', 'B', 'C', 'D'], ps);
        const f = P(o, 0);
        A(ps[3], f);
        D('a', ps[0], ps[1]); D('c', ps[2], ps[3]);
        D('v', ps[3], f, { x: 16, y: 0 });
        break;
      }
      case 'polygon': {
        const n = Math.max(3, Math.min(12, Math.round(d.n)));
        const R = d.a / (2 * Math.sin(Math.PI / n));
        const cy = R * Math.cos(Math.PI / n);
        const ps = [];
        for (let k = 0; k < n; k++) {
          const t = -Math.PI / 2 - Math.PI / n + (2 * Math.PI * k) / n;
          ps.push(P(R + R * Math.cos(t), cy + R * Math.sin(t)));
        }
        poly(ps);
        names(ps.map((_, i) => String.fromCharCode(65 + i)), ps);
        const S = P(R, cy);
        A(S, ps[0]);
        V('S', S);
        D('a', ps[0], ps[1]);
        break;
      }
      case 'circle': {
        const c = P(d.r, d.r), rx = d.r * U;
        E(c.x, c.y, rx, rx, 'full');
        const q = { x: c.x + rx, y: c.y };
        A(c, q);
        V('S', c);
        D('r', c, q, { x: 0, y: -14 });
        m.poly = null;
        m.circle = { cx: c.x, cy: c.y, r: rx };
        break;
      }
      case 'cube':
      case 'cuboid': {
        const a = d.a, b = el.kind === 'cube' ? d.a : d.b, c = el.kind === 'cube' ? d.a : d.c;
        const p = [P(0, 0, 0), P(a, 0, 0), P(a, 0, b), P(0, 0, b), P(0, c, 0), P(a, c, 0), P(a, c, b), P(0, c, b)];
        const [Aa, B, C, Dd, Ee, F, G, Hh] = p;
        L(Aa, B); L(B, F); L(F, Ee); L(Ee, Aa); // přední stěna
        L(F, G); L(G, Hh); L(Hh, Ee); // horní
        L(B, C); L(C, G); // pravá
        L(Aa, Dd, true); L(Dd, C, true); L(Dd, Hh, true); // neviditelné
        names(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], p);
        D('a', Aa, B);
        if (el.kind === 'cuboid') { D('b', B, C); D('c', C, G); }
        break;
      }
      case 'prism': {
        const a = d.a, h = a * Math.sqrt(3) / 2;
        const p = [P(0, 0, 0), P(a, 0, 0), P(a / 2, 0, h), P(0, d.v, 0), P(a, d.v, 0), P(a / 2, d.v, h)];
        const [Aa, B, C, A2, B2, C2] = p;
        L(Aa, B); L(Aa, A2); L(B, B2); L(A2, B2); L(B2, C2); L(C2, A2);
        L(Aa, C, true); L(B, C, true); L(C, C2, true);
        names(['A', 'B', 'C', 'A′', 'B′', 'C′'], p);
        D('a', Aa, B); D('v', B, B2);
        break;
      }
      case 'pyramid': {
        const a = d.a;
        const p = [P(0, 0, 0), P(a, 0, 0), P(a, 0, a), P(0, 0, a), P(a / 2, d.v, a / 2)];
        const [Aa, B, C, Dd, Vv] = p;
        L(Aa, B); L(B, C); L(Aa, Vv); L(B, Vv); L(C, Vv);
        L(C, Dd, true); L(Dd, Aa, true); L(Dd, Vv, true);
        const S = P(a / 2, 0, a / 2);
        A(S, Vv);
        names(['A', 'B', 'C', 'D', 'V'], p);
        V('S', S);
        D('a', Aa, B); D('v', S, Vv, { x: 14, y: 0 });
        break;
      }
      case 'cone':
      case 'cylinder': {
        const r = d.r * U, ry = r * ELL;
        const c = P(d.r, 0), t = P(d.r, d.v);
        E(c.x, c.y, r, ry, 'front');
        E(c.x, c.y, r, ry, 'back', true);
        if (el.kind === 'cone') {
          L({ x: c.x - r, y: c.y }, t); L({ x: c.x + r, y: c.y }, t);
          V('V', t);
        } else {
          E(t.x, t.y, r, ry, 'full');
          L({ x: c.x - r, y: c.y }, { x: t.x - r, y: t.y }); L({ x: c.x + r, y: c.y }, { x: t.x + r, y: t.y });
          V('S′', t);
        }
        A(c, t);
        const q = { x: c.x + r, y: c.y };
        A(c, q);
        V('S', c);
        D('r', c, q, { x: 0, y: 14 });
        D('v', c, t, { x: 14, y: 0 });
        m.pts.push(t);
        break;
      }
      case 'sphere': {
        const r = d.r * U;
        const c = P(d.r, d.r);
        E(c.x, c.y, r, r, 'full');
        E(c.x, c.y, r, r * ELL, 'front');
        E(c.x, c.y, r, r * ELL, 'back', true);
        const q = { x: c.x + r, y: c.y };
        A(c, q);
        V('S', c);
        D('r', c, q, { x: 0, y: -14 });
        break;
      }
    }
    // těžiště pro umístění popisků směrem ven
    let sx = 0, sy = 0;
    for (const p of m.pts) { sx += p.x; sy += p.y; }
    m.center = { x: sx / (m.pts.length || 1), y: sy / (m.pts.length || 1) };
    return m;
  }

  /* ---------- Výpočty (obvod/obsah, objem/povrch) ---------- */
  function compute(el) {
    const d = dims(el);
    const PI = Math.PI;
    const r = [];
    const exact = (x) => Math.abs(x - Math.round(x * 100) / 100) < 1e-9;
    const add = (sym, val, pow) => r.push({ sym, val, pow, approx: !exact(val) });
    switch (el.kind) {
      case 'square': add('o', 4 * d.a, 1); add('S', d.a * d.a, 2); break;
      case 'rect': add('o', 2 * (d.a + d.b), 1); add('S', d.a * d.b, 2); break;
      case 'triangle': {
        const b = Math.hypot(d.a - d.p, d.v), c = Math.hypot(d.p, d.v);
        add('o', d.a + b + c, 1); add('S', (d.a * d.v) / 2, 2); break;
      }
      case 'rtriangle': {
        const c = Math.hypot(d.a, d.b);
        add('c', c, 1); add('o', d.a + d.b + c, 1); add('S', (d.a * d.b) / 2, 2); break;
      }
      case 'parallelogram': add('o', 2 * (d.a + Math.hypot(d.p, d.v)), 1); add('S', d.a * d.v, 2); break;
      case 'trapezoid': {
        const s = Math.hypot((d.a - d.c) / 2, d.v);
        add('o', d.a + d.c + 2 * s, 1); add('S', ((d.a + d.c) * d.v) / 2, 2); break;
      }
      case 'polygon': {
        const n = Math.max(3, Math.min(12, Math.round(d.n)));
        add('o', n * d.a, 1); add('S', (n * d.a * d.a) / (4 * Math.tan(PI / n)), 2); break;
      }
      case 'circle': add('o', 2 * PI * d.r, 1); add('S', PI * d.r * d.r, 2); break;
      case 'cube': add('V', d.a ** 3, 3); add('S', 6 * d.a * d.a, 2); break;
      case 'cuboid': add('V', d.a * d.b * d.c, 3); add('S', 2 * (d.a * d.b + d.b * d.c + d.a * d.c), 2); break;
      case 'prism': {
        const base = (Math.sqrt(3) / 4) * d.a * d.a;
        add('V', base * d.v, 3); add('S', 2 * base + 3 * d.a * d.v, 2); break;
      }
      case 'pyramid': {
        const w = Math.hypot(d.v, d.a / 2);
        add('V', (d.a * d.a * d.v) / 3, 3); add('S', d.a * d.a + 2 * d.a * w, 2); break;
      }
      case 'cone': {
        const s = Math.hypot(d.r, d.v);
        add('V', (PI * d.r * d.r * d.v) / 3, 3); add('S', PI * d.r * (d.r + s), 2); break;
      }
      case 'cylinder': add('V', PI * d.r * d.r * d.v, 3); add('S', 2 * PI * d.r * (d.r + d.v), 2); break;
      case 'sphere': add('V', (4 / 3) * PI * d.r ** 3, 3); add('S', 4 * PI * d.r * d.r, 2); break;
    }
    return r;
  }

  window.Geo = { KINDS, DIM_INFO, dims, model, compute };
})();
