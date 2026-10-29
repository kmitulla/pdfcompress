// A4-Bereich auf der Glasfläche einrichten.
//
// Ein Testscan zeigt die ganze Glasfläche; darauf liegt ein Rahmen in exakt
// DIN-A4-Proportion (210 : 297, gesperrt). Verschieben per Ziehen, Skalieren
// über die Ecken (die gegenüberliegende Ecke bleibt stehen), Feinschieben in
// Millimeterschritten. Vier Lupen zeigen die Ecken stark vergrößert – so sieht
// man genau, ob der Rahmen auf der Papierkante sitzt.

import { $, $$, toast, confirmDialog } from './ui.js';

const RATIO = 297 / 210;          // Höhe / Breite
const DEFAULT_BED = { w: 215.9, h: 297 };
const STEPS = [0.1, 0.5, 1, 5];
const MIN_W = 150;
const SNAP = 0.8;                 // mm – an der Glaskante einrasten

const st = {
  open: false,
  opts: null,
  bed: { ...DEFAULT_BED },
  rect: { x: 0, y: 0, w: 210 },
  img: null,                       // HTMLImageElement des Testscans
  url: null,
  step: 0.5,
  drag: null,
  dirty: false,
};

const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v) => String(r1(v)).replace('.', ',');
const heightOf = (w) => w * RATIO;

function clampRect(r) {
  const w = clamp(r.w, MIN_W, Math.min(st.bed.w, st.bed.h / RATIO));
  const h = heightOf(w);
  return { x: clamp(r.x, 0, Math.max(0, st.bed.w - w)), y: clamp(r.y, 0, Math.max(0, st.bed.h - h)), w };
}

/** Rechteck für eine Anlegeecke (Größe bleibt). */
function rectForCorner(corner, w = st.rect.w) {
  const h = heightOf(w);
  return clampRect({
    x: corner === 'tr' || corner === 'br' ? st.bed.w - w : 0,
    y: corner === 'bl' || corner === 'br' ? st.bed.h - h : 0,
    w,
  });
}

/** Nächstgelegene Ecke – für die Anzeige „Ecke oben links“. */
export function nearestCorner(rect, bed = DEFAULT_BED) {
  const h = heightOf(rect.w);
  const right = rect.x + rect.w / 2 > bed.w / 2;
  const bottom = rect.y + h / 2 > bed.h / 2;
  return bottom ? (right ? 'br' : 'bl') : (right ? 'tr' : 'tl');
}

// ------------------------------------------------------------ Darstellung

function layout() {
  const stage = $('#calibStage');
  const wrap = $('#calibCanvasWrap');
  const pad = 24;
  const maxW = Math.max(120, stage.clientWidth - pad * 2);
  const maxH = Math.max(160, stage.clientHeight - pad * 2);
  const s = Math.min(maxW / st.bed.w, maxH / st.bed.h);
  wrap.style.width = `${Math.round(st.bed.w * s)}px`;
  wrap.style.height = `${Math.round(st.bed.h * s)}px`;
}

function render() {
  const svg = $('#calibSvg');
  const { w: bw, h: bh } = st.bed;
  const r = st.rect;
  const h = heightOf(r.w);
  svg.setAttribute('viewBox', `0 0 ${bw} ${bh}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const hs = Math.max(4, Math.min(bw, bh) * 0.03);   // Anfasser in mm
  const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + h], [r.x, r.y + h]];
  svg.innerHTML = `
    <path d="M0,0H${bw}V${bh}H0Z M${r.x},${r.y}h${r.w}v${h}h${-r.w}Z" fill="rgba(6,10,20,.5)" fill-rule="evenodd"/>
    <rect class="calib-rect" x="${r.x}" y="${r.y}" width="${r.w}" height="${h}" fill="rgba(79,123,255,.03)" stroke="#4f7bff" stroke-width="${hs * 0.12}" vector-effect="non-scaling-stroke"/>
    <g stroke="rgba(79,123,255,.55)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="4 4">
      <line x1="${r.x + r.w / 2}" y1="${r.y}" x2="${r.x + r.w / 2}" y2="${r.y + h}"/>
      <line x1="${r.x}" y1="${r.y + h / 2}" x2="${r.x + r.w}" y2="${r.y + h / 2}"/>
    </g>
    ${corners.map(([x, y], i) => `<g class="calib-handle" data-corner="${i}">
      <circle cx="${x}" cy="${y}" r="${hs * 2.4}" fill="transparent"/>
      <circle cx="${x}" cy="${y}" r="${hs * 0.9}" fill="rgba(79,123,255,.3)" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </g>`).join('')}`;
  const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = String(r1(v)); };
  set('#calibX', r.x);
  set('#calibY', r.y);
  set('#calibW', r.w);
  set('#calibH', h);
  const c = nearestCorner(r, st.bed);
  $$('#calibCorners button').forEach((b) => b.classList.toggle('active', b.dataset.corner === c));
  const exact = Math.abs(r.w - 210) < 0.05;
  $('#calibInfo').textContent = `Glasfläche ${fmt(st.bed.w)} × ${fmt(st.bed.h)} mm · Rahmen ${fmt(r.w)} × ${fmt(h)} mm${exact ? ' (exakt A4)' : ` (${r.w > 210 ? '+' : ''}${fmt((r.w / 210 - 1) * 100)} %)`}`;
  renderLoupes();
}

// Vier Lupen: je Ecke ±9 mm, stark vergrößert
function renderLoupes() {
  const box = $('#calibLoupes');
  if (!box) return;
  box.classList.toggle('hidden', !st.img);
  if (!st.img) return;
  const r = st.rect;
  const h = heightOf(r.w);
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + h], [r.x + r.w, r.y + h]];
  const pxPerMm = st.img.naturalWidth / st.bed.w;
  const span = 18;   // mm Ausschnitt
  box.querySelectorAll('canvas').forEach((cv, i) => {
    const [mx, my] = pts[i];
    const size = cv.width;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#1b1f2a';
    ctx.fillRect(0, 0, size, size);
    const sx = (mx - span / 2) * pxPerMm;
    const sy = (my - span / 2) * pxPerMm;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(st.img, sx, sy, span * pxPerMm, span * pxPerMm, 0, 0, size, size);
    // Rahmenkante einzeichnen
    const k = size / span;
    ctx.strokeStyle = '#4f7bff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const toX = (x) => (x - (mx - span / 2)) * k;
    const toY = (y) => (y - (my - span / 2)) * k;
    ctx.moveTo(toX(r.x), toY(r.y));
    ctx.lineTo(toX(r.x + r.w), toY(r.y));
    ctx.lineTo(toX(r.x + r.w), toY(r.y + h));
    ctx.lineTo(toX(r.x), toY(r.y + h));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(['oben links', 'oben rechts', 'unten links', 'unten rechts'][i], 6, size - 7);
  });
}

// ------------------------------------------------------------ Bedienung

function toMm(e) {
  const b = $('#calibSvg').getBoundingClientRect();
  return { x: ((e.clientX - b.left) / b.width) * st.bed.w, y: ((e.clientY - b.top) / b.height) * st.bed.h };
}

function snapMove(r) {
  const h = heightOf(r.w);
  let { x, y } = r;
  if (Math.abs(x) < SNAP) x = 0;
  if (Math.abs(y) < SNAP) y = 0;
  if (Math.abs(st.bed.w - (x + r.w)) < SNAP) x = st.bed.w - r.w;
  if (Math.abs(st.bed.h - (y + h)) < SNAP) y = st.bed.h - h;
  return { ...r, x, y };
}

function onDown(e) {
  if (e.button > 0) return;
  const p = toMm(e);
  const handle = e.target.closest('.calib-handle');
  const r = st.rect;
  const h = heightOf(r.w);
  if (handle) {
    const i = Number(handle.dataset.corner);
    // gegenüberliegende Ecke bleibt fest
    const ax = i === 0 || i === 3 ? r.x + r.w : r.x;
    const ay = i === 0 || i === 1 ? r.y + h : r.y;
    st.drag = { type: 'scale', ax, ay, sx: i === 0 || i === 3 ? -1 : 1, sy: i === 0 || i === 1 ? -1 : 1 };
  } else if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + h) {
    st.drag = { type: 'move', dx: p.x - r.x, dy: p.y - r.y };
  } else {
    return;
  }
  e.preventDefault();
  $('#calibSvg').setPointerCapture?.(e.pointerId);
}

function onMove(e) {
  if (!st.drag) return;
  e.preventDefault();
  const p = toMm(e);
  const d = st.drag;
  if (d.type === 'move') {
    st.rect = clampRect(snapMove({ ...st.rect, x: p.x - d.dx, y: p.y - d.dy }));
  } else {
    // Größe aus der Richtung bestimmen, die weiter gezogen wurde
    const w1 = Math.max(0, (p.x - d.ax) * d.sx);
    const w2 = Math.max(0, ((p.y - d.ay) * d.sy) / RATIO);
    const maxW = Math.min(d.sx > 0 ? st.bed.w - d.ax : d.ax, (d.sy > 0 ? st.bed.h - d.ay : d.ay) / RATIO);
    const w = clamp(Math.max(w1, w2), MIN_W, maxW);
    const h = heightOf(w);
    st.rect = clampRect({ x: d.sx > 0 ? d.ax : d.ax - w, y: d.sy > 0 ? d.ay : d.ay - h, w });
  }
  st.dirty = true;
  render();
}

function onUp() {
  st.drag = null;
}

function nudge(dx, dy) {
  st.rect = clampRect({ ...st.rect, x: st.rect.x + dx * st.step, y: st.rect.y + dy * st.step });
  st.dirty = true;
  render();
}

function onField(e) {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  if (!Number.isFinite(v)) return;
  const r = { ...st.rect };
  if (e.target.id === 'calibX') r.x = v;
  if (e.target.id === 'calibY') r.y = v;
  if (e.target.id === 'calibW') r.w = v;
  // Höhe ändern → Breite folgt (Seitenverhältnis gesperrt)
  if (e.target.id === 'calibH') r.w = v / RATIO;
  st.rect = clampRect(r);
  st.dirty = true;
  render();
}

async function testScan() {
  const btn = $('#calibScanBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.querySelector('span').textContent = 'Scanne …';
  try {
    const file = await st.opts.scan();
    await showScan(file);
    toast('Testscan da – Rahmen auf die Papierkanten legen', 'ok', 3500);
  } catch (e) {
    toast(`Testscan fehlgeschlagen: ${e?.message || e}`, 'err', 7000);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.querySelector('span').textContent = st.img ? 'Neuer Testscan' : 'Testscan';
  }
}

async function showScan(file) {
  if (st.url) URL.revokeObjectURL(st.url);
  st.url = URL.createObjectURL(file);
  const img = $('#calibImg');
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Bild nicht lesbar'));
    img.src = st.url;
  });
  const dpi = file.scanDpi || 300;
  const bed = { w: (img.naturalWidth / dpi) * 25.4, h: (img.naturalHeight / dpi) * 25.4 };
  if (bed.w > bed.h * 1.05) {
    toast('Der Scan ist im Querformat – die Einrichtung gilt für Hochformat-Glasflächen', 'info', 6000);
  }
  st.bed = { w: r1(bed.w), h: r1(bed.h) };
  st.img = img;
  st.rect = clampRect(st.rect);
  $('#calibEmpty').classList.add('hidden');
  img.classList.remove('hidden');
  layout();
  render();
}

function close() {
  st.open = false;
  $('#calib').hidden = true;
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
}

async function requestClose() {
  if (st.dirty && !(await confirmDialog('Änderungen verwerfen?', 'Der A4-Bereich wurde verändert, aber nicht gespeichert.', 'Verwerfen', 'danger'))) return;
  close();
}

function onKey(e) {
  if (document.querySelector('.dlg-wrap')) return;
  if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
  if (e.target.tagName === 'INPUT') return;
  const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (mv) { e.preventDefault(); nudge(...mv); }
}

const onResize = () => { layout(); render(); };

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  const svg = $('#calibSvg');
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  $('#calibClose').addEventListener('click', requestClose);
  $('#calibScanBtn').addEventListener('click', testScan);
  $('#calibReset').addEventListener('click', () => {
    st.rect = rectForCorner(nearestCorner(st.rect, st.bed), 210);
    st.dirty = true;
    render();
  });
  $('#calibCorners').addEventListener('click', (e) => {
    const b = e.target.closest('[data-corner]');
    if (!b) return;
    st.rect = rectForCorner(b.dataset.corner);
    st.dirty = true;
    render();
  });
  $('#calibNudge').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nudge]');
    if (b) nudge(...b.dataset.nudge.split(',').map(Number));
  });
  $('#calibStepLabel').addEventListener('click', () => {
    st.step = STEPS[(STEPS.indexOf(st.step) + 1) % STEPS.length];
    $('#calibStepLabel').textContent = `${fmt(st.step)} mm`;
  });
  ['#calibX', '#calibY', '#calibW', '#calibH'].forEach((id) => $(id).addEventListener('change', onField));
  $('#calibSave').addEventListener('click', () => {
    st.opts.save({ x: r1(st.rect.x), y: r1(st.rect.y), w: r1(st.rect.w) }, nearestCorner(st.rect, st.bed), st.bed);
    st.dirty = false;
    close();
  });
}

/**
 * @param opts.rect   gespeicherter Bereich {x,y,w} oder null
 * @param opts.corner Anlegeecke, falls noch nichts kalibriert ist
 * @param opts.offX/offY bisheriger Versatz in mm
 * @param opts.bed    bekannte Glasfläche {w,h} in mm (aus den Scannerdaten)
 * @param opts.scan   () => Promise<File mit scanDpi> – Testscan
 * @param opts.save   (rect, corner, bed) => void
 */
export function openCalibration(opts) {
  wire();
  st.opts = opts;
  st.open = true;
  st.dirty = false;
  if (opts.bed?.w && opts.bed?.h && !st.img) st.bed = { w: opts.bed.w, h: opts.bed.h };
  if (opts.rect?.w) {
    st.rect = clampRect(opts.rect);
  } else {
    const base = rectForCorner(opts.corner || 'tl', 210);
    st.rect = clampRect({ ...base, x: base.x + (Number(opts.offX) || 0), y: base.y + (Number(opts.offY) || 0) });
  }
  $('#calib').hidden = false;
  $('#calibEmpty').classList.toggle('hidden', !!st.img);
  $('#calibImg').classList.toggle('hidden', !st.img);
  $('#calibStepLabel').textContent = `${fmt(st.step)} mm`;
  $('#calibScanBtn').querySelector('span').textContent = st.img ? 'Neuer Testscan' : 'Testscan';
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  requestAnimationFrame(() => { layout(); render(); });
}

// Für die Tests
window.__calib = { st, showScan, nearestCorner, rectForCorner };
