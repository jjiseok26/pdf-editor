import {
  state, $, on, fire, sleep, toast, download,
  parsePdfFile, resetAll, addPages, makeBlankPage, resetHistory,
  renderThumbs, renderPage, updateNav, go, setScale, fitWidth,
  undo, redo, hexRgb, currentPage,
  canUndoCount, canRedoCount
} from './core.js';
import {
  decorate, buildAnnos, updateLayersMode, initAnnotate, initSignature,
  placeImage, deleteSelected, applyPropsToSelected
} from './edit.js';

let fontCache = null;

async function loadKoreanFont() {
  if (fontCache) return fontCache;
  const b64 = window.__NANUM_FONT_B64__;
  if (b64) {
    const bin = atob(b64);
    fontCache = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) fontCache[i] = bin.charCodeAt(i);
    return fontCache;
  }
  const res = await fetch('assets/fonts/NanumGothic-Regular.ttf');
  if (!res.ok) throw new Error('한글 폰트 파일을 읽을 수 없습니다');
  fontCache = new Uint8Array(await res.arrayBuffer());
  return fontCache;
}

const hasNonAscii = s => /[^\x00-\xff]/.test(s);

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function cssColorParts(str) {
  const m = /^rgba?\(([^)]+)\)$/i.exec(String(str).trim());
  if (m) {
    const parts = m[1].split(',').map(v => parseFloat(v));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
  }
  const { r, g, b } = hexRgb(str);
  return { r, g, b, a: 1 };
}

async function paintElement(page, el, W, H, outDoc, env) {
  const { L, uni, std, warns, mkColor } = env;
  try {
    switch (el.type) {
      case 'text': {
        if (!uni && hasNonAscii(el.text)) {
          warns.push('한글 폰트를 사용할 수 없어 일부 텍스트가 생략되었습니다.');
          return;
        }
        const f = uni || std;
        const lines = el.text.split('\n');
        lines.forEach((ln, i) => {
          if (!ln.trim()) return;
          page.drawText(ln, {
            x: el.x,
            y: H - el.y - el.fs * 0.92 - i * el.fs * 1.32,
            size: el.fs,
            font: f,
            color: mkColor(el.color)
          });
        });
        break;
      }
      case 'image': {
        const bytes = dataUrlToBytes(el.src);
        const img = el.src.startsWith('data:image/jpeg')
          ? await outDoc.embedJpg(bytes)
          : await outDoc.embedPng(bytes);
        page.drawImage(img, { x: el.x, y: H - el.y - el.h, width: el.w, height: el.h });
        break;
      }
      case 'rect': {
        const fill = el.fill ? cssColorParts(el.fill) : null;
        page.drawRectangle({
          x: el.x,
          y: H - el.y - el.h,
          width: el.w,
          height: el.h,
          borderColor: mkColor(el.color),
          borderWidth: el.sw,
          ...(fill ? { color: L.rgb(fill.r / 255, fill.g / 255, fill.b / 255), opacity: fill.a } : {})
        });
        break;
      }
      case 'ellipse': {
        const fill = el.fill ? cssColorParts(el.fill) : null;
        page.drawEllipse({
          x: el.x + el.w / 2,
          y: H - el.y - el.h / 2,
          xScale: Math.max(el.w / 2, 0.5),
          yScale: Math.max(el.h / 2, 0.5),
          borderColor: mkColor(el.color),
          borderWidth: el.sw,
          ...(fill ? { color: L.rgb(fill.r / 255, fill.g / 255, fill.b / 255), opacity: fill.a } : {})
        });
        break;
      }
      case 'line': {
        page.drawLine({
          start: { x: el.x1, y: H - el.y1 },
          end: { x: el.x2, y: H - el.y2 },
          thickness: el.sw,
          color: mkColor(el.color),
          opacity: el.alpha ?? 1
        });
        break;
      }
      case 'ink':
      case 'hl': {
        const isHl = el.type === 'hl';
        const thickness = isHl ? el.sw * 2.4 : el.sw;
        const opacity = isHl ? 0.38 : (el.alpha ?? 1);
        for (let i = 2; i < el.pts.length; i += 2) {
          page.drawLine({
            start: { x: el.pts[i - 2], y: H - el.pts[i - 1] },
            end: { x: el.pts[i], y: H - el.pts[i + 1] },
            thickness,
            color: mkColor(el.color),
            opacity
          });
        }
        break;
      }
    }
  } catch (err) {
    console.warn('요소 그리기 실패:', err);
    warns.push('일부 요소를 저장하지 못했습니다 (' + err.message + ')');
  }
}

export async function buildPdf() {
  const L = window.PDFLib;
  const out = await L.PDFDocument.create();
  if (window.fontkit) out.registerFontkit(window.fontkit);

  const needsCustom = state.pages.some(p =>
    (p.spans || []).some(s => s.edited !== null && hasNonAscii(s.edited || '')) ||
    p.els.some(e => e.type === 'text' && hasNonAscii(e.text))
  );

  let uni = null;
  try {
    uni = await out.embedFont(await loadKoreanFont(), { subset: true });
  } catch (err) {
    console.warn('한글 폰트 임베딩 실패:', err);
    uni = null;
    if (needsCustom) toast('한글 폰트 임베딩에 실패했습니다. 일부 텍스트가 누락될 수 있습니다.', true);
  }

  const std = await out.embedFont(L.StandardFonts.Helvetica);
  const env = {
    L,
    uni,
    std,
    warns: [],
    mkColor: hex => {
      const { r, g, b } = hexRgb(hex);
      return L.rgb(r / 255, g / 255, b / 255);
    }
  };

  const libCache = new Map();
  for (const p of state.pages) {
    let page;
    if (!p.docId) {
      page = out.addPage([p.w, p.h]);
    } else {
      const d = state.docs.get(p.docId);
      let src = libCache.get(p.docId);
      if (!src) {
        src = await L.PDFDocument.load(d.bytes, { ignoreEncryption: true });
        libCache.set(p.docId, src);
      }
      const [cp] = await out.copyPages(src, [p.idx]);
      page = out.addPage(cp);
    }
    const { width: W, height: H } = page.getSize();

    for (const s of (p.spans || [])) {
      if (s.edited === null) continue;
      for (const pc of s.pieces) {
        page.drawRectangle({
          x: pc.x - 0.5,
          y: pc.y - s.fs * 0.22,
          width: pc.w + 1.2,
          height: s.fs * 1.18,
          color: L.rgb(1, 1, 1)
        });
      }
      const txt = (s.edited || '').trim();
      if (txt) {
        if (!uni && hasNonAscii(txt)) {
          if (!env.warns.some(w => w.includes('생략'))) env.warns.push('한글 폰트를 사용할 수 없어 수정된 일부 텍스트가 생략되었습니다.');
          continue;
        }
        try {
          page.drawText(txt, {
            x: s.pieces[0].x,
            y: s.pieces[0].y,
            size: s.fs,
            font: uni || std,
            color: L.rgb(0.07, 0.08, 0.1)
          });
        } catch (err) {
          console.warn(err);
          env.warns.push('수정된 텍스트 중 저장하지 못한 것이 있습니다.');
        }
      }
    }

    for (const el of p.els) await paintElement(page, el, W, H, out, env);
  }

  if (env.warns.length) toast(env.warns[0]);
  return await out.save();
}

async function exportPageBlob(i, scale = 3) {
  const p = state.pages[i];
  const cv = document.createElement('canvas');
  scale = Math.min(scale, 4200 / Math.max(p.w, p.h));
  if (p.docId) {
    const doc = state.docs.get(p.docId);
    const pg = await doc.pj.getPage(p.idx + 1);
    const vp = pg.getViewport({ scale });
    cv.width = Math.floor(vp.width);
    cv.height = Math.floor(vp.height);
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  } else {
    cv.width = Math.max(1, Math.floor(p.w * scale));
    cv.height = Math.max(1, Math.floor(p.h * scale));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
  return await new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

async function saveCurrentPng() {
  if (!state.pages.length) return;
  try {
    const blob = await exportPageBlob(state.cur);
    download(`페이지-${state.cur + 1}.png`, blob);
    toast('PNG로 저장했습니다.');
  } catch (err) {
    console.error(err);
    toast('PNG 저장 실패: ' + err.message, true);
  }
}

async function saveAllPng() {
  if (!state.pages.length) return;
  toast(`전체 ${state.pages.length}페이지를 PNG로 저장합니다...`);
  for (let i = 0; i < state.pages.length; i++) {
    try {
      const blob = await exportPageBlob(i);
      download(`페이지-${i + 1}.png`, blob);
    } catch (err) {
      console.warn(err);
    }
    await sleep(450);
  }
  toast('전체 페이지 내보내기를 완료했습니다.');
}

function confirmDiscard() {
  if (!state.pages.length || !state.dirty) return true;
  return confirm('저장하지 않은 변경사항이 사라집니다. 계속할까요?');
}

async function openFiles(fileList, append) {
  const files = [...fileList].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) {
    toast('PDF 파일을 선택해 주세요.');
    return;
  }
  toast('문서를 불러오는 중...');
  try {
    const parsed = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      parsed.push(await parsePdfFile(bytes));
    }
    const appendMode = append && state.pages.length > 0;
    let firstNewIndex;
    if (appendMode) {
      firstNewIndex = state.pages.length;
    } else {
      state.docs.clear();
      state.pages = [];
      resetHistory();
      state.dirty = false;
      firstNewIndex = 0;
    }
    for (const p of parsed) {
      state.docs.set(p.docId, p.entry);
      state.pages.push(...p.pages);
    }
    if (!state.pages.length) throw new Error('페이지가 없는 문서입니다');
    state.cur = appendMode ? Math.min(firstNewIndex, state.pages.length - 1) : 0;
    state.selected = null;
    fire('change');
    toast(appendMode
      ? `병합 완료: ${state.pages.length - firstNewIndex}개 페이지가 추가되었습니다.`
      : `${state.pages.length}개 페이지를 불러왔습니다.`);
  } catch (err) {
    console.error(err);
    toast('불러오기 실패: ' + err.message, true);
  }
}

function newDocument() {
  if (!confirmDiscard()) return;
  const nRaw = prompt('만들 페이지 수:', '1');
  const n = Math.min(Math.max(parseInt(nRaw || '1', 10) || 1, 1), 200);
  const pages = [];
  for (let i = 0; i < n; i++) pages.push(makeBlankPage());
  resetAll(pages);
  toast(`새 문서(${n}페이지)를 만들었습니다. 도구로 자유롭게 꾸며보세요.`);
}

function setTool(t) {
  state.tool = t;
  document.querySelectorAll('.tbtn[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === t);
  });
  updateLayersMode();
}

function refreshButtons() {
  const has = state.pages.length > 0;
  ['#btnMerge', '#btnSig', '#btnImg', '#btnAddPage', '#btnSavePdf', '#btnPng', '#btnPngAll']
    .forEach(s => { $(s).disabled = !has; });
  $('#btnUndo').disabled = !canUndoCount();
  $('#btnRedo').disabled = !canRedoCount();
}

function wireUi() {
  $('#btnOpen').addEventListener('click', () => { if (confirmDiscard()) $('#filePdf').click(); });
  $('#btnOpen2').addEventListener('click', () => $('#filePdf').click());
  $('#filePdf').addEventListener('change', e => {
    openFiles(e.target.files, false);
    e.target.value = '';
  });

  $('#btnMerge').addEventListener('click', () => $('#fileMerge').click());
  $('#fileMerge').addEventListener('change', e => {
    openFiles(e.target.files, true);
    e.target.value = '';
  });

  $('#btnNew').addEventListener('click', newDocument);
  $('#btnNew2').addEventListener('click', newDocument);

  $('#btnImg').addEventListener('click', () => $('#fileImg').click());
  $('#fileImg').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => placeImage(rd.result, img.naturalWidth, img.naturalHeight, 280);
      img.src = rd.result;
    };
    rd.readAsDataURL(f);
  });

  $('#tools').addEventListener('click', e => {
    const b = e.target.closest('.tbtn[data-tool]');
    if (b) setTool(b.dataset.tool);
  });

  $('#chkTextMode').addEventListener('change', e => {
    state.textMode = e.target.checked;
    updateLayersMode();
    const p = currentPage();
    if (p) decorate(p);
  });

  const bindProp = (sel, fn) => $(sel).addEventListener('change', e => fn(e.target));
  bindProp('#propColor', t => {
    state.opts.color = t.value;
    applyPropsToSelected({ color: t.value });
  });
  bindProp('#propStroke', t => {
    state.opts.strokeW = parseInt(t.value, 10) || 2;
    applyPropsToSelected({ strokeW: state.opts.strokeW });
  });
  bindProp('#propFontSize', t => {
    state.opts.fontSize = Math.min(Math.max(parseInt(t.value, 10) || 16, 6), 96);
    applyPropsToSelected({ fontSize: state.opts.fontSize });
  });
  bindProp('#propHl', t => {
    state.opts.hlColor = t.value;
    const p = currentPage();
    const el = p && p.els.find(x => x.id === state.selected);
    if (el && el.type === 'hl') applyPropsToSelected({ color: t.value });
  });
  bindProp('#chkFill', t => {
    state.opts.fillOn = t.checked;
    applyPropsToSelected({ fillOn: t.checked, color: state.opts.color });
  });

  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);

  $('#btnSavePdf').addEventListener('click', async () => {
    try {
      toast('PDF를 만드는 중...');
      const bytes = await buildPdf();
      download('편집된-문서.pdf', new Blob([bytes], { type: 'application/pdf' }));
      toast('PDF 저장 완료!');
    } catch (err) {
      console.error(err);
      toast('PDF 저장 실패: ' + err.message, true);
    }
  });
  $('#btnPng').addEventListener('click', saveCurrentPng);
  $('#btnPngAll').addEventListener('click', saveAllPng);

  $('#btnAddPage').addEventListener('click', () => addPages([makeBlankPage()], state.cur));

  $('#btnPrev').addEventListener('click', () => go(state.cur - 1));
  $('#btnNext').addEventListener('click', () => go(state.cur + 1));
  $('#pageNum').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) go(v - 1);
  });
  $('#btnZoomIn').addEventListener('click', () => setScale(state.scale + 0.15));
  $('#btnZoomOut').addEventListener('click', () => setScale(state.scale - 0.15));
  $('#btnFit').addEventListener('click', fitWidth);

  window.addEventListener('keydown', e => {
    const t = e.target;
    const sigOpen = !$('#sigModal').hidden;
    if (sigOpen) {
      if (e.key === 'Escape') $('#sigModal').hidden = true;
      return;
    }
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (deleteSelected()) e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      state.selected = null;
      const p = currentPage();
      if (p) buildAnnos(p);
      setTool('select');
      return;
    }
    const keys = { v: 'select', t: 'text', r: 'rect', o: 'ellipse', l: 'line', p: 'pen', h: 'hl', e: 'eraser' };
    const k = keys[e.key.toLowerCase()];
    if (k) setTool(k);
  });

  ['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, e => {
    e.preventDefault();
    if ([...(e.dataTransfer?.types || [])].includes('Files')) document.body.classList.add('dropping');
  }));
  window.addEventListener('dragleave', e => {
    if (e.relatedTarget === null) document.body.classList.remove('dropping');
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) return;
    if (state.pages.length) {
      const append = confirm('확인을 누르면 현재 문서에 이어 붙여 병합하고, 취소하면 새로 엽니다.');
      openFiles(files, append);
    } else {
      openFiles(files, false);
    }
  });

  on('change', () => {
    renderThumbs();
    updateNav();
    refreshButtons();
    renderPage();
  });
  on('page', p => decorate(p));

  refreshButtons();
}

async function boot() {
  for (let i = 0; i < 240; i++) {
    if (window.pdfjsLib && window.PDFLib && window.fontkit) break;
    await sleep(50);
  }
  if (!window.pdfjsLib || !window.PDFLib || !window.fontkit) {
    document.body.innerHTML = '<div style="padding:48px;font-size:16px">라이브러리 로드에 실패했습니다. assets/vendor 폴더를 확인하세요.</div>';
    return;
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = './assets/vendor/pdf.worker.min.js';
  initAnnotate();
  initSignature();
  wireUi();
}

boot();
