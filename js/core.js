export const A4 = { w: 595.28, h: 841.89 };

export const state = {
  docs: new Map(),
  pages: [],
  cur: -1,
  scale: 1.3,
  tool: 'select',
  opts: { color: '#2563eb', fillOn: false, strokeW: 2, fontSize: 16, hlColor: '#ffe94a', hlW: 12 },
  selected: null,
  textMode: false,
  editing: false,
  dirty: false
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function fire(evt, ...args) {
  const set = listeners.get(evt);
  if (set) for (const fn of set) fn(...args);
}

let undoStack = [];
let redoStack = [];

export function snapshot() {
  undoStack.push(JSON.stringify(state.pages));
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
  state.dirty = true;
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state.pages));
  state.pages = JSON.parse(undoStack.pop());
  state.selected = null;
  state.cur = Math.min(Math.max(state.cur, 0), state.pages.length - 1);
  fire('change');
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state.pages));
  state.pages = JSON.parse(redoStack.pop());
  state.selected = null;
  state.cur = Math.min(Math.max(state.cur, 0), state.pages.length - 1);
  fire('change');
}

export function resetHistory() {
  undoStack = [];
  redoStack = [];
}

export const canUndoCount = () => undoStack.length;
export const canRedoCount = () => redoStack.length;

export function currentPage() {
  return state.pages[state.cur] || null;
}

export const $ = (sel, root = document) => root.querySelector(sel);

let uidN = 0;
export const uid = () => `el-${Date.now().toString(36)}-${(uidN++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

export function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function withAlpha(hex, a) {
  const { r, g, b } = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastTimer = null;
export function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function makeBlankPage(afterIndex) {
  return {
    id: uid(),
    docId: null,
    idx: -1,
    w: A4.w,
    h: A4.h,
    els: [],
    spans: [],
    spansLoaded: false,
    _thumb: null
  };
}

export async function parsePdfFile(bytes) {
  const pj = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const docId = uid();
  const entry = { bytes, pj, name: '' };
  const pages = [];
  for (let i = 0; i < pj.numPages; i++) {
    const pg = await pj.getPage(i + 1);
    const vp = pg.getViewport({ scale: 1 });
    pages.push({
      id: uid(),
      docId,
      idx: i,
      w: vp.width,
      h: vp.height,
      els: [],
      spans: [],
      spansLoaded: false,
      _thumb: null
    });
  }
  return { docId, entry, pages };
}

export function resetAll(pages) {
  state.docs.clear();
  state.pages = pages || [];
  state.cur = pages && pages.length ? 0 : -1;
  state.selected = null;
  state.dirty = false;
  resetHistory();
  fire('change');
}

export function addPages(newPages, afterIndex) {
  snapshot();
  const at = (afterIndex === undefined || afterIndex === null)
    ? state.pages.length
    : afterIndex + 1;
  state.pages.splice(at, 0, ...newPages);
  state.cur = at;
  fire('change');
}

export function deletePage(i) {
  if (state.pages.length <= 1) {
    toast('마지막 한 페이지는 삭제할 수 없습니다.');
    return;
  }
  snapshot();
  state.pages.splice(i, 1);
  if (state.cur >= state.pages.length) state.cur = state.pages.length - 1;
  fire('change');
}

export function duplicatePage(i) {
  snapshot();
  const copy = JSON.parse(JSON.stringify(state.pages[i]));
  copy.id = uid();
  copy._thumb = state.pages[i]._thumb;
  state.pages.splice(i + 1, 0, copy);
  state.cur = i + 1;
  fire('change');
}

export function movePage(from, to) {
  if (from === to) return;
  snapshot();
  const [p] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, p);
  state.cur = to;
  fire('change');
}

export function go(i) {
  if (!state.pages.length) return;
  state.cur = clamp(i, 0, state.pages.length - 1);
  state.selected = null;
  renderPage();
  updateThumbActive();
  updateNav();
}

export function setScale(s) {
  state.scale = clamp(s, 0.4, 4);
  $('#zoomLabel').textContent = Math.round(state.scale * 100) + '%';
  renderPage();
}

export function fitWidth() {
  const p = currentPage();
  if (!p) return;
  const avail = $('#viewerScroll').clientWidth - 48;
  setScale(avail / p.w);
}

let seq = 0;
let currentTask = null;

export async function renderPage() {
  const wrapEl = $('#pageWrap');
  const cv = $('#pageCanvas');
  const p = currentPage();
  $('#workspace').hidden = !p;
  $('#emptyState').hidden = !!p;
  if (!p) return;

  const cssW = p.w * state.scale;
  const cssH = p.h * state.scale;
  wrapEl.style.width = cssW + 'px';
  wrapEl.style.height = cssH + 'px';

  const dpr = window.devicePixelRatio || 1;
  const my = ++seq;
  if (currentTask) { try { currentTask.cancel(); } catch { /* noop */ } currentTask = null; }

  try {
    if (p.docId) {
      const doc = state.docs.get(p.docId);
      if (!doc) throw new Error('문서를 찾을 수 없습니다.');
      const pg = await doc.pj.getPage(p.idx + 1);
      if (my !== seq) return;
      const vp = pg.getViewport({ scale: state.scale * dpr });
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      cv.style.width = cssW + 'px';
      cv.style.height = cssH + 'px';
      const task = pg.render({ canvasContext: cv.getContext('2d'), viewport: vp });
      currentTask = task;
      await task.promise;
      currentTask = null;
    } else {
      cv.width = Math.floor(cssW * dpr);
      cv.height = Math.floor(cssH * dpr);
      cv.style.width = cssW + 'px';
      cv.style.height = cssH + 'px';
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
  } catch (err) {
    currentTask = null;
    if (my === seq && err && err.name !== 'RenderingCancelledException') {
      console.warn('렌더링 오류:', err);
    }
    if (my !== seq) return;
  }
  if (my !== seq) return;
  fire('page', p);
}

export async function ensureThumb(p, holder) {
  if (p._thumb) {
    if (holder && !holder.firstChild) {
      const img = new Image();
      img.src = p._thumb;
      holder.appendChild(img);
    }
    return;
  }
  try {
    let dataUrl;
    if (p.docId) {
      const doc = state.docs.get(p.docId);
      const pg = await doc.pj.getPage(p.idx + 1);
      const vp0 = pg.getViewport({ scale: 1 });
      const s = 150 / vp0.width;
      const vp = pg.getViewport({ scale: s });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      dataUrl = c.toDataURL('image/png');
    } else {
      const c = document.createElement('canvas');
      c.width = 150;
      c.height = Math.round(150 * p.h / p.w);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      dataUrl = c.toDataURL('image/png');
    }
    p._thumb = dataUrl;
    if (holder) {
      const img = new Image();
      img.src = dataUrl;
      holder.appendChild(img);
    }
  } catch (err) {
    console.warn('썸네일 생성 실패:', err);
  }
}

export function updateThumbActive() {
  document.querySelectorAll('#thumbs .th').forEach((el, i) => {
    el.classList.toggle('current', i === state.cur);
  });
}

export function updateNav() {
  $('#pageNum').value = state.cur + 1;
  $('#pageNum').max = String(state.pages.length);
  $('#pageCount').textContent = '/ ' + state.pages.length;
  $('#zoomLabel').textContent = Math.round(state.scale * 100) + '%';
}

export function renderThumbs() {
  const T = $('#thumbs');
  T.innerHTML = '';
  state.pages.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'th' + (i === state.cur ? ' current' : '');
    d.draggable = true;
    const holder = document.createElement('div');
    holder.className = 'th-img';
    d.appendChild(holder);
    const num = document.createElement('div');
    num.className = 'th-num';
    num.textContent = String(i + 1);
    d.appendChild(num);
    const del = document.createElement('button');
    del.className = 'th-del';
    del.title = '페이지 삭제';
    del.textContent = '✕';
    del.addEventListener('click', e => { e.stopPropagation(); deletePage(i); });
    d.appendChild(del);
    d.addEventListener('click', () => go(i));
    d.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/x-page-index', String(i));
      e.dataTransfer.effectAllowed = 'move';
    });
    d.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('application/x-page-index')) {
        e.preventDefault();
        d.classList.add('drop-target');
      }
    });
    d.addEventListener('dragleave', () => d.classList.remove('drop-target'));
    d.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      d.classList.remove('drop-target');
      const from = parseInt(e.dataTransfer.getData('application/x-page-index'), 10);
      if (!isNaN(from) && from !== i) movePage(from, i);
    });
    T.appendChild(d);
    ensureThumb(p, holder);
  });
}
