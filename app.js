/* ponytail: no bundler; CDN globals pdfjsLib, PDFLib, fontkit */

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FONT_URL =
  "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/woff/Pretendard-Regular.woff";
const TOOL_COLORS = {
  select: "#ca8a04",
  text: "#1c1917",
  highlight: "#ca8a04",
  pen: "#dc2626",
  rect: "#1d4ed8",
  eraser: "#ca8a04",
};

const state = {
  fileName: "document.pdf",
  originalBytes: null,
  pdf: null,
  pages: [],
  annotations: [],
  tool: "select",
  color: TOOL_COLORS.highlight,
  zoom: 1,
  selectedId: null,
  activePageId: null,
  drag: null,
  draft: null,
  fontBytes: null,
  history: [],
  mergeFiles: [],
  ocrWorker: null,
  ocrBusy: false,
};

const els = {
  fileInput: document.getElementById("file-input"),
  colorInput: document.getElementById("color-input"),
  zoomLabel: document.getElementById("zoom-label"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  saveBtn: document.getElementById("save-btn"),
  printBtn: document.getElementById("print-btn"),
  mergeBtn: document.getElementById("merge-btn"),
  mergeDialog: document.getElementById("merge-dialog"),
  mergeList: document.getElementById("merge-list"),
  mergeInput: document.getElementById("merge-input"),
  mergeRun: document.getElementById("merge-run"),
  mergeClose: document.getElementById("merge-close"),
  ocrPanel: document.getElementById("ocr-panel"),
  ocrText: document.getElementById("ocr-text"),
  ocrCopy: document.getElementById("ocr-copy"),
  ocrClose: document.getElementById("ocr-close"),
  status: document.getElementById("status"),
  autosave: document.getElementById("autosave-label"),
  thumbs: document.getElementById("thumbs"),
  viewer: document.getElementById("viewer"),
  empty: document.getElementById("empty"),
  pages: document.getElementById("pages"),
};

const DRAFT_DB = "pdf-editor-draft";
const DRAFT_STORE = "draft";
const DRAFT_KEY = "current";
let autosaveTimer = null;
let restoringDraft = false;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

console.assert(toPdfLibY(100, 800, 20) === 680, "PDF y-origin conversion");

function uid() {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function toPdfLibY(top, pageHeight, boxHeight = 0) {
  return pageHeight - top - boxHeight;
}

function hexToRgb01(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

function setStatus(text) {
  els.status.textContent = text || "";
}

function eventToPdf(event, page) {
  const wrap = document.getElementById(`view-${page.id}`);
  const rect = wrap.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) * page.width) / rect.width,
    y: ((event.clientY - rect.top) * page.height) / rect.height,
  };
}

function normRect(x0, y0, x1, y1) {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pageById(id) {
  return state.pages.find((p) => p.id === id);
}

function annotationsFor(pageId) {
  return state.annotations.filter((a) => a.pageId === pageId);
}

function hitTest(pageId, pt) {
  const list = annotationsFor(pageId).slice().reverse();
  for (const ann of list) {
    if (ann.type === "pen") {
      const threshold = (ann.strokeWidth || 2) + 4;
      for (let i = 1; i < ann.points.length; i += 1) {
        if (distToSegment(pt, ann.points[i - 1], ann.points[i]) <= threshold) {
          return ann;
        }
      }
    } else {
      const pad = ann.type === "text" ? 4 : 0;
      if (
        pt.x >= ann.x - pad &&
        pt.x <= ann.x + ann.width + pad &&
        pt.y >= ann.y - pad &&
        pt.y <= ann.y + ann.height + pad
      ) {
        return ann;
      }
    }
  }
  return null;
}

function extractTextItems(content, viewport, pageId) {
  const items = [];
  let i = 0;
  for (const geom of content.items) {
    if (!geom?.str || !geom.transform) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, geom.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || 11;
    const style = content.styles?.[geom.fontName];
    let ascent = fontHeight;
    if (style?.ascent) ascent = style.ascent * fontHeight;
    else if (style?.descent) ascent = (1 + style.descent) * fontHeight;
    const width = (geom.width || 0) * (viewport.scale || 1);
    if (!geom.str.trim() || width < 0.8) continue;
    items.push({
      id: `${pageId}-ti-${i}`,
      str: geom.str,
      x: tx[4],
      y: tx[5] - ascent,
      width: Math.max(width, 2),
      height: Math.max(fontHeight, 8),
      fontSize: fontHeight,
    });
    i += 1;
  }
  return items;
}

function distToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * abx, y: a.y + t * aby });
}

function moveAnnotation(ann, dx, dy) {
  if (ann.type === "pen") {
    ann.points = ann.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  } else {
    ann.x += dx;
    ann.y += dy;
  }
}

function setDocButtons(enabled) {
  els.saveBtn.disabled = !enabled;
  els.printBtn.disabled = !enabled;
}

function openDraftDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DRAFT_STORE)) {
        req.result.createObjectStore(DRAFT_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function setAutosaveLabel(ts) {
  if (!els.autosave) return;
  const t = new Date(ts);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  els.autosave.hidden = false;
  els.autosave.textContent = `자동 저장 ${hh}:${mm}`;
}

async function persistDraft() {
  if (restoringDraft || !state.originalBytes) return;
  const db = await openDraftDb();
  const draft = {
    fileName: state.fileName,
    originalBytes: state.originalBytes,
    annotations: JSON.parse(JSON.stringify(state.annotations)),
    pages: state.pages.map((p) => ({
      id: p.id,
      originalIndex: p.originalIndex,
    })),
    savedAt: Date.now(),
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).put(draft, DRAFT_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  setAutosaveLabel(draft.savedAt);
}

async function readDraft() {
  const db = await openDraftDb();
  const draft = await new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readonly");
    const req = tx.objectStore(DRAFT_STORE).get(DRAFT_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return draft;
}

function scheduleAutosave() {
  if (restoringDraft || !state.originalBytes) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    persistDraft().catch((err) => {
      console.error(err);
      if (els.autosave) {
        els.autosave.hidden = false;
        els.autosave.textContent = "자동 저장 실패";
      }
    });
  }, 800);
}

function flushAutosave() {
  if (!state.originalBytes) return;
  clearTimeout(autosaveTimer);
  persistDraft().catch((err) => console.error(err));
}

async function restoreDraft() {
  let draft = null;
  try {
    draft = await readDraft();
  } catch (err) {
    console.error(err);
    return;
  }
  if (!draft?.originalBytes) return;
  restoringDraft = true;
  try {
    await openPdfBytes(draft.originalBytes, draft.fileName || "document.pdf");
    if (draft.pages?.length) {
      const restored = [];
      for (const saved of draft.pages) {
        const live = state.pages.find((p) => p.originalIndex === saved.originalIndex);
        if (live) restored.push({ ...live, id: saved.id });
      }
      if (restored.length) state.pages = restored;
    }
    state.annotations = Array.isArray(draft.annotations) ? draft.annotations : [];
    await renderDocument();
    setAutosaveLabel(draft.savedAt || Date.now());
    setStatus(`자동 저장된 문서 · ${state.pages.length}페이지`);
  } catch (err) {
    console.error(err);
    setStatus("자동 저장 문서를 열지 못했습니다.");
  } finally {
    restoringDraft = false;
  }
}

function snapshotDoc() {
  return {
    annotations: JSON.parse(JSON.stringify(state.annotations)),
    pages: state.pages.map((p) => ({
      id: p.id,
      originalIndex: p.originalIndex,
      width: p.width,
      height: p.height,
      textItems: p.textItems,
    })),
  };
}

function pushHistory() {
  state.history.push(snapshotDoc());
  if (state.history.length > 40) state.history.shift();
  scheduleAutosave();
}

async function undo() {
  const prev = state.history.pop();
  if (!prev) {
    setStatus("되돌릴 작업이 없습니다.");
    return;
  }
  const missing = prev.pages.some((p) => !document.getElementById(`view-${p.id}`));
  state.annotations = prev.annotations;
  state.pages = prev.pages;
  state.selectedId = null;
  state.draft = null;
  state.drag = null;
  if (missing) await renderDocument();
  else {
    syncDomOrder();
    redrawAllOverlays();
  }
  setStatus("실행 취소");
  scheduleAutosave();
}

function setTool(tool) {
  state.tool = tool;
  state.selectedId = null;
  document.body.dataset.tool = tool;
  document.querySelectorAll(".btn.tool").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
  if (TOOL_COLORS[tool]) {
    state.color = TOOL_COLORS[tool];
    els.colorInput.value = state.color;
  }
  redrawAllOverlays();
}

function isPdfFile(file) {
  const name = file?.name || "";
  return name.toLowerCase().endsWith(".pdf") || file?.type === "application/pdf";
}

async function openFile(file) {
  if (!file) return;
  if (!isPdfFile(file)) {
    setStatus("PDF 파일만 열 수 있습니다.");
    return;
  }
  const buffer = await file.arrayBuffer();
  await openPdfBytes(new Uint8Array(buffer), file.name || "document.pdf");
}

async function openPdfBytes(bytes, fileName) {
  setStatus("불러오는 중…");
  setDocButtons(false);

  try {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    state.originalBytes = new Uint8Array(data);
    state.fileName = fileName || "document.pdf";
    state.annotations = [];
    state.selectedId = null;
    state.draft = null;
    state.drag = null;
    state.history = [];
    state.zoom = 1;
    els.zoomLabel.textContent = "100%";

    if (state.pdf) {
      await state.pdf.destroy();
      state.pdf = null;
    }

    const loading = pdfjsLib.getDocument({ data: data.slice(0) });
    state.pdf = await loading.promise;
    state.pages = [];

    for (let i = 1; i <= state.pdf.numPages; i += 1) {
      const page = await state.pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const pageId = `page-${i}`;
      const content = await page.getTextContent();
      state.pages.push({
        id: pageId,
        originalIndex: i,
        width: viewport.width,
        height: viewport.height,
        textItems: extractTextItems(content, viewport, pageId),
      });
    }

    els.empty.hidden = true;
    els.pages.hidden = false;
    setDocButtons(true);
    await renderDocument();
    setStatus(`${state.fileName} · ${state.pages.length}페이지`);
    scheduleAutosave();
  } catch (err) {
    console.error(err);
    setDocButtons(!!state.originalBytes);
    setStatus("PDF를 열 수 없습니다.");
  }
}

async function renderDocument() {
  els.thumbs.replaceChildren();
  els.pages.replaceChildren();

  for (const page of state.pages) {
    els.thumbs.appendChild(createThumb(page));
    els.pages.appendChild(createPageView(page));
  }

  await Promise.all(state.pages.map((page) => renderPage(page)));
  await Promise.all(state.pages.map((page) => renderThumb(page)));
  updatePageLabels();
  if (state.pages[0]) setActivePage(state.pages[0].id);
}

function createPageView(page) {
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  wrap.id = `view-${page.id}`;
  wrap.dataset.pageId = page.id;

  const pdfCanvas = document.createElement("canvas");
  pdfCanvas.className = "pdf-canvas";

  const overlay = document.createElement("canvas");
  overlay.className = "overlay";

  const label = document.createElement("span");
  label.className = "page-index";

  wrap.append(pdfCanvas, overlay, label);
  bindOverlay(overlay, page);
  return wrap;
}

function createThumb(page) {
  const el = document.createElement("div");
  el.className = "thumb";
  el.id = `thumb-${page.id}`;
  el.dataset.pageId = page.id;
  el.draggable = true;

  const canvas = document.createElement("canvas");
  const label = document.createElement("span");
  label.className = "thumb-label";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "thumb-delete";
  del.title = "페이지 삭제";
  del.textContent = "×";
  del.addEventListener("click", (event) => {
    event.stopPropagation();
    deletePage(page.id);
  });

  el.append(canvas, label, del);
  el.addEventListener("click", () => {
    setActivePage(page.id);
    document.getElementById(`view-${page.id}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });

  el.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", page.id);
    event.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (event) => {
    event.preventDefault();
    el.classList.remove("drag-over");
    const fromId = event.dataTransfer.getData("text/plain");
    reorderPages(fromId, page.id);
  });

  return el;
}

function sizeCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

async function renderPage(page) {
  const wrap = document.getElementById(`view-${page.id}`);
  if (!wrap || !state.pdf) return;

  if (wrap._renderTask) wrap._renderTask.cancel();

  const pdfCanvas = wrap.querySelector(".pdf-canvas");
  const overlay = wrap.querySelector(".overlay");
  const pdfPage = await state.pdf.getPage(page.originalIndex);
  const viewport = pdfPage.getViewport({ scale: state.zoom });
  const dpr = window.devicePixelRatio || 1;

  pdfCanvas.width = Math.round(viewport.width * dpr);
  pdfCanvas.height = Math.round(viewport.height * dpr);
  pdfCanvas.style.width = `${viewport.width}px`;
  pdfCanvas.style.height = `${viewport.height}px`;

  const ctx = pdfCanvas.getContext("2d");
  const renderContext = { canvasContext: ctx, viewport };
  if (dpr !== 1) renderContext.transform = [dpr, 0, 0, dpr, 0, 0];
  const task = pdfPage.render(renderContext);
  wrap._renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
  }

  wrap.style.width = `${viewport.width}px`;
  sizeCanvas(overlay, viewport.width, viewport.height);
  drawOverlay(page);
}

async function renderThumb(page) {
  const thumb = document.getElementById(`thumb-${page.id}`);
  if (!thumb || !state.pdf) return;
  const canvas = thumb.querySelector("canvas");
  const pdfPage = await state.pdf.getPage(page.originalIndex);
  const viewport = pdfPage.getViewport({ scale: 0.18 });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await pdfPage.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
  }).promise;
}

function updatePageLabels() {
  state.pages.forEach((page, index) => {
    const view = document.getElementById(`view-${page.id}`);
    const thumb = document.getElementById(`thumb-${page.id}`);
    const text = `${index + 1} / ${state.pages.length}`;
    if (view) view.querySelector(".page-index").textContent = text;
    if (thumb) thumb.querySelector(".thumb-label").textContent = `${index + 1}`;
  });
}

function setActivePage(pageId) {
  state.activePageId = pageId;
  document.querySelectorAll(".thumb").forEach((el) => {
    el.classList.toggle("active", el.dataset.pageId === pageId);
  });
}

function syncDomOrder() {
  for (const page of state.pages) {
    els.pages.appendChild(document.getElementById(`view-${page.id}`));
    els.thumbs.appendChild(document.getElementById(`thumb-${page.id}`));
  }
  updatePageLabels();
}

function reorderPages(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const from = state.pages.findIndex((p) => p.id === fromId);
  const to = state.pages.findIndex((p) => p.id === toId);
  if (from < 0 || to < 0) return;
  pushHistory();
  const [moved] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, moved);
  syncDomOrder();
  setActivePage(fromId);
}

function deletePage(pageId) {
  if (state.pages.length <= 1) {
    setStatus("마지막 페이지는 삭제할 수 없습니다.");
    return;
  }
  pushHistory();
  state.pages = state.pages.filter((p) => p.id !== pageId);
  state.annotations = state.annotations.filter((a) => a.pageId !== pageId);
  document.getElementById(`view-${pageId}`)?.remove();
  document.getElementById(`thumb-${pageId}`)?.remove();
  updatePageLabels();
  if (state.activePageId === pageId) {
    setActivePage(state.pages[0].id);
  }
  setStatus(`${state.fileName} · ${state.pages.length}페이지`);
}

function redrawAllOverlays() {
  state.pages.forEach(drawOverlay);
}

function drawOverlay(page) {
  const wrap = document.getElementById(`view-${page.id}`);
  if (!wrap) return;
  const canvas = wrap.querySelector(".overlay");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const zoom = state.zoom;
  const anns = annotationsFor(page.id);
  if (state.draft && state.draft.pageId === page.id) anns.push(state.draft);

  for (const ann of anns) {
    const selected = ann.id && ann.id === state.selectedId;
    paintAnnotation(ctx, ann, zoom, selected);
  }
}

function paintAnnotation(ctx, ann, zoom, selected) {
  ctx.save();
  if (ann.type === "highlight") {
    ctx.fillStyle = hexToCss(ann.color, 0.38);
    ctx.fillRect(ann.x * zoom, ann.y * zoom, ann.width * zoom, ann.height * zoom);
  } else if (ann.type === "rect") {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = (ann.strokeWidth || 1.5) * zoom;
    ctx.strokeRect(ann.x * zoom, ann.y * zoom, ann.width * zoom, ann.height * zoom);
  } else if (ann.type === "ocr") {
    ctx.fillStyle = "rgba(37, 99, 235, 0.18)";
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5 * zoom;
    ctx.fillRect(ann.x * zoom, ann.y * zoom, ann.width * zoom, ann.height * zoom);
    ctx.strokeRect(ann.x * zoom, ann.y * zoom, ann.width * zoom, ann.height * zoom);
  } else if (ann.type === "text") {
    ctx.fillStyle = ann.color;
    ctx.font = `${(ann.fontSize || 14) * zoom}px "Noto Sans KR", sans-serif`;
    ctx.textBaseline = "top";
    const lines = String(ann.text || "").split("\n");
    const lh = (ann.fontSize || 14) * 1.35 * zoom;
    lines.forEach((line, i) => {
      ctx.fillText(line, ann.x * zoom, ann.y * zoom + i * lh);
    });
  } else if (ann.type === "pen" && ann.points?.length) {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = (ann.strokeWidth || 2.2) * zoom;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ann.points.forEach((p, i) => {
      const x = p.x * zoom;
      const y = p.y * zoom;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  if (selected && ann.type !== "pen" && ann.type !== "ocr") {
    ctx.strokeStyle = "#c2410c";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(
      ann.x * zoom - 2,
      ann.y * zoom - 2,
      ann.width * zoom + 4,
      ann.height * zoom + 4
    );
  }
  ctx.restore();
}

function hexToCss(hex, alpha) {
  const { r, g, b } = hexToRgb01(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

function bindOverlay(overlay, page) {
  overlay.addEventListener("pointerdown", (event) => onPointerDown(event, page, overlay));
  overlay.addEventListener("pointermove", (event) => onPointerMove(event, page));
  overlay.addEventListener("pointerup", (event) => onPointerUp(event, page, overlay));
  overlay.addEventListener("pointercancel", (event) => onPointerUp(event, page, overlay));
}

function finishTextEditor() {
  const editor = document.querySelector(".text-editor");
  if (editor) editor.blur();
}

function onPointerDown(event, page, overlay) {
  if (event.button !== 0) return;
  finishTextEditor();
  setActivePage(page.id);
  const pt = eventToPdf(event, page);

  if (state.tool === "text") {
    const hit = hitTest(page.id, pt);
    if (hit && hit.type === "text") {
      beginAnnDrag(hit, pt, overlay, event);
      drawOverlay(page);
      return;
    }
    startTextInput(page, pt);
    return;
  }

  if (state.tool === "select") {
    const hit = hitTest(page.id, pt);
    state.selectedId = hit ? hit.id : null;
    if (hit) beginAnnDrag(hit, pt, overlay, event);
    drawOverlay(page);
    return;
  }

  if (state.tool === "eraser") {
    overlay.setPointerCapture(event.pointerId);
    state.eraserStroke = false;
    eraseAt(page.id, pt);
    return;
  }

  overlay.setPointerCapture(event.pointerId);
  if (state.tool === "pen") {
    state.draft = {
      id: uid(),
      type: "pen",
      pageId: page.id,
      color: state.color,
      strokeWidth: 2.2,
      points: [pt],
    };
  } else if (state.tool === "highlight" || state.tool === "rect" || state.tool === "ocr") {
    state.draft = {
      id: uid(),
      type: state.tool,
      pageId: page.id,
      color: state.tool === "ocr" ? "#2563eb" : state.color,
      strokeWidth: 1.5,
      x: pt.x,
      y: pt.y,
      width: 0,
      height: 0,
      origin: pt,
    };
  }
  drawOverlay(page);
}

function beginAnnDrag(hit, pt, overlay, event) {
  state.selectedId = hit.id;
  state.drag = { id: hit.id, lastX: pt.x, lastY: pt.y, moved: false };
  overlay.setPointerCapture(event.pointerId);
  document.body.classList.add("is-dragging");
}

function onPointerMove(event, page) {
  const pt = eventToPdf(event, page);

  if (state.tool === "eraser" && event.buttons === 1) {
    eraseAt(page.id, pt);
    return;
  }

  if (state.drag) {
    const dx = pt.x - state.drag.lastX;
    const dy = pt.y - state.drag.lastY;
    if (!state.drag.moved) {
      if (Math.hypot(dx, dy) < 1.5) return;
      pushHistory();
      state.drag.moved = true;
    }
    const ann = state.annotations.find((a) => a.id === state.drag.id);
    if (ann) {
      moveAnnotation(ann, dx, dy);
      state.drag.lastX = pt.x;
      state.drag.lastY = pt.y;
      drawOverlay(page);
    }
    return;
  }

  if (!state.draft || state.draft.pageId !== page.id) return;

  if (state.draft.type === "pen") {
    state.draft.points.push(pt);
  } else if (state.draft.origin) {
    const rect = normRect(state.draft.origin.x, state.draft.origin.y, pt.x, pt.y);
    Object.assign(state.draft, rect);
  }
  drawOverlay(page);
}

function onPointerUp(event, page, overlay) {
  if (overlay.hasPointerCapture?.(event.pointerId)) {
    overlay.releasePointerCapture(event.pointerId);
  }
  document.body.classList.remove("is-dragging");
  state.drag = null;
  state.eraserStroke = false;

  const draft = state.draft;
  if (!draft || draft.pageId !== page.id) return;
  state.draft = null;

  if (draft.type === "pen") {
    if (draft.points.length > 1) {
      pushHistory();
      state.annotations.push(draft);
    }
  } else if (draft.type === "ocr") {
    if (draft.width > 6 && draft.height > 6) recognizeAndCopy(page, draft);
  } else if (draft.width > 2 && draft.height > 2) {
    delete draft.origin;
    pushHistory();
    state.annotations.push(draft);
  }
  drawOverlay(page);
}

function eraseAt(pageId, pt) {
  const hit = hitTest(pageId, pt);
  if (!hit) return;
  if (!state.eraserStroke) {
    pushHistory();
    state.eraserStroke = true;
  }
  state.annotations = state.annotations.filter((a) => a.id !== hit.id);
  if (state.selectedId === hit.id) state.selectedId = null;
  drawOverlay(pageById(pageId));
}

function startTextInput(page, pt) {
  const wrap = document.getElementById(`view-${page.id}`);
  const existing = wrap.querySelector(".text-editor");
  if (existing) existing.remove();

  const editor = document.createElement("textarea");
  editor.className = "text-editor";
  editor.rows = 1;
  editor.placeholder = "텍스트 입력";
  editor.style.left = `${pt.x * state.zoom}px`;
  editor.style.top = `${pt.y * state.zoom}px`;
  editor.style.color = state.color;
  editor.style.fontSize = `${14 * state.zoom}px`;
  wrap.appendChild(editor);
  editor.focus();

  const commit = () => {
    const text = editor.value.replace(/\s+$/, "");
    editor.remove();
    if (!text) return;
    const lines = text.split("\n");
    const fontSize = 14;
    const width = Math.max(
      ...lines.map((line) => measureText(line, fontSize)),
      12
    );
    pushHistory();
    state.annotations.push({
      id: uid(),
      type: "text",
      pageId: page.id,
      x: pt.x,
      y: pt.y,
      width,
      height: lines.length * fontSize * 1.35,
      text,
      color: state.color,
      fontSize,
    });
    drawOverlay(page);
  };

  editor.addEventListener("blur", commit);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      editor.value = "";
      editor.blur();
    }
  });
}

function measureText(text, fontSize) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px "Noto Sans KR", sans-serif`;
  return ctx.measureText(text).width;
}

async function loadFontBytes() {
  if (state.fontBytes) return state.fontBytes;
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error("한글 폰트를 불러오지 못했습니다.");
  state.fontBytes = await res.arrayBuffer();
  return state.fontBytes;
}

async function buildPdfBytes() {
  const src = await PDFLib.PDFDocument.load(state.originalBytes);
  const out = await PDFLib.PDFDocument.create();
  if (window.fontkit) out.registerFontkit(window.fontkit);

  const indices = state.pages.map((p) => p.originalIndex - 1);
  const copied = await out.copyPages(src, indices);
  copied.forEach((p) => out.addPage(p));

  const needsFont = state.annotations.some((a) => a.type === "text");
  let font = null;
  if (needsFont) {
    const bytes = await loadFontBytes();
    font = await out.embedFont(bytes, { subset: true });
  }

  state.pages.forEach((meta, i) => {
    const pdfPage = out.getPage(i);
    const { width, height } = pdfPage.getSize();
    for (const ann of annotationsFor(meta.id)) {
      paintPdfAnnotation(pdfPage, ann, width, height, font);
    }
  });

  return out.save();
}

async function exportPdf() {
  if (!state.originalBytes || !state.pages.length) return;
  setStatus("저장하는 중…");
  setDocButtons(false);

  try {
    const bytes = await buildPdfBytes();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const a = document.createElement("a");
    const base = state.fileName.replace(/\.pdf$/i, "");
    a.href = URL.createObjectURL(blob);
    a.download = `${base}-edited.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("저장했습니다.");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "저장에 실패했습니다.");
  } finally {
    setDocButtons(true);
  }
}

async function printPdf() {
  if (!state.originalBytes || !state.pages.length) return;
  setStatus("인쇄 준비 중…");
  setDocButtons(false);

  try {
    const bytes = await buildPdfBytes();
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    document.querySelector(".print-frame")?.remove();
    const iframe = document.createElement("iframe");
    iframe.className = "print-frame";
    iframe.src = url;
    document.body.appendChild(iframe);

    const done = () => {
      URL.revokeObjectURL(url);
      iframe.remove();
    };
    let printed = false;
    const triggerPrint = () => {
      if (printed) return;
      printed = true;
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    };
    iframe.addEventListener("load", () => {
      iframe.contentWindow?.addEventListener("afterprint", done);
      setTimeout(triggerPrint, 250);
    });
    setTimeout(triggerPrint, 1500);
    iframe.contentWindow?.addEventListener("afterprint", done);
    setTimeout(done, 120000);
    setStatus("인쇄 대화 상자를 열었습니다.");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "인쇄에 실패했습니다.");
  } finally {
    setDocButtons(true);
  }
}

function paintPdfAnnotation(pdfPage, ann, pageWidth, pageHeight, font) {
  const color = hexToRgb01(ann.color || "#000000");
  const rgb = PDFLib.rgb(color.r, color.g, color.b);

  if (ann.type === "highlight") {
    pdfPage.drawRectangle({
      x: ann.x,
      y: toPdfLibY(ann.y, pageHeight, ann.height),
      width: ann.width,
      height: ann.height,
      color: rgb,
      opacity: 0.38,
      borderWidth: 0,
    });
  } else if (ann.type === "rect") {
    pdfPage.drawRectangle({
      x: ann.x,
      y: toPdfLibY(ann.y, pageHeight, ann.height),
      width: ann.width,
      height: ann.height,
      borderColor: rgb,
      borderWidth: ann.strokeWidth || 1.5,
    });
  } else if (ann.type === "text" && font) {
    const size = ann.fontSize || 14;
    const lines = String(ann.text || "").split("\n");
    lines.forEach((line, i) => {
      const top = ann.y + i * size * 1.35;
      pdfPage.drawText(line, {
        x: ann.x,
        y: toPdfLibY(top, pageHeight, size * 0.9),
        size,
        font,
        color: rgb,
      });
    });
  } else if (ann.type === "pen") {
    for (let i = 1; i < ann.points.length; i += 1) {
      const a = ann.points[i - 1];
      const b = ann.points[i];
      pdfPage.drawLine({
        start: { x: a.x, y: toPdfLibY(a.y, pageHeight) },
        end: { x: b.x, y: toPdfLibY(b.y, pageHeight) },
        thickness: ann.strokeWidth || 2.2,
        color: rgb,
        lineCap: PDFLib.LineCapStyle.Round,
      });
    }
  }
}

async function setZoom(next) {
  const clamped = ZOOMS.includes(next)
    ? next
    : ZOOMS.reduce((best, z) => (Math.abs(z - next) < Math.abs(best - next) ? z : best));
  state.zoom = clamped;
  els.zoomLabel.textContent = `${Math.round(clamped * 100)}%`;
  finishTextEditor();
  for (const page of state.pages) {
    await renderPage(page);
  }
}

function onKeyDown(event) {
  if (event.target.matches("textarea, input")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
    event.preventDefault();
    printPdf();
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && state.selectedId) {
    const id = state.selectedId;
    const ann = state.annotations.find((a) => a.id === id);
    if (!ann) return;
    pushHistory();
    state.annotations = state.annotations.filter((a) => a.id !== id);
    state.selectedId = null;
    drawOverlay(pageById(ann.pageId));
  }
}

function textInRect(page, rect) {
  const items = (page.textItems || []).filter((item) => {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    return (
      cx >= rect.x &&
      cx <= rect.x + rect.width &&
      cy >= rect.y &&
      cy <= rect.y + rect.height
    );
  });
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  let out = "";
  let lastY = null;
  for (const item of items) {
    if (lastY != null && item.y - lastY > Math.max(item.height, 8) * 0.7) out += "\n";
    else if (out && !out.endsWith("\n")) out += " ";
    out += item.str;
    lastY = item.y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/ +/g, " ").trim();
}

function cropPageRegion(page, rect) {
  const wrap = document.getElementById(`view-${page.id}`);
  const src = wrap?.querySelector(".pdf-canvas");
  if (!src) return null;
  const dpr = window.devicePixelRatio || 1;
  const scale = state.zoom * dpr;
  const sx = Math.max(0, rect.x * scale);
  const sy = Math.max(0, rect.y * scale);
  const sw = Math.min(src.width - sx, rect.width * scale);
  const sh = Math.min(src.height - sy, rect.height * scale);
  if (sw < 2 || sh < 2) return null;
  const out = document.createElement("canvas");
  const boost = Math.max(1, 2 / Math.max(state.zoom, 0.5));
  out.width = Math.max(1, Math.round(sw * boost));
  out.height = Math.max(1, Math.round(sh * boost));
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

async function getOcrWorker() {
  if (state.ocrWorker) return state.ocrWorker;
  if (typeof Tesseract === "undefined") {
    throw new Error("OCR 라이브러리를 불러오지 못했습니다.");
  }
  setStatus("OCR 엔진 준비 중…");
  state.ocrWorker = await Tesseract.createWorker("kor+eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        setStatus(`OCR ${Math.round((m.progress || 0) * 100)}%`);
      }
    },
  });
  return state.ocrWorker;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    els.ocrText.focus();
    els.ocrText.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

function showOcrResult(text) {
  els.ocrText.value = text;
  els.ocrPanel.hidden = false;
}

async function recognizeAndCopy(page, rect) {
  if (state.ocrBusy) return;
  state.ocrBusy = true;
  try {
    let text = textInRect(page, rect);
    let viaOcr = false;
    if (!text) {
      const image = cropPageRegion(page, rect);
      if (!image) {
        setStatus("선택한 영역이 너무 작습니다.");
        return;
      }
      const worker = await getOcrWorker();
      const result = await worker.recognize(image);
      text = (result?.data?.text || "").replace(/[ \t]+\n/g, "\n").trim();
      viaOcr = true;
    }
    if (!text) {
      setStatus("글자를 찾지 못했습니다. 영역을 넓히거나 확대해 보세요.");
      return;
    }
    showOcrResult(text);
    const copied = await copyText(text);
    setStatus(
      copied
        ? viaOcr
          ? "OCR 결과를 복사했습니다."
          : "선택한 글자를 복사했습니다."
        : "아래 상자에서 복사하세요."
    );
  } catch (err) {
    console.error(err);
    setStatus(err.message || "OCR에 실패했습니다.");
  } finally {
    state.ocrBusy = false;
  }
}

function renderMergeList() {
  els.mergeList.replaceChildren();
  state.mergeFiles.forEach((file, index) => {
    const li = document.createElement("li");
    li.className = "merge-item";
    li.draggable = true;
    li.dataset.id = file.id;

    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${file.name}`;

    const del = document.createElement("button");
    del.type = "button";
    del.title = "제거";
    del.textContent = "×";
    del.addEventListener("click", () => {
      state.mergeFiles = state.mergeFiles.filter((f) => f.id !== file.id);
      renderMergeList();
    });

    li.append(label, del);
    li.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", file.id);
      event.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (event) => {
      event.preventDefault();
      li.classList.add("drag-over");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
    li.addEventListener("drop", (event) => {
      event.preventDefault();
      li.classList.remove("drag-over");
      reorderMergeFiles(event.dataTransfer.getData("text/plain"), file.id);
    });
    els.mergeList.appendChild(li);
  });
}

function reorderMergeFiles(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const from = state.mergeFiles.findIndex((f) => f.id === fromId);
  const to = state.mergeFiles.findIndex((f) => f.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = state.mergeFiles.splice(from, 1);
  state.mergeFiles.splice(to, 0, moved);
  renderMergeList();
}

async function addMergeFiles(files) {
  for (const file of files) {
    if (!isPdfFile(file)) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.mergeFiles.push({
      id: uid(),
      name: file.name || "document.pdf",
      bytes,
    });
  }
  renderMergeList();
}

function openMergeDialog() {
  if (!state.mergeFiles.length && state.originalBytes) {
    state.mergeFiles.push({
      id: uid(),
      name: state.fileName,
      bytes: state.originalBytes.slice(),
    });
  }
  renderMergeList();
  els.mergeDialog.showModal();
}

async function mergeAndOpen() {
  if (state.mergeFiles.length < 2) {
    setStatus("병합하려면 PDF를 2개 이상 넣으세요.");
    return;
  }
  els.mergeRun.disabled = true;
  setStatus("병합하는 중…");
  try {
    const out = await PDFLib.PDFDocument.create();
    for (const file of state.mergeFiles) {
      const src = await PDFLib.PDFDocument.load(file.bytes);
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach((page) => out.addPage(page));
    }
    const bytes = await out.save();
    const name = state.mergeFiles[0].name.replace(/\.pdf$/i, "") + "-merged.pdf";
    els.mergeDialog.close();
    state.mergeFiles = [];
    await openPdfBytes(bytes, name);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "병합에 실패했습니다.");
  } finally {
    els.mergeRun.disabled = false;
  }
}

function bindUi() {
  document.body.dataset.tool = state.tool;

  els.fileInput.addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (files.length > 1) {
      state.mergeFiles = [];
      await addMergeFiles(files);
      openMergeDialog();
      return;
    }
    openFile(files[0]);
  });

  document.querySelectorAll(".btn.tool").forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });

  els.colorInput.addEventListener("input", () => {
    state.color = els.colorInput.value;
    TOOL_COLORS[state.tool] = state.color;
  });

  els.zoomIn.addEventListener("click", () => {
    const i = ZOOMS.indexOf(state.zoom);
    if (i < ZOOMS.length - 1) setZoom(ZOOMS[i + 1]);
  });
  els.zoomOut.addEventListener("click", () => {
    const i = ZOOMS.indexOf(state.zoom);
    if (i > 0) setZoom(ZOOMS[i - 1]);
  });

  els.saveBtn.addEventListener("click", exportPdf);
  els.printBtn.addEventListener("click", printPdf);
  els.mergeBtn.addEventListener("click", openMergeDialog);
  els.mergeClose.addEventListener("click", () => els.mergeDialog.close());
  els.mergeRun.addEventListener("click", mergeAndOpen);
  els.mergeInput.addEventListener("change", async (event) => {
    await addMergeFiles([...(event.target.files || [])]);
    event.target.value = "";
  });
  els.ocrCopy.addEventListener("click", () => copyText(els.ocrText.value));
  els.ocrClose.addEventListener("click", () => {
    els.ocrPanel.hidden = true;
  });
  document.addEventListener("keydown", onKeyDown);

  ["dragenter", "dragover"].forEach((type) => {
    els.viewer.addEventListener(type, (event) => {
      event.preventDefault();
      els.viewer.classList.add("drop-target");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    els.viewer.addEventListener(type, (event) => {
      event.preventDefault();
      els.viewer.classList.remove("drop-target");
    });
  });
  els.viewer.addEventListener("drop", async (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter(isPdfFile);
    if (files.length > 1) {
      state.mergeFiles = [];
      await addMergeFiles(files);
      openMergeDialog();
      return;
    }
    if (files[0]) openFile(files[0]);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAutosave();
  });
  window.addEventListener("pagehide", flushAutosave);
}

bindUi();
restoreDraft();
