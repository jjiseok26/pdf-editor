import {
  state, $, uid, snapshot, toast, currentPage
} from './core.js';

export function ptFrom(e) {
  const r = $('#pageWrap').getBoundingClientRect();
  return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function bboxOf(el) {
  switch (el.type) {
    case 'rect':
    case 'ellipse':
    case 'image':
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case 'text': {
      const lines = el.text.split('\n').length;
      return { x: el.x, y: el.y, w: el.w, h: el.fs * 1.32 * lines + 4 };
    }
    case 'line': {
      const x = Math.min(el.x1, el.x2);
      const y = Math.min(el.y1, el.y2);
      return { x, y, w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
    }
    case 'ink': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < el.pts.length; i += 2) {
        minX = Math.min(minX, el.pts[i]);
        maxX = Math.max(maxX, el.pts[i]);
        minY = Math.min(minY, el.pts[i + 1]);
        maxY = Math.max(maxY, el.pts[i + 1]);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
  return { x: 0, y: 0, w: 10, h: 10 };
}

async function ensureSpans(p) {
  if (p.spansLoaded || !p.docId) return;
  const doc = state.docs.get(p.docId);
  const pg = await doc.pj.getPage(p.idx + 1);
  const tc = await pg.getTextContent();
  const raw = tc.items.filter(it => it.str && it.str.length > 0);
  const lines = [];
  for (const it of raw) {
    const t = it.transform;
    const fs = Math.hypot(t[2], t[3]) || Math.abs(t[0]) || 10;
    const x = t[4];
    const y = t[5];
    let line = null;
    for (const L of lines) {
      if (Math.abs(L.y - y) <= Math.max(L.fs, fs) * 0.35) { line = L; break; }
    }
    if (!line) {
      line = { y, fs, items: [] };
      lines.push(line);
    }
    line.items.push({ x, w: it.width, str: it.str, fs });
    if (fs > line.fs) line.fs = fs;
  }
  lines.sort((a, b) => b.y - a.y);
  const spans = [];
  const fin = c => ({ pieces: c.pieces, fs: c.fs, text: c.text, edited: null });
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const it of L.items) {
      if (!cur) {
        cur = { pieces: [{ x: it.x, y: L.y, w: it.w }], fs: it.fs, text: it.str };
        continue;
      }
      const lp = cur.pieces[cur.pieces.length - 1];
      const gap = it.x - (lp.x + lp.w);
      if (gap <= it.fs * 0.55 && gap >= -it.fs * 1.5) {
        cur.pieces.push({ x: it.x, y: L.y, w: it.w });
        const needSpace = gap > it.fs * 0.2 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
        cur.text += (needSpace ? ' ' : '') + it.str;
        if (it.fs > cur.fs) cur.fs = it.fs;
      } else {
        spans.push(fin(cur));
        cur = { pieces: [{ x: it.x, y: L.y, w: it.w }], fs: it.fs, text: it.str };
      }
    }
    if (cur) spans.push(fin(cur));
  }
  p.spans = spans;
  p.spansLoaded = true;
}

async function buildText(p) {
  const L = $('#textLayer');
  L.innerHTML = '';
  $('#noTextChip').hidden = true;
  if (!p) return;
  try { await ensureSpans(p); } catch (err) { console.warn('텍스트 추출 실패:', err); }
  if (currentPage() !== p) return;
  const interactive = state.textMode && state.tool === 'select';
  L.classList.toggle('inactive', !interactive);
  const hasText = !!(p.docId && p.spans && p.spans.length);
  if (state.textMode && p.docId && !hasText) $('#noTextChip').hidden = false;
  if (!hasText) return;
  for (const s of p.spans) {
    const d = document.createElement('div');
    d.className = 'tl-span' + (s.edited !== null ? ' changed' : '');
    d.textContent = s.edited === null ? s.text : s.edited;
    const first = s.pieces[0];
    d.style.left = first.x * state.scale + 'px';
    d.style.top = (p.h - first.y - s.fs * 0.87) * state.scale + 'px';
    d.style.fontSize = s.fs * state.scale + 'px';
    d.style.minHeight = s.fs * 1.05 * state.scale + 'px';
    d.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (!(state.textMode && state.tool === 'select')) return;
      startSpanEdit(d, s, p);
    });
    d.addEventListener('pointerdown', e => {
      if (d.isContentEditable) e.stopPropagation();
    });
    L.appendChild(d);
  }
}

function startSpanEdit(div, s, p) {
  div.classList.add('editing');
  div.contentEditable = 'true';
  div.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(div);
  sel.removeAllRanges();
  sel.addRange(range);
  const keyH = e => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      div.blur();
    }
  };
  const done = () => {
    div.removeEventListener('blur', done);
    div.removeEventListener('keydown', keyH);
    div.contentEditable = 'false';
    div.classList.remove('editing');
    const val = div.innerText.replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' ').trim();
    if (val !== (s.edited === null ? s.text : s.edited)) {
      snapshot();
      s.edited = val === s.text ? null : val;
    }
    buildText(currentPage());
  };
  div.addEventListener('blur', done);
  div.addEventListener('keydown', keyH);
}

export function cursorForTool(t = state.tool) {
  switch (t) {
    case 'select': return 'default';
    case 'eraser': return 'pointer';
    default: return 'crosshair';
  }
}

export function updateLayersMode() {
  const tl = $('#textLayer');
  const al = $('#annoLayer');
  const textInteractive = state.textMode && state.tool === 'select';
  tl.classList.toggle('inactive', !textInteractive);
  al.style.pointerEvents = textInteractive ? 'none' : 'auto';
  al.style.cursor = cursorForTool();
}

function elBodyHTML(el) {
  const sc = state.scale;
  switch (el.type) {
    case 'text':
      return `<div class="ael-txt" style="font-size:${el.fs * sc}px;color:${el.color};">${esc(el.text)}</div>`;
    case 'image':
      return `<img draggable="false" src="${el.src}">`;
    case 'rect':
      return `<div style="width:100%;height:100%;box-sizing:border-box;border:${el.sw * sc}px solid ${el.color};${el.fill ? 'background:' + el.fill + ';' : ''}"></div>`;
    case 'ellipse':
      return `<div style="width:100%;height:100%;box-sizing:border-box;border-radius:50%;border:${el.sw * sc}px solid ${el.color};${el.fill ? 'background:' + el.fill + ';' : ''}"></div>`;
    case 'line': {
      const b = bboxOf(el);
      const vbW = Math.max(b.w, 0.01), vbH = Math.max(b.h, 0.01);
      return `<svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none"><line x1="${el.x1 - b.x}" y1="${el.y1 - b.y}" x2="${el.x2 - b.x}" y2="${el.y2 - b.y}" stroke="${el.color}" stroke-width="${el.sw}" stroke-linecap="round" opacity="${el.alpha ?? 1}"/></svg>`;
    }
    case 'ink':
    case 'hl': {
      const b = bboxOf(el);
      const vbW = Math.max(b.w, 0.01), vbH = Math.max(b.h, 0.01);
      const pts = [];
      for (let i = 0; i < el.pts.length; i += 2) pts.push((el.pts[i] - b.x) + ',' + (el.pts[i + 1] - b.y));
      const isHl = el.type === 'hl';
      return `<svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none"><polyline points="${pts.join(' ')}" fill="none" stroke="${el.color}" stroke-width="${isHl ? el.sw * 2.4 : el.sw}" stroke-linecap="${isHl ? 'butt' : 'round'}" stroke-linejoin="round" opacity="${isHl ? 0.38 : (el.alpha ?? 1)}"/></svg>`;
    }
  }
  return '';
}

function positionNode(w, el) {
  const b = bboxOf(el);
  w.style.left = b.x * state.scale + 'px';
  w.style.top = b.y * state.scale + 'px';
  w.style.width = Math.max(b.w, 3) * state.scale + 'px';
  if (el.type === 'text') {
    w.style.height = 'auto';
  } else {
    w.style.height = Math.max(b.h, 3) * state.scale + 'px';
  }
}

function resizableDirs(el) {
  if (el.type === 'text') return ['se'];
  if (el.type === 'ink' || el.type === 'hl' || el.type === 'line') return ['nw', 'ne', 'sw', 'se'];
  return ['nw', 'ne', 'sw', 'se'];
}

function nodeFor(el, p) {
  const w = document.createElement('div');
  w.className = 'ael' + (state.selected === el.id ? ' sel' : '');
  w.dataset.id = el.id;
  const body = document.createElement('div');
  body.style.cssText = 'position:absolute;inset:0;';
  body.innerHTML = elBodyHTML(el);
  w.appendChild(body);
  positionNode(w, el);
  if (state.selected === el.id) {
    for (const dir of resizableDirs(el)) {
      const h = document.createElement('div');
      h.className = 'hd ' + dir;
      h.addEventListener('pointerdown', ev => {
        if (state.tool !== 'select' || state.editing) return;
        ev.stopPropagation();
        ev.preventDefault();
        startResize(ev, el, dir);
      });
      w.appendChild(h);
    }
  }
  w.addEventListener('pointerdown', ev => onElPointerDown(ev, el, p));
  if (el.type === 'text') {
    w.addEventListener('dblclick', ev => {
      ev.stopPropagation();
      if (state.tool !== 'select' || state.editing) return;
      startElTextEdit(el, p);
    });
  }
  return w;
}

function nodeById(id) {
  return $('#annoLayer').querySelector(`[data-id="${id}"]`);
}

function onElPointerDown(ev, el, p) {
  if (ev.button !== 0 || state.editing) return;
  if (ev.target.classList.contains('hd')) return;
  if (state.tool === 'eraser') {
    ev.stopPropagation();
    snapshot();
    p.els = p.els.filter(x => x.id !== el.id);
    if (state.selected === el.id) state.selected = null;
    buildAnnos(p);
    return;
  }
  if (state.tool !== 'select') return;
  ev.stopPropagation();
  if (state.selected !== el.id) {
    state.selected = el.id;
    buildAnnos(p);
  }
  startDrag(ev, el, p);
}

function applyMove(el, o, dx, dy) {
  if (el.type === 'line') {
    el.x1 = o.x1 + dx; el.y1 = o.y1 + dy;
    el.x2 = o.x2 + dx; el.y2 = o.y2 + dy;
  } else if (el.type === 'ink' || el.type === 'hl') {
    for (let i = 0; i < el.pts.length; i += 2) {
      el.pts[i] = o.pts[i] + dx;
      el.pts[i + 1] = o.pts[i + 1] + dy;
    }
  } else {
    el.x = o.x + dx;
    el.y = o.y + dy;
  }
}

function startDrag(ev, el, p) {
  const start = ptFrom(ev);
  const orig = JSON.stringify(el);
  let snapDone = false;
  const move = e2 => {
    e2.preventDefault();
    const pt = ptFrom(e2);
    if (!snapDone) { snapshot(); snapDone = true; }
    applyMove(el, JSON.parse(orig), pt.x - start.x, pt.y - start.y);
    const old = nodeById(el.id);
    if (old) old.replaceWith(nodeFor(el, p));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function applyResize(el, ob, nb) {
  const rx = v => ob.w < 1 ? nb.x : nb.x + (v - ob.x) / ob.w * nb.w;
  const ry = v => ob.h < 1 ? nb.y : nb.y + (v - ob.y) / ob.h * nb.h;
  if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'image') {
    el.x = nb.x; el.y = nb.y; el.w = nb.w; el.h = nb.h;
  } else if (el.type === 'line') {
    el.x1 = rx(ob.x1); el.y1 = ry(ob.y1);
    el.x2 = rx(ob.x2); el.y2 = ry(ob.y2);
  } else if (el.type === 'ink' || el.type === 'hl') {
    const out = new Array(el.pts.length);
    for (let i = 0; i < el.pts.length; i += 2) {
      out[i] = rx(el.pts[i]);
      out[i + 1] = ry(el.pts[i + 1]);
    }
    el.pts = out;
  }
}

function startResize(ev, el, dir) {
  const start = ptFrom(ev);
  const orig = JSON.parse(JSON.stringify(el));
  const ob = bboxOf(orig);
  let snapDone = false;
  const move = e2 => {
    e2.preventDefault();
    const pt = ptFrom(e2);
    if (!snapDone) { snapshot(); snapDone = true; }
    const dx = pt.x - start.x;
    const dy = pt.y - start.y;
    let nx = ob.x, ny = ob.y, nw = ob.w, nh = ob.h;
    if (dir.includes('w')) { nx = ob.x + dx; nw = ob.w - dx; }
    if (dir.includes('e')) { nw = ob.w + dx; }
    if (dir.includes('n')) { ny = ob.y + dy; nh = ob.h - dy; }
    if (dir.includes('s')) { nh = ob.h + dy; }
    if (el.type === 'text') {
      el.w = Math.max(nw, 24);
      el.x = dir.includes('w') ? nx + (ob.w - el.w) : ob.x;
    } else {
      if (nw < 6) { if (dir.includes('w')) nx = ob.x + ob.w - 6; nw = 6; }
      if (nh < 6) { if (dir.includes('n')) ny = ob.y + ob.h - 6; nh = 6; }
      applyResize(el, ob, { x: nx, y: ny, w: nw, h: nh });
    }
    const old = nodeById(el.id);
    if (old) old.replaceWith(nodeFor(el, currentPage()));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startElTextEdit(el, p) {
  const w = nodeById(el.id);
  if (!w) return;
  const t = w.querySelector('.ael-txt');
  if (!t) return;
  state.editing = true;
  t.contentEditable = 'true';
  t.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(t);
  sel.removeAllRanges();
  sel.addRange(range);
  const keyH = e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
  };
  const done = () => {
    t.removeEventListener('blur', done);
    t.removeEventListener('keydown', keyH);
    t.contentEditable = 'false';
    state.editing = false;
    const v = t.innerText.replace(/\u00a0/g, ' ').replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
    if (v !== el.text) {
      snapshot();
      el.text = v === '' ? ' ' : v;
    }
    buildAnnos(currentPage());
  };
  t.addEventListener('blur', done);
  t.addEventListener('keydown', keyH);
}

export function buildAnnos(p) {
  const L = $('#annoLayer');
  L.innerHTML = '';
  if (!p) return;
  updateLayersMode();
  for (const el of p.els) L.appendChild(nodeFor(el, p));
}

function draftEl(t, s, e, pts) {
  switch (t) {
    case 'rect':
    case 'ellipse':
      return {
        id: '', type: t,
        x: Math.min(s.x, e.x), y: Math.min(s.y, e.y),
        w: Math.abs(e.x - s.x), h: Math.abs(e.y - s.y),
        sw: state.opts.strokeW, color: state.opts.color,
        fill: state.opts.fillOn ? withAlphaLocal(state.opts.color, 0.25) : ''
      };
    case 'line':
      return { id: '', type: 'line', x1: s.x, y1: s.y, x2: e.x, y2: e.y, sw: state.opts.strokeW, color: state.opts.color };
    case 'pen':
      return { id: '', type: 'pen', pts: pts.slice(), sw: state.opts.strokeW, color: state.opts.color };
    case 'hl':
      return { id: '', type: 'hl', pts: pts.slice(), sw: state.opts.hlW, color: state.opts.hlColor };
  }
  return null;
}

function withAlphaLocal(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function beginCreate(ev, t, p) {
  const start = ptFrom(ev);
  const pts = [start.x, start.y];
  const ghost = document.createElement('div');
  ghost.className = 'ael';
  $('#annoLayer').appendChild(ghost);
  const drawGhost = e2 => {
    const pt = ptFrom(e2);
    pts.push(pt.x, pt.y);
    const d = draftEl(t, start, pt, pts);
    if (!d) return;
    const b = bboxOf(d);
    ghost.style.left = b.x * state.scale + 'px';
    ghost.style.top = b.y * state.scale + 'px';
    ghost.style.width = Math.max(b.w, 3) * state.scale + 'px';
    ghost.style.height = Math.max(b.h, 3) * state.scale + 'px';
    ghost.innerHTML = elBodyHTML({ ...d, id: 'ghost' });
  };
  const finish = e2 => {
    window.removeEventListener('pointermove', drawGhost);
    window.removeEventListener('pointerup', finish);
    ghost.remove();
    const pt = ptFrom(e2);
    pts.push(pt.x, pt.y);
    const d = draftEl(t, start, pt, pts);
    if (!d) return;
    const b = bboxOf(d);
    if ((t === 'rect' || t === 'ellipse') && (b.w < 4 && b.h < 4)) {
      toast('너무 작습니다. 원하는 크기로 드래그하세요.');
      return;
    }
    if (t === 'line' && b.w < 3 && b.h < 3) return;
    if ((t === 'pen' || t === 'hl') && pts.length < 6) return;
    snapshot();
    d.id = uid();
    p.els.push(d);
    state.selected = d.id;
    buildAnnos(p);
  };
  window.addEventListener('pointermove', drawGhost);
  window.addEventListener('pointerup', finish);
}

export function initAnnotate() {
  const L = $('#annoLayer');
  L.addEventListener('pointerdown', ev => {
    const p = currentPage();
    if (!p || ev.button !== 0 || state.editing) return;
    if (ev.target.closest('.ael')) return;
    const t = state.tool;
    if (t === 'select' || t === 'eraser') {
      if (state.selected) {
        state.selected = null;
        buildAnnos(p);
      }
      return;
    }
    if (t === 'text') {
      ev.preventDefault();
      const pt = ptFrom(ev);
      snapshot();
      const el = {
        id: uid(), type: 'text',
        x: pt.x, y: Math.max(2, pt.y - state.opts.fontSize * 0.75),
        w: 220, text: '텍스트 입력',
        fs: state.opts.fontSize, color: '#111111'
      };
      p.els.push(el);
      state.selected = el.id;
      buildAnnos(p);
      startElTextEdit(el, p);
      return;
    }
    if (['rect', 'ellipse', 'line', 'pen', 'hl'].includes(t)) beginCreate(ev, t, p);
  });
}

export function deleteSelected() {
  const p = currentPage();
  if (!p || !state.selected) return false;
  const idx = p.els.findIndex(x => x.id === state.selected);
  if (idx < 0) return false;
  snapshot();
  p.els.splice(idx, 1);
  state.selected = null;
  buildAnnos(p);
  return true;
}

export function applyPropsToSelected(props) {
  const p = currentPage();
  if (!p || !state.selected) return;
  const el = p.els.find(x => x.id === state.selected);
  if (!el) return;
  snapshot();
  if (props.color) {
    if (el.type === 'hl') el.color = props.color;
    else el.color = props.color;
  }
  if (props.strokeW !== undefined && ['rect', 'ellipse', 'line', 'pen'].includes(el.type)) el.sw = props.strokeW;
  if (props.fontSize !== undefined && el.type === 'text') el.fs = props.fontSize;
  if (props.fillOn !== undefined && ['rect', 'ellipse'].includes(el.type)) {
    el.fill = props.fillOn ? withAlphaLocal(props.color || el.color || '#888888', 0.25) : '';
  }
  buildAnnos(p);
}

export function placeImage(src, natW, natH, maxWpt = 280) {
  const p = currentPage();
  if (!p) { toast('먼저 문서를 여세요.'); return; }
  snapshot();
  const ratio = natH / Math.max(natW, 1);
  let w = Math.min(maxWpt, p.w * 0.6);
  let h = w * ratio;
  if (h > p.h * 0.7) { h = p.h * 0.7; w = h / ratio; }
  const el = { id: uid(), type: 'image', src, x: (p.w - w) / 2, y: (p.h - h) / 2, w, h };
  p.els.push(el);
  state.selected = el.id;
  buildAnnos(p);
}

export async function decorate(p) {
  await buildText(p);
  if (currentPage() !== p) return;
  buildAnnos(p);
}

let sigCtx = null;
let sigDrawing = false;
let sigHasInk = false;

function trimCanvas(cv) {
  const ctx = cv.getContext('2d');
  const { width, height } = cv;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(cv, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function openSig() {
  const modal = $('#sigModal');
  modal.hidden = false;
  sigHasInk = false;
  requestAnimationFrame(() => {
    const cv = $('#sigPad');
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    sigCtx = cv.getContext('2d');
    sigCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sigCtx.lineWidth = 2.8;
    sigCtx.lineCap = 'round';
    sigCtx.lineJoin = 'round';
    sigCtx.strokeStyle = '#101418';
  });
}

function closeSig() {
  $('#sigModal').hidden = true;
}

function sigPos(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function initSignature() {
  const cv = $('#sigPad');
  $('#btnSig').addEventListener('click', () => {
    if (!currentPage()) { toast('먼저 문서를 여세요.'); return; }
    openSig();
  });
  $('#sigCancel').addEventListener('click', closeSig);
  $('#sigClear').addEventListener('click', () => {
    if (!sigCtx) return;
    sigCtx.save();
    sigCtx.setTransform(1, 0, 0, 1, 0, 0);
    sigCtx.clearRect(0, 0, cv.width, cv.height);
    sigCtx.restore();
    sigHasInk = false;
  });
  $('#sigOk').addEventListener('click', () => {
    if (!sigHasInk) { toast('서명을 먼저 그려주세요.'); return; }
    const trimmed = trimCanvas(cv);
    if (!trimmed) { closeSig(); return; }
    placeImage(trimmed.toDataURL('image/png'), trimmed.width, trimmed.height, 170);
    closeSig();
  });
  $('#sigModal').addEventListener('pointerdown', e => {
    if (e.target === $('#sigModal')) closeSig();
  });
  cv.addEventListener('pointerdown', e => {
    if (!sigCtx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    sigDrawing = true;
    sigHasInk = true;
    const pos = sigPos(e);
    sigCtx.beginPath();
    sigCtx.moveTo(pos.x, pos.y);
    sigCtx.lineTo(pos.x + 0.01, pos.y + 0.01);
    sigCtx.stroke();
  });
  cv.addEventListener('pointermove', e => {
    if (!sigDrawing || !sigCtx) return;
    const pos = sigPos(e);
    sigCtx.lineTo(pos.x, pos.y);
    sigCtx.stroke();
  });
  const end = () => { sigDrawing = false; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}
