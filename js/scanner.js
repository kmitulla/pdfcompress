// Dokumenten-Scanner: Kamera (mit optionalem Blitz) oder Bilddateien,
// automatische Rand-/Eckenerkennung mit manueller Korrektur (inkl. Lupe),
// Perspektivkorrektur, A4-/Auto-Format, Drehen – Ergebnis wird als PDF an
// die Dateiliste übergeben, wo Kompressionsstufe & „Scan-Stil“ gewählt werden.

import { hydrateIcons, icon } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);

const DETECT_MAX = 440;      // Analysebreite für die Eckenerkennung
const IMPORT_MAX = 3200;     // längste Kante beim Einlesen von Fotos
const OUTPUT_MAX = 2800;     // längste Kante des entzerrten Scans
const A4_PT = [595.28, 841.89];

// ---------------------------------------------------------------- Bildanalyse

function toGray(data, n) {
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
  }
  return gray;
}

// separierter 3x3-Boxblur
function boxBlur(src, w, h) {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = row + Math.max(0, x - 1);
      const r = row + Math.min(w - 1, x + 1);
      tmp[row + x] = (src[l] + src[row + x] + src[r]) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const dn = Math.min(h - 1, y + 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      out[row + x] = (tmp[up + x] + tmp[row + x] + tmp[dn + x]) / 3;
    }
  }
  return out;
}

function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Größte zusammenhängende Fläche einer Binärmaske (4er-Nachbarschaft)
function largestComponent(mask, w, h) {
  const labels = new Int32Array(mask.length);
  const stack = new Int32Array(mask.length);
  let nextLabel = 0;
  let bestLabel = -1;
  let bestArea = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    nextLabel++;
    let top = 0;
    stack[top++] = start;
    labels[start] = nextLabel;
    let area = 0;
    while (top > 0) {
      const i = stack[--top];
      area++;
      const x = i % w;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = nextLabel; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = nextLabel; stack[top++] = i + 1; }
      if (i >= w && mask[i - w] && !labels[i - w]) { labels[i - w] = nextLabel; stack[top++] = i - w; }
      if (i < mask.length - w && mask[i + w] && !labels[i + w]) { labels[i + w] = nextLabel; stack[top++] = i + w; }
    }
    if (area > bestArea) { bestArea = area; bestLabel = nextLabel; }
  }
  return { labels, bestLabel, bestArea };
}

// Konvexe Hülle (Andrew Monotone Chain)
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

// Viereck mit maximaler Fläche aus den Hüllpunkten (Brute-Force auf ≤ 28 Punkten)
function maxAreaQuad(hull) {
  let pts = hull;
  if (pts.length > 28) {
    pts = [];
    for (let i = 0; i < 28; i++) pts.push(hull[Math.floor((i * hull.length) / 28)]);
  }
  const m = pts.length;
  if (m < 4) return null;
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < m - 3; i++) {
    for (let j = i + 1; j < m - 2; j++) {
      for (let k = j + 1; k < m - 1; k++) {
        for (let l = k + 1; l < m; l++) {
          const quad = [pts[i], pts[j], pts[k], pts[l]];
          const area = polyArea(quad);
          if (area > bestArea) { bestArea = area; best = quad; }
        }
      }
    }
  }
  return best ? { corners: best, area: bestArea } : null;
}

function quadFromMask(mask, w, h) {
  const { labels, bestLabel, bestArea } = largestComponent(mask, w, h);
  const total = w * h;
  if (bestLabel < 0 || bestArea < total * 0.1 || bestArea > total * 0.985) return null;
  // Randpixel der Fläche einsammeln
  const boundary = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== bestLabel) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1
        || labels[i - 1] !== bestLabel || labels[i + 1] !== bestLabel
        || labels[i - w] !== bestLabel || labels[i + w] !== bestLabel) {
        boundary.push({ x, y });
      }
    }
  }
  const hull = convexHull(boundary);
  const quad = maxAreaQuad(hull);
  if (!quad) return null;
  const hullArea = polyArea(hull);
  if (quad.area < total * 0.1 || quad.area > total * 0.985) return null;
  if (hullArea > 0 && quad.area < hullArea * 0.65) return null; // Fläche ist kein Viereck
  // degenerierte Vierecke (sehr kurze Seite) verwerfen
  const minSide = Math.min(w, h) * 0.08;
  for (let i = 0; i < 4; i++) {
    const a = quad.corners[i];
    const b = quad.corners[(i + 1) % 4];
    if (Math.hypot(a.x - b.x, a.y - b.y) < minSide) return null;
  }
  return quad;
}

/** Ecken in die Reihenfolge oben-links, oben-rechts, unten-rechts, unten-links bringen */
export function orderCorners(pts) {
  const bySum = pts.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = pts.slice().sort((a, b) => (a.x - a.y) - (b.x - b.y));
  return [bySum[0], byDiff[3], bySum[3], byDiff[0]];
}

/**
 * Erkennt die Dokumentecken in einem (verkleinerten) Bild.
 * Rückgabe: 4 normierte Ecken (0..1) in Reihenfolge TL, TR, BR, BL – oder null.
 */
export function detectDocumentCorners(imageData) {
  const { width: w, height: h, data } = imageData;
  const n = w * h;
  const gray = boxBlur(toGray(data, n), w, h);
  const thr = otsuThreshold(gray);
  const bright = new Uint8Array(n);
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (gray[i] > thr) bright[i] = 1; else dark[i] = 1;
  }
  // Zwei Hypothesen: Dokument heller bzw. dunkler als der Hintergrund
  let best = null;
  for (const mask of [bright, dark]) {
    const quad = quadFromMask(mask, w, h);
    if (quad && (!best || quad.area > best.area)) best = quad;
  }
  if (!best) return null;
  return orderCorners(best.corners).map((p) => ({
    x: Math.min(1, Math.max(0, p.x / (w - 1))),
    y: Math.min(1, Math.max(0, p.y / (h - 1))),
  }));
}

/** Auto-Erkennung auf einem beliebig großen Canvas (intern verkleinert) */
export function detectCornersOnCanvas(canvas) {
  const scale = Math.min(1, DETECT_MAX / Math.max(canvas.width, canvas.height));
  const w = Math.max(2, Math.round(canvas.width * scale));
  const h = Math.max(2, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  return detectDocumentCorners(ctx.getImageData(0, 0, w, h));
}

function defaultCorners(margin = 0.04) {
  return [
    { x: margin, y: margin },
    { x: 1 - margin, y: margin },
    { x: 1 - margin, y: 1 - margin },
    { x: margin, y: 1 - margin },
  ];
}

// -------------------------------------------------------- Perspektivkorrektur

// Projektive Abbildung Einheitsquadrat -> Viereck (Heckbert)
function squareToQuadCoeffs([p0, p1, p2, p3]) {
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return {
      a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x,
      d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y,
      g: 0, h: 0,
    };
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g, h,
  };
}

/**
 * Entzerrt das durch 4 normierte Ecken (TL,TR,BR,BL) beschriebene Viereck
 * aus srcCanvas in ein outW×outH-Canvas (bilineare Interpolation).
 */
export function warpPerspective(srcCanvas, corners, outW, outH) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, sw, sh).data;
  const quadPx = corners.map((p) => ({ x: p.x * (sw - 1), y: p.y * (sh - 1) }));
  const { a, b, c, d, e, f, g, h } = squareToQuadCoeffs(quadPx);

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  const img = octx.createImageData(outW, outH);
  const dst = img.data;

  for (let j = 0; j < outH; j++) {
    const v = outH > 1 ? j / (outH - 1) : 0;
    for (let i = 0; i < outW; i++) {
      const u = outW > 1 ? i / (outW - 1) : 0;
      const den = g * u + h * v + 1;
      let x = (a * u + b * v + c) / den;
      let y = (d * u + e * v + f) / den;
      if (x < 0) x = 0; else if (x > sw - 1) x = sw - 1;
      if (y < 0) y = 0; else if (y > sh - 1) y = sh - 1;
      const x0 = x | 0;
      const y0 = y | 0;
      const x1 = x0 < sw - 1 ? x0 + 1 : x0;
      const y1 = y0 < sh - 1 ? y0 + 1 : y0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const o = (j * outW + i) * 4;
      dst[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      dst[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      dst[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      dst[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Zielgröße des entzerrten Scans in Pixeln – immer im echten Seitenverhältnis
 * des Vierecks. Das A4-Format bestimmt nur die PDF-Seite; der Scan selbst wird
 * nie verzerrt (außer man aktiviert ausdrücklich „auf A4 strecken“).
 */
export function outputSize(srcW, srcH, corners) {
  const px = corners.map((p) => ({ x: p.x * srcW, y: p.y * srcH }));
  const quadW = Math.max(dist(px[0], px[1]), dist(px[3], px[2]));
  const quadH = Math.max(dist(px[0], px[3]), dist(px[1], px[2]));
  const scale = Math.min(1.2, OUTPUT_MAX / Math.max(quadW, quadH));
  return {
    w: Math.max(8, Math.round(quadW * scale)),
    h: Math.max(8, Math.round(quadH * scale)),
  };
}

/** Weiße Radier-Striche (normierte Koordinaten) auf ein Canvas anwenden */
export function applyErase(canvas, strokes) {
  if (!strokes?.length) return canvas;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    const width = Math.max(1, s.size * canvas.width);
    if (s.points.length === 1) {
      ctx.beginPath();
      ctx.arc(s.points[0].x * canvas.width, s.points[0].y * canvas.height, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineWidth = width;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = p.x * canvas.width;
        const y = p.y * canvas.height;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
  return canvas;
}

function rotateCanvas90(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext('2d');
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

// ---------------------------------------------------------------- Scanner-UI

const state = {
  root: null,
  onDone: null,
  pages: [],        // {src, corners, format}
  queue: [],        // Canvases, die noch zugeschnitten werden müssen
  editing: null,    // {src, corners, format, pageIndex} – aktueller Zuschnitt
  cropReturn: 'capture',
  lastFormat: 'auto',
  lastStretch: false,
  erasing: null,    // {pageIndex, backup, undo, redo, base, drawing}
  stream: null,
  torchOn: false,
  liveTimer: null,
  drag: null,
  activeHandle: null,
  building: false,
};

const TEMPLATE = `
<div class="sc-overlay" role="dialog" aria-modal="true" aria-label="Dokument scannen">
  <div class="sc-topbar">
    <strong><i data-icon="scanFrame"></i> Dokument scannen</strong>
    <span class="sc-pagecount" id="scPageCount"></span>
    <button class="btn btn-small hidden" id="scBatchStopBtn" hidden><i data-icon="close" data-icon-size="15"></i> Stapel stoppen</button>
    <button class="btn btn-small btn-ghost" id="scCloseBtn"><i data-icon="close" data-icon-size="15"></i> Schließen</button>
  </div>

  <!-- Aufnahme -->
  <div class="sc-view" id="scCaptureView">
    <div class="sc-video-wrap" id="scVideoWrap">
      <video id="scVideo" autoplay playsinline muted></video>
      <canvas id="scLiveOverlay"></canvas>
      <div class="sc-cam-msg hidden" id="scCamMsg"></div>
    </div>
    <p class="sc-hint">Dokument flach und vollständig ins Bild legen – die Ränder werden live erkannt und lassen sich danach fein anpassen.</p>
    <div class="sc-capture-bar">
      <button class="sc-round-btn" id="scTorchBtn" title="Blitz (Taschenlampe) an/aus" aria-pressed="false" hidden><i data-icon="bolt"></i></button>
      <button class="sc-shutter" id="scShutterBtn" title="Foto aufnehmen" aria-label="Foto aufnehmen"><span></span></button>
      <button class="sc-round-btn" id="scPickBtn" title="Bilder aus Dateien wählen"><i data-icon="image"></i></button>
    </div>
    <div class="sc-bottombar">
      <button class="btn" id="scNetScanBtn" hidden><i data-icon="scanner"></i> Seite vom Netzwerk-Scanner</button>
      <button class="btn" id="scToPagesBtn" hidden>Zu den Seiten <i data-icon="chevronRight" data-icon-size="15"></i></button>
    </div>
    <input type="file" id="scFileInput" accept="image/*" multiple hidden>
  </div>

  <!-- Zuschnitt -->
  <div class="sc-view hidden" id="scCropView">
    <div class="sc-toolbar">
      <span class="sc-tgroup">
        <span class="sc-tlabel">Auswahl</span>
        <button class="btn btn-small" id="scFullBtn" title="Das ganze Bild auswählen"><i data-icon="square" data-icon-size="15"></i> Alles</button>
        <button class="btn btn-small" id="scAutoBtn" title="Dokumentränder automatisch erkennen"><i data-icon="wand" data-icon-size="15"></i> Automatisch</button>
        <button class="btn btn-small hidden" id="scA4BedBtn" hidden title="A4-Bereich der Scannerfläche auswählen"><i data-icon="scanFrame" data-icon-size="15"></i> A4-Fläche</button>
        <button class="btn btn-small hidden" id="scA4CornerBtn" hidden title="Ecke wechseln, an der die Vorlage anliegt"><i data-icon="rotate" data-icon-size="15"></i> Ecke</button>
      </span>
      <span class="sc-sep"></span>
      <span class="sc-tgroup">
        <span class="sc-tlabel">Ausgabeformat</span>
        <span class="sc-seg" role="radiogroup" aria-label="Ausgabeformat">
          <button class="sc-seg-btn" data-format="auto" title="Format folgt der Auswahl">Auto</button>
          <button class="sc-seg-btn" data-format="a4p" title="Auswahl auf A4 hochkant ausgeben">A4 hoch</button>
          <button class="sc-seg-btn" data-format="a4l" title="Auswahl auf A4 quer ausgeben">A4 quer</button>
        </span>
        <label class="sc-check hidden" id="scStretchWrap" title="Auswahl auf das ganze A4-Blatt dehnen – verzerrt das Seitenverhältnis. Ohne Häkchen wird unverzerrt eingepasst.">
          <input type="checkbox" id="scStretch"> strecken
        </label>
      </span>
      <span class="sc-sep"></span>
      <button class="btn btn-small" id="scRotateBtn" title="Bild um 90° drehen"><i data-icon="rotate" data-icon-size="15"></i> Drehen</button>
    </div>
    <div class="sc-crop-stage" id="scCropStage">
      <canvas id="scCropCanvas"></canvas>
      <svg id="scCropSvg" tabindex="0" aria-label="Ecken anpassen (Pfeiltasten bewegen die zuletzt gewählte Ecke)"></svg>
      <div class="sc-loupe hidden" id="scLoupe"><canvas width="150" height="150"></canvas></div>
    </div>
    <p class="sc-hint">Ecken (● groß) oder Kanten (● klein) ziehen – die Lupe zeigt die Ecke vergrößert, damit du sie exakt triffst. Pfeiltasten justieren fein nach.</p>
    <div class="sc-bottombar">
      <button class="btn" id="scCropCancelBtn">Verwerfen</button>
      <button class="btn btn-primary" id="scCropOkBtn"><i data-icon="check" data-icon-size="16"></i> Übernehmen</button>
    </div>
  </div>

  <!-- Radierer (weiß übermalen) -->
  <div class="sc-view hidden" id="scEraseView">
    <div class="sc-toolbar">
      <label class="sc-brush-label"><i data-icon="eraser" data-icon-size="16"></i> Pinselgröße
        <input type="range" id="scBrushSize" min="6" max="90" step="1" value="26">
        <span class="sc-brush-dot" id="scBrushDot"></span>
      </label>
      <span class="sc-sep"></span>
      <span class="sc-tgroup">
        <span class="sc-tlabel">Zoom</span>
        <button class="btn btn-small" id="scEraseZoomOut" title="Herauszoomen" aria-label="Herauszoomen"><i data-icon="minus" data-icon-size="15"></i></button>
        <span class="sc-zoomlabel" id="scEraseZoomLabel">100 %</span>
        <button class="btn btn-small" id="scEraseZoomIn" title="Hineinzoomen" aria-label="Hineinzoomen"><i data-icon="plus" data-icon-size="15"></i></button>
        <button class="btn btn-small" id="scEraseZoomFit" title="Einpassen">Fit</button>
      </span>
      <span class="sc-sep"></span>
      <button class="btn btn-small" id="scEraseUndoBtn" title="Rückgängig" aria-label="Rückgängig"><i data-icon="undo" data-icon-size="15"></i></button>
      <button class="btn btn-small" id="scEraseRedoBtn" title="Wiederholen" aria-label="Wiederholen"><i data-icon="redo" data-icon-size="15"></i></button>
    </div>
    <div class="sc-erase-stage" id="scEraseStage"><canvas id="scEraseCanvas"></canvas></div>
    <p class="sc-hint">Mit dem weißen Pinsel über Ränder, Schatten oder Störungen malen. <span class="sc-hint-long">Zum Feinarbeiten hineinzoomen – mit zwei Fingern oder über die Zoom-Tasten; ein Finger radiert.</span></p>
    <div class="sc-bottombar">
      <button class="btn" id="scEraseCancelBtn">Verwerfen</button>
      <button class="btn btn-primary" id="scEraseOkBtn"><i data-icon="check" data-icon-size="16"></i> Fertig</button>
    </div>
  </div>

  <!-- Seitenübersicht -->
  <div class="sc-view hidden" id="scPagesView">
    <div class="sc-pagegrid" id="scPageGrid"></div>
    <div class="sc-row">
      <button class="btn btn-primary" id="scAddNetBtn" hidden><i data-icon="scanner"></i> Nächste Seite scannen</button>
      <button class="btn" id="scAddCamBtn"><i data-icon="camera"></i> Seite mit Kamera</button>
      <button class="btn" id="scAddFileBtn"><i data-icon="image"></i> Seiten aus Bildern</button>
    </div>
    <p class="sc-hint" id="scPagesHint">Weitere Seiten anfügen – alle Seiten hier landen zusammen in <strong>einer</strong> PDF. Danach „Als PDF übernehmen“, Kompressionsstufe wählen und komprimieren.</p>
    <div class="sc-bottombar">
      <button class="btn btn-primary" id="scDoneBtn"><i data-icon="check" data-icon-size="16"></i> Als PDF übernehmen</button>
    </div>
  </div>

  <!-- Große Seitenvorschau -->
  <div class="sc-preview hidden" id="scPreview" role="dialog" aria-modal="true" aria-label="Seitenvorschau">
    <div class="sc-preview-bar">
      <span class="sc-preview-label" id="scPreviewLabel"></span>
      <button class="btn btn-small" id="scPreviewPrev" aria-label="Vorherige Seite"><i data-icon="chevronLeft" data-icon-size="15"></i></button>
      <button class="btn btn-small" id="scPreviewNext" aria-label="Nächste Seite"><i data-icon="chevronRight" data-icon-size="15"></i></button>
      <span class="sc-sep"></span>
      <button class="btn btn-small" id="scPreviewCrop"><i data-icon="crop" data-icon-size="15"></i> Zuschnitt</button>
      <button class="btn btn-small" id="scPreviewErase"><i data-icon="eraser" data-icon-size="15"></i> Radieren</button>
      <button class="btn btn-small btn-ghost" id="scPreviewClose"><i data-icon="close" data-icon-size="15"></i> Schließen</button>
    </div>
    <div class="sc-preview-stage" id="scPreviewStage"></div>
  </div>
</div>`;

function view(name) {
  $('#scCaptureView', state.root).classList.toggle('hidden', name !== 'capture');
  $('#scCropView', state.root).classList.toggle('hidden', name !== 'crop');
  $('#scEraseView', state.root).classList.toggle('hidden', name !== 'erase');
  $('#scPagesView', state.root).classList.toggle('hidden', name !== 'pages');
  if (name === 'capture') startCamera();
  else stopCamera();
  if (name === 'pages') renderPages();
  updatePageCount();
}

function updatePageCount() {
  const el = $('#scPageCount', state.root);
  const n = state.pages.length;
  // Läuft gerade ein Stapel-Scan, hat dessen Fortschrittstext Vorrang.
  if (!state.batchStatus) {
    el.textContent = n === 0 ? '' : `${n} Seite${n === 1 ? '' : 'n'}`;
  }
  const toPages = $('#scToPagesBtn', state.root);
  toPages.hidden = n === 0;
  toPages.textContent = `Zu den Seiten (${n}) →`;
}

// ------------------------------------------------ Kamera & Blitz

async function startCamera() {
  const msg = $('#scCamMsg', state.root);
  const video = $('#scVideo', state.root);
  if (state.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.classList.remove('hidden');
    msg.innerHTML = 'Keine Kamera verfügbar.<br>Nutze <strong>Bilder wählen</strong>, um Fotos aus Dateien zu scannen.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    msg.classList.add('hidden');
    // Blitz (Torch) anbieten, wenn die Kamera ihn unterstützt
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.();
    const torchBtn = $('#scTorchBtn', state.root);
    torchBtn.hidden = !caps?.torch;
    state.torchOn = false;
    torchBtn.classList.remove('active');
    torchBtn.setAttribute('aria-pressed', 'false');
    startLiveDetect();
  } catch (e) {
    msg.classList.remove('hidden');
    msg.innerHTML = `Kamera nicht verfügbar (${e?.name || e}).<br>Nutze <strong>Bilder wählen</strong>, um Fotos aus Dateien zu scannen.`;
  }
}

function stopCamera() {
  stopLiveDetect();
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  const video = state.root && $('#scVideo', state.root);
  if (video) video.srcObject = null;
}

async function toggleTorch() {
  const track = state.stream?.getVideoTracks()[0];
  if (!track) return;
  state.torchOn = !state.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
  } catch (e) {
    console.warn('Blitz nicht schaltbar:', e);
    state.torchOn = false;
  }
  const btn = $('#scTorchBtn', state.root);
  btn.classList.toggle('active', state.torchOn);
  btn.setAttribute('aria-pressed', String(state.torchOn));
}

// Live-Vorschau der erkannten Ränder über dem Kamerabild
function startLiveDetect() {
  stopLiveDetect();
  const video = $('#scVideo', state.root);
  const overlay = $('#scLiveOverlay', state.root);
  const small = document.createElement('canvas');
  const tick = () => {
    if (!state.stream || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, 320 / Math.max(vw, vh));
    small.width = Math.max(2, Math.round(vw * scale));
    small.height = Math.max(2, Math.round(vh * scale));
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(video, 0, 0, small.width, small.height);
    let corners = null;
    try {
      corners = detectDocumentCorners(sctx.getImageData(0, 0, small.width, small.height));
    } catch { /* Einzelframe darf fehlschlagen */ }
    // Overlay passend zum object-fit:contain-Ausschnitt des Videos zeichnen
    const cw = video.clientWidth;
    const ch = video.clientHeight;
    overlay.width = cw;
    overlay.height = ch;
    const octx = overlay.getContext('2d');
    octx.clearRect(0, 0, cw, ch);
    if (!corners) return;
    const fit = Math.min(cw / vw, ch / vh);
    const dw = vw * fit;
    const dh = vh * fit;
    const ox = (cw - dw) / 2;
    const oy = (ch - dh) / 2;
    octx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
    octx.fillStyle = 'rgba(56, 189, 248, 0.15)';
    octx.lineWidth = 3;
    octx.beginPath();
    corners.forEach((p, i) => {
      const x = ox + p.x * dw;
      const y = oy + p.y * dh;
      if (i === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
    });
    octx.closePath();
    octx.fill();
    octx.stroke();
  };
  state.liveTimer = setInterval(tick, 350);
}

function stopLiveDetect() {
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
  const overlay = state.root && $('#scLiveOverlay', state.root);
  if (overlay) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
}

function capturePhoto() {
  const video = $('#scVideo', state.root);
  if (!video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  // kurzes Auslöse-Feedback
  const wrap = $('#scVideoWrap', state.root);
  wrap.classList.add('sc-flash');
  setTimeout(() => wrap.classList.remove('sc-flash'), 180);
  openCrop(c, null, 'capture');
}

// ------------------------------------------------ Bilder aus Dateien

async function fileToCanvas(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Bild „${file.name}“ konnte nicht gelesen werden`));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, IMPORT_MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  if (bmp.src) URL.revokeObjectURL(bmp.src);
  // Originalmaße & Scanauflösung anhängen – daraus lässt sich die reale Größe
  // der Vorlage in Millimetern bestimmen (für den A4-Ausschnitt).
  if (file.scanDpi) {
    c.scanDpi = file.scanDpi;
    c.sourcePx = { w, h };
  }
  return c;
}

/**
 * A4-Ausschnitt für einen Flachbett-Scan.
 *
 * Die Glasfläche ist meist größer als A4 (der Epson ET-2720 z. B. 215,9 × 297 mm
 * – Letter-Breite bei A4-Höhe). Die Vorlage liegt bündig in der Ecke am
 * Nullpunkt. Aus Pixelgröße und Scanauflösung ergibt sich die reale Größe der
 * Glasfläche, daraus der A4-Bereich ab der Ecke.
 *
 * @returns normierte Ecken (0..1) oder null, wenn die Maße unbekannt sind
 */
export function a4CornersForScan(canvas, { originX = 'left', originY = 'top', detect = true } = {}) {
  // Nur für Flachbett-Scans. Kamerafotos brauchen die perspektivische
  // Eckenerkennung – dort wäre eine achsparallele Blattsuche falsch.
  if (!canvas?.scanDpi) return null;

  // Zwei Erkenntnisquellen, je Achse getrennt ausgewertet:
  //   A) gemessene Blattkante (dunklere Glasfläche oder Schattenlinie)
  //   B) Rechnung aus Pixelgröße und Scanauflösung (Glasfläche minus A4)
  // Gemessen schlägt gerechnet – aber nur dort, wo wirklich etwas gefunden
  // wurde. Im echten Scan ist z. B. die untere Kante sichtbar, die rechte
  // nicht (weißes Papier vor weißem Deckel).
  const found = detect ? detectSheetOnBed(canvas) : null;
  const EPS = 0.002;

  const dpi = canvas.scanDpi;
  const px = canvas.sourcePx;
  let calc = null;
  if (dpi && px?.w && px?.h) {
    const fw = Math.min(1, 210 / ((px.w / dpi) * 25.4));
    const fh = Math.min(1, 297 / ((px.h / dpi) * 25.4));
    const cx0 = originX === 'left' ? 0 : 1 - fw;
    const cy0 = originY === 'top' ? 0 : 1 - fh;
    calc = { x0: cx0, y0: cy0, x1: cx0 + fw, y1: cy0 + fh };
  }
  if (!found && !calc) return null;

  // Je Kante die Messung nehmen, wenn sie etwas gefunden hat, sonst die Rechnung
  const pick = (measured, computed, isStart) => {
    const hit = isStart ? measured > EPS : measured < 1 - EPS;
    if (hit) return measured;
    return computed ?? measured;
  };
  const r = {
    x0: found ? pick(found.x0, calc?.x0, true) : calc.x0,
    y0: found ? pick(found.y0, calc?.y0, true) : calc.y0,
    x1: found ? pick(found.x1, calc?.x1, false) : calc.x1,
    y1: found ? pick(found.y1, calc?.y1, false) : calc.y1,
  };
  // Nichts zu holen? Dann keinen Zuschnitt anbieten.
  if (r.x0 <= EPS && r.y0 <= EPS && r.x1 >= 1 - EPS && r.y1 >= 1 - EPS) return null;
  return [
    { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
  ];
}

/** Hoch- oder Querformat für eine Auswahl bestimmen (in Quellpixeln gemessen) */
function a4FormatFor(src, corners) {
  const w = Math.abs(corners[1].x - corners[0].x) * (src?.width || 1);
  const h = Math.abs(corners[3].y - corners[0].y) * (src?.height || 1);
  return h >= w ? 'a4p' : 'a4l';
}

const SHEET_ANALYZE = 700;   // Analysebreite für die Blatterkennung
const SHEET_SEARCH = 0.14;   // Suchtiefe je Rand (Anteil der Kantenlänge)

function medianOf(arr) {
  const a = [...arr].sort((p, q) => p - q);
  return a[a.length >> 1];
}

/**
 * Findet die Blattkante von einem Rand aus.
 *
 * Zwei Erscheinungsformen werden erkannt, in dieser Reihenfolge von außen nach
 * innen (die äußerste Fundstelle gewinnt – dadurch stört Dokumentinhalt weiter
 * innen nicht):
 *   1. Ein Bereich, der klar dunkler ist als das Papier – die unbedeckte
 *      Glasfläche bzw. der offene Deckel.
 *   2. Eine feine dunkle Linie – der Schattenwurf direkt an der Blattkante.
 *      Die ist oft nur wenige Helligkeitsstufen tief, aber eindeutig.
 *
 * @param prof Helligkeitsprofil, Index 0 = äußerster Rand
 * @returns Index der Blattkante (0 = kein Rand gefunden)
 */
export function sheetEdgeFromProfile(prof) {
  const search = Math.max(3, Math.round(prof.length * SHEET_SEARCH));
  const paper = medianOf(prof.slice(search));           // sicher Papier
  if (!(paper > 0)) return 0;

  // 1. Deutlich dunkler Bereich am Rand: freie Glasfläche bzw. Deckel.
  //    Der reicht vom äußersten Rand nach innen – Dokumentinhalt kann das
  //    nicht vortäuschen, weil er nie bis an den Rand durchläuft.
  let i = 0;
  while (i < search && prof[i] < paper - 6) i++;
  if (i > 0) {
    while (i < search && prof[i] < paper - 2) i++;   // bis wirklich Papier
    return i;
  }

  // 2. Feine Schattenlinie an der Blattkante. Nur ganz nah am Rand suchen und
  //    nur schmale Senken akzeptieren – sonst würde eine Textzeile in Randnähe
  //    fälschlich als Blattkante gelten.
  const near = Math.max(2, Math.round(prof.length * 0.045));
  const maxWidth = Math.max(3, Math.round(prof.length * 0.02));
  const MAX_DEPTH = 40;   // tiefer = Druckinhalt, nicht Blattkante
  for (let j = 1; j < near; j++) {
    const depth = paper - prof[j];
    if (depth < 2.5 || depth > MAX_DEPTH) continue;
    if (!(prof[j] <= prof[j - 1] && prof[j] <= prof[j + 1])) continue;
    // Ausdehnung der Senke bestimmen: eine Textzeile ist breiter und dunkler
    let a = j;
    while (a > 0 && paper - prof[a - 1] >= 2) a--;
    let b = j;
    while (b < prof.length - 1 && paper - prof[b + 1] >= 2) b++;
    if (b - a + 1 > maxWidth) continue;
    return b + 1;   // hinter der Linie beginnt das Papier
  }
  return 0;
}

/**
 * Sucht das Blatt auf der Scanfläche und liefert seine Ränder als Anteile
 * (0..1). Gibt null zurück, wenn das Bild nicht auswertbar ist.
 */
export function detectSheetOnBed(canvas) {
  try {
    const W = canvas?.width;
    const H = canvas?.height;
    if (!W || !H) return null;
    // Ergebnis am Bild merken – die Ansicht zeichnet oft neu, die Analyse
    // muss deshalb nicht jedes Mal laufen.
    if (canvas.__sheet !== undefined) return canvas.__sheet;

    // Verkleinert auswerten – schnell und unempfindlich gegen Rauschen
    const s = Math.min(1, SHEET_ANALYZE / Math.max(W, H));
    const aw = Math.max(40, Math.round(W * s));
    const ah = Math.max(40, Math.round(H * s));
    const c = document.createElement('canvas');
    c.width = aw;
    c.height = ah;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, aw, ah);
    const px = ctx.getImageData(0, 0, aw, ah).data;
    const lum = (x, y) => {
      const i = (y * aw + x) * 4;
      return (px[i] * 77 + px[i + 1] * 151 + px[i + 2] * 28) >> 8;
    };

    // Profile über die mittleren 60 % der jeweils anderen Achse (Median statt
    // Mittelwert: einzelne Textzeilen ziehen das Ergebnis nicht herunter)
    const colProf = [];
    const y0 = Math.round(ah * 0.2);
    const y1 = Math.round(ah * 0.8);
    for (let x = 0; x < aw; x++) {
      const vals = [];
      for (let y = y0; y < y1; y++) vals.push(lum(x, y));
      colProf.push(medianOf(vals));
    }
    const rowProf = [];
    const x0 = Math.round(aw * 0.2);
    const x1 = Math.round(aw * 0.8);
    for (let y = 0; y < ah; y++) {
      const vals = [];
      for (let x = x0; x < x1; x++) vals.push(lum(x, y));
      rowProf.push(medianOf(vals));
    }

    const left = sheetEdgeFromProfile(colProf);
    const right = sheetEdgeFromProfile([...colProf].reverse());
    const top = sheetEdgeFromProfile(rowProf);
    const bottom = sheetEdgeFromProfile([...rowProf].reverse());

    const r = {
      x0: left / aw,
      y0: top / ah,
      x1: (aw - right) / aw,
      y1: (ah - bottom) / ah,
    };
    // Unsinnige Ergebnisse verwerfen (Blatt füllt immer den Großteil)
    const ok = (r.x1 - r.x0 >= 0.55 && r.y1 - r.y0 >= 0.55) ? r : null;
    try { canvas.__sheet = ok; } catch { /* nicht beschreibbar: egal */ }
    return ok;
  } catch {
    return null;   // z. B. wenn das Canvas nicht auslesbar ist
  }
}

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name));
  if (files.length === 0) return;
  const canvases = [];
  for (const f of files) {
    try {
      canvases.push(await fileToCanvas(f));
    } catch (e) {
      alert(e?.message || e);
    }
  }
  if (canvases.length === 0) return;
  state.queue.push(...canvases.slice(1));
  // Beim Abbrechen dorthin zurück, wo es sinnvoll ist: zur Seitenübersicht,
  // sobald Seiten da sind – und im Netzwerk-Betrieb immer (die Kamera wird
  // dort gar nicht gebraucht).
  const back = (state.pages.length > 0 || state.netScan) ? 'pages' : 'capture';
  openCrop(canvases[0], null, back);
}

// ------------------------------------------------ Zuschnitt (Ecken + Lupe)

function openCrop(srcCanvas, pageIndex, returnTo) {
  const existing = pageIndex != null ? state.pages[pageIndex] : null;
  state.cropReturn = returnTo;
  // Bei Flachbett-Scans nicht raten: Der A4-Bereich steht rechnerisch fest
  // (Vorlage liegt bündig in der Ecke). Das trifft jede Seite gleich – anders
  // als die Kantenerkennung, die bei weißem Blatt auf weißem Deckel scheitert.
  const src = existing ? existing.src : srcCanvas;
  const a4 = existing ? null : a4CornersForScan(src, {
    originX: state.scanOriginX || 'left',
    originY: state.scanOriginY || 'top',
  });
  state.editing = {
    src,
    corners: existing ? existing.corners.map((p) => ({ ...p }))
      : (a4 || detectCornersOnCanvas(srcCanvas) || defaultCorners()),
    // Erkanntes Blatt: Hoch- oder Querformat aus dem Seitenverhältnis ableiten
    // und strecken – so wird die Ausgabe exakt A4 statt „A4 mit weißem Rand“.
    format: existing ? existing.format : (a4 ? a4FormatFor(src, a4) : state.lastFormat),
    stretch: existing ? !!existing.stretch : (a4 ? true : state.lastStretch),
    // Aus der Quelle lesen, nicht aus srcCanvas: beim erneuten Öffnen einer
    // bestehenden Seite ist srcCanvas null – dann verschwanden die A4-Knöpfe.
    isBedScan: !!src?.scanDpi,
    pageIndex,
  };
  state.activeHandle = null;
  view('crop');
  renderCrop();
}

// Rand um das Bild herum. Ecken liegen oft genau auf der Bildkante – ohne
// diesen Rand läge der halbe Anfasser außerhalb der Zeichenfläche und ließe
// sich nicht greifen.
const CROP_PAD = 34;

function cropDisplayMetrics() {
  const stage = $('#scCropStage', state.root);
  const src = state.editing.src;
  const maxW = stage.clientWidth - 16 - CROP_PAD * 2;
  const maxH = stage.clientHeight - 16 - CROP_PAD * 2;
  const fit = Math.min(maxW / src.width, maxH / src.height);
  return { dw: Math.max(1, src.width * fit), dh: Math.max(1, src.height * fit) };
}

function renderCrop() {
  const ed = state.editing;
  if (!ed) return;
  const canvas = $('#scCropCanvas', state.root);
  const svg = $('#scCropSvg', state.root);
  const { dw, dh } = cropDisplayMetrics();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(dw * dpr);
  canvas.height = Math.round(dh * dpr);
  canvas.style.width = `${dw}px`;
  canvas.style.height = `${dh}px`;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(ed.src, 0, 0, canvas.width, canvas.height);
  // Zeichenfläche ist rundum größer als das Bild; der Nullpunkt des Bildes
  // liegt dadurch bei (CROP_PAD, CROP_PAD).
  svg.setAttribute('viewBox', `${-CROP_PAD} ${-CROP_PAD} ${dw + CROP_PAD * 2} ${dh + CROP_PAD * 2}`);
  svg.style.width = `${dw + CROP_PAD * 2}px`;
  svg.style.height = `${dh + CROP_PAD * 2}px`;
  drawCropOverlay();
  // Formatwahl markieren
  state.root.querySelectorAll('.sc-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.format === ed.format);
    b.setAttribute('aria-pressed', String(b.dataset.format === ed.format));
  });
  $('#scStretchWrap', state.root).classList.toggle('hidden', ed.format === 'auto');
  $('#scStretch', state.root).checked = !!ed.stretch;

  // A4-Werkzeuge nur zeigen, wenn die Vorlage vom Flachbett kommt und die
  // Glasfläche tatsächlich größer als A4 ist.
  const bedA4 = ed.isBedScan && !!a4CornersForScan(ed.src, {
    originX: state.scanOriginX || 'left',
    originY: state.scanOriginY || 'top',
  });
  for (const id of ['#scA4BedBtn', '#scA4CornerBtn']) {
    const b = $(id, state.root);
    b.hidden = !bedA4;
    b.classList.toggle('hidden', !bedA4);
  }
}

function drawCropOverlay() {
  const ed = state.editing;
  const svg = $('#scCropSvg', state.root);
  const { dw, dh } = cropDisplayMetrics();
  const pts = ed.corners.map((p) => ({ x: p.x * dw, y: p.y * dh }));
  const quadPath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
  const mids = pts.map((p, i) => {
    const q = pts[(i + 1) % 4];
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  });
  svg.innerHTML = `
    <path d="M0,0 H${dw} V${dh} H0 Z ${quadPath}" fill="rgba(2,6,16,0.55)" fill-rule="evenodd"></path>
    <path d="${quadPath}" fill="none" stroke="#38bdf8" stroke-width="2.5"></path>
    ${mids.map((m, i) => `
      <g class="sc-handle sc-handle-edge" data-edge="${i}">
        <circle cx="${m.x}" cy="${m.y}" r="26" fill="transparent"></circle>
        <circle cx="${m.x}" cy="${m.y}" r="8" fill="#38bdf8" stroke="#06232f" stroke-width="2"></circle>
      </g>`).join('')}
    ${pts.map((p, i) => `
      <g class="sc-handle sc-handle-corner" data-corner="${i}">
        <circle cx="${p.x}" cy="${p.y}" r="40" fill="transparent"></circle>
        <circle cx="${p.x}" cy="${p.y}" r="15" fill="rgba(56,189,248,0.28)" stroke="#38bdf8" stroke-width="3.5"></circle>
        <circle cx="${p.x}" cy="${p.y}" r="3" fill="#38bdf8"></circle>
      </g>`).join('')}`;
}

// Lupe: zeigt die aktive Ecke stark vergrößert, auf der dem Finger
// gegenüberliegenden Seite, damit die Hand nichts verdeckt.
function updateLoupe(cornerIdx, pointerX) {
  const loupe = $('#scLoupe', state.root);
  const lc = loupe.querySelector('canvas');
  const stage = $('#scCropStage', state.root);
  const ed = state.editing;
  const p = ed.corners[cornerIdx];
  const size = 150;
  const region = clamp(Math.max(ed.src.width, ed.src.height) * 0.07, 40, 260); // Quellausschnitt in px
  const cx = p.x * (ed.src.width - 1);
  const cy = p.y * (ed.src.height - 1);
  const ctx = lc.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(ed.src, cx - region / 2, cy - region / 2, region, region, 0, 0, size, size);
  // Quadkanten in Lupenkoordinaten einzeichnen
  const toL = (q) => ({
    x: (q.x * (ed.src.width - 1) - (cx - region / 2)) * (size / region),
    y: (q.y * (ed.src.height - 1) - (cy - region / 2)) * (size / region),
  });
  ctx.strokeStyle = 'rgba(56,189,248,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ed.corners.forEach((q, i) => {
    const l = toL(q);
    if (i === 0) ctx.moveTo(l.x, l.y); else ctx.lineTo(l.x, l.y);
  });
  ctx.closePath();
  ctx.stroke();
  // Fadenkreuz
  ctx.strokeStyle = 'rgba(248,113,113,0.95)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(size / 2 - 14, size / 2); ctx.lineTo(size / 2 + 14, size / 2);
  ctx.moveTo(size / 2, size / 2 - 14); ctx.lineTo(size / 2, size / 2 + 14);
  ctx.stroke();
  ctx.restore();
  // Seite wählen: Lupe weg vom Finger
  const onLeft = pointerX - stage.getBoundingClientRect().left > stage.clientWidth / 2;
  loupe.classList.toggle('sc-loupe-left', onLeft);
  loupe.classList.remove('hidden');
}

function hideLoupe() {
  $('#scLoupe', state.root).classList.add('hidden');
}

function svgPoint(e) {
  const svg = $('#scCropSvg', state.root);
  const r = svg.getBoundingClientRect();
  const { dw, dh } = cropDisplayMetrics();
  // Die Fläche ist rundum um CROP_PAD größer als das Bild – erst den Rand
  // abziehen, dann auf 0..1 des Bildes normieren.
  const padX = (CROP_PAD / (dw + CROP_PAD * 2)) * r.width;
  const padY = (CROP_PAD / (dh + CROP_PAD * 2)) * r.height;
  const innerW = r.width - padX * 2;
  const innerH = r.height - padY * 2;
  return {
    x: clamp((e.clientX - r.left - padX) / innerW, 0, 1),
    y: clamp((e.clientY - r.top - padY) / innerH, 0, 1),
    dw, dh,
  };
}

function onCropPointerDown(e) {
  const handle = e.target.closest?.('.sc-handle');
  if (!handle || !state.editing) return;
  e.preventDefault();
  const svg = $('#scCropSvg', state.root);
  svg.setPointerCapture?.(e.pointerId);
  if (handle.dataset.corner != null) {
    const idx = Number(handle.dataset.corner);
    state.drag = { type: 'corner', idx };
    state.activeHandle = idx;
    updateLoupe(idx, e.clientX);
  } else {
    const idx = Number(handle.dataset.edge);
    const p = svgPoint(e);
    state.drag = { type: 'edge', idx, last: p };
  }
}

function onCropPointerMove(e) {
  if (!state.drag || !state.editing) return;
  e.preventDefault();
  const ed = state.editing;
  const p = svgPoint(e);
  if (state.drag.type === 'corner') {
    ed.corners[state.drag.idx] = { x: p.x, y: p.y };
    drawCropOverlay();
    updateLoupe(state.drag.idx, e.clientX);
  } else {
    const dx = p.x - state.drag.last.x;
    const dy = p.y - state.drag.last.y;
    state.drag.last = p;
    const i = state.drag.idx;
    const j = (i + 1) % 4;
    ed.corners[i] = { x: clamp(ed.corners[i].x + dx, 0, 1), y: clamp(ed.corners[i].y + dy, 0, 1) };
    ed.corners[j] = { x: clamp(ed.corners[j].x + dx, 0, 1), y: clamp(ed.corners[j].y + dy, 0, 1) };
    drawCropOverlay();
  }
}

function onCropPointerUp() {
  state.drag = null;
  hideLoupe();
}

function onCropKeydown(e) {
  if (state.activeHandle == null || !state.editing) return;
  const step = (e.shiftKey ? 10 : 1.5) / Math.max(state.editing.src.width, state.editing.src.height) * 4;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const mv = moves[e.key];
  if (!mv) return;
  e.preventDefault();
  const c = state.editing.corners[state.activeHandle];
  state.editing.corners[state.activeHandle] = {
    x: clamp(c.x + mv[0], 0, 1),
    y: clamp(c.y + mv[1], 0, 1),
  };
  drawCropOverlay();
}

function rotateEditing() {
  const ed = state.editing;
  ed.src = rotateCanvas90(ed.src);
  ed.corners = orderCorners(ed.corners.map((p) => ({ x: 1 - p.y, y: p.x })));
  // A4-Ausrichtung dreht sinnvollerweise mit
  if (ed.format === 'a4p') ed.format = 'a4l';
  else if (ed.format === 'a4l') ed.format = 'a4p';
  state.lastFormat = ed.format;
  renderCrop();
}

function applyCrop() {
  const ed = state.editing;
  if (!ed) return;
  const page = {
    src: ed.src,
    corners: orderCorners(ed.corners.map((p) => ({ ...p }))),
    format: ed.format,
    stretch: !!ed.stretch,
    erase: ed.pageIndex != null ? (state.pages[ed.pageIndex].erase || []) : [],
  };
  state.lastFormat = ed.format;
  state.lastStretch = !!ed.stretch;
  if (ed.pageIndex != null) state.pages[ed.pageIndex] = page;
  else state.pages.push(page);
  state.editing = null;
  nextFromQueueOrPages();
}

function cancelCrop() {
  state.editing = null;
  nextFromQueueOrPages(state.cropReturn === 'capture');
}

function nextFromQueueOrPages(backToCapture = false) {
  if (state.queue.length > 0) {
    openCrop(state.queue.shift(), null, state.cropReturn);
    return;
  }
  if (backToCapture || state.pages.length === 0) view('capture');
  else view('pages');
}

// ------------------------------------------------ Radierer (weiß übermalen)

const ERASE_BASE_MAX = 2200;   // Auflösung der Arbeitskopie im Radierer

function openErase(pageIndex) {
  const page = state.pages[pageIndex];
  page.erase = page.erase || [];
  state.erasing = {
    pageIndex,
    backup: JSON.stringify(page.erase),
    undo: [],
    redo: [],
    base: null,
    drawing: null,
    zoom: 1,          // 1 = eingepasst
    pan: { x: 0, y: 0 },  // linke obere Ecke des Sichtfensters in Basispixeln
    pinch: null,
    pointers: new Map(),
  };
  view('erase');
  renderErase();
  updateEraseButtons();
}

/** Umrechnung zwischen Basisbild und Anzeige – Grundlage für Zoom & Zeichnen */
function eraseMetrics() {
  const er = state.erasing;
  const stage = $('#scEraseStage', state.root);
  const bw = er.base.width;
  const bh = er.base.height;
  const vw = Math.max(40, stage.clientWidth - 12);
  const vh = Math.max(40, stage.clientHeight - 12);
  const fit = Math.min(vw / bw, vh / bh);
  const scale = fit * er.zoom;
  // Sichtbarer Ausschnitt des Basisbildes
  const visW = Math.min(bw, vw / scale);
  const visH = Math.min(bh, vh / scale);
  er.pan.x = clamp(er.pan.x, 0, Math.max(0, bw - visW));
  er.pan.y = clamp(er.pan.y, 0, Math.max(0, bh - visH));
  return { bw, bh, vw, vh, fit, scale, visW, visH, cssW: visW * scale, cssH: visH * scale };
}

function renderErase() {
  const er = state.erasing;
  if (!er) return;
  const page = state.pages[er.pageIndex];

  // Arbeitskopie in guter Auflösung – nur einmal berechnen. Beim Hineinzoomen
  // wird daraus ausschnittweise gezeichnet, dadurch sieht man wirklich mehr.
  if (!er.base) {
    const { w, h } = outputSize(page.src.width, page.src.height, page.corners);
    const s = Math.min(1, ERASE_BASE_MAX / Math.max(w, h));
    er.base = warpPerspective(page.src, page.corners, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  }

  const m = eraseMetrics();
  const canvas = $('#scEraseCanvas', state.root);
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  canvas.style.width = `${Math.round(m.cssW)}px`;
  canvas.style.height = `${Math.round(m.cssH)}px`;
  canvas.width = Math.max(1, Math.round(m.cssW * dpr));
  canvas.height = Math.max(1, Math.round(m.cssH * dpr));

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(er.base, er.pan.x, er.pan.y, m.visW, m.visH, 0, 0, canvas.width, canvas.height);

  // Radierspuren im selben Ausschnitt zeichnen (Striche sind normiert
  // gespeichert und damit unabhängig von Zoom und Auflösung)
  const k = canvas.width / m.visW;       // Basispixel -> Zeichenpixel
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of page.erase || []) {
    const width = Math.max(1, s.size * m.bw * k);
    const px = (p) => (p.x * m.bw - er.pan.x) * k;
    const py = (p) => (p.y * m.bh - er.pan.y) * k;
    if (s.points.length === 1) {
      ctx.beginPath();
      ctx.arc(px(s.points[0]), py(s.points[0]), width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineWidth = width;
      ctx.beginPath();
      s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p), py(p)) : ctx.lineTo(px(p), py(p))));
      ctx.stroke();
    }
  }
  ctx.restore();
  updateEraseZoomUi();
}

function updateEraseZoomUi() {
  const er = state.erasing;
  if (!er || !state.root) return;
  const out = $('#scEraseZoomOut', state.root);
  const inn = $('#scEraseZoomIn', state.root);
  const lbl = $('#scEraseZoomLabel', state.root);
  if (lbl) lbl.textContent = `${Math.round(er.zoom * 100)} %`;
  if (out) out.disabled = er.zoom <= 1.01;
  if (inn) inn.disabled = er.zoom >= 7.9;
}

/** Zoomen um einen Bildpunkt herum (Standard: Mitte des Sichtfensters) */
function eraseZoomTo(zoom, focus) {
  const er = state.erasing;
  if (!er?.base) return;
  const m = eraseMetrics();
  const f = focus || { x: er.pan.x + m.visW / 2, y: er.pan.y + m.visH / 2 };
  const rel = { x: (f.x - er.pan.x) / m.visW, y: (f.y - er.pan.y) / m.visH };
  er.zoom = clamp(zoom, 1, 8);
  const n = eraseMetrics();
  er.pan.x = f.x - rel.x * n.visW;
  er.pan.y = f.y - rel.y * n.visH;
  renderErase();
}

function updateEraseButtons() {
  const er = state.erasing;
  $('#scEraseUndoBtn', state.root).disabled = !er || er.undo.length === 0;
  $('#scEraseRedoBtn', state.root).disabled = !er || er.redo.length === 0;
}

// Bildschirmpunkt -> normierte Seitenkoordinate (0..1), zoomrichtig
function erasePoint(e) {
  const er = state.erasing;
  const canvas = $('#scEraseCanvas', state.root);
  const r = canvas.getBoundingClientRect();
  const m = eraseMetrics();
  const bx = er.pan.x + clamp((e.clientX - r.left) / r.width, 0, 1) * m.visW;
  const by = er.pan.y + clamp((e.clientY - r.top) / r.height, 0, 1) * m.visH;
  return { x: clamp(bx / m.bw, 0, 1), y: clamp(by / m.bh, 0, 1) };
}

// Basispunkt unter dem Zeiger (für Zoom-Fokus und Verschieben)
function eraseBasePoint(clientX, clientY) {
  const er = state.erasing;
  const canvas = $('#scEraseCanvas', state.root);
  const r = canvas.getBoundingClientRect();
  const m = eraseMetrics();
  return {
    x: er.pan.x + clamp((clientX - r.left) / r.width, 0, 1) * m.visW,
    y: er.pan.y + clamp((clientY - r.top) / r.height, 0, 1) * m.visH,
  };
}

function onErasePointerDown(e) {
  const er = state.erasing;
  if (!er) return;
  e.preventDefault();
  // Ein primärer Zeiger startet eine frische Geste – verhindert „Geisterfinger“
  // nach einem verlorenen pointerup (siehe Editor).
  if (e.isPrimary) {
    er.pointers.clear();
    er.pinch = null;
    er.drawing = null;
  }
  const canvas = $('#scEraseCanvas', state.root);
  try { canvas.setPointerCapture?.(e.pointerId); } catch { /* nicht kritisch */ }
  er.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // Zwei Finger: zoomen und verschieben statt radieren
  if (er.pointers.size === 2 && e.pointerType === 'touch') {
    const [a, b] = [...er.pointers.values()];
    er.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: er.zoom,
      base: eraseBasePoint((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
    // angefangenen Strich zurücknehmen – die Geste war als Zoom gemeint
    if (er.drawing) {
      const page = state.pages[er.pageIndex];
      const i = page.erase.indexOf(er.drawing);
      if (i >= 0) page.erase.splice(i, 1);
      er.drawing = null;
      if (er.undo.length) er.undo.pop();
      renderErase();
      updateEraseButtons();
    }
    return;
  }
  if (er.pointers.size > 1) return;

  const page = state.pages[er.pageIndex];
  er.undo.push(JSON.stringify(page.erase));
  if (er.undo.length > 60) er.undo.shift();
  er.redo = [];
  // Pinselgröße in Seitenanteil: beim Hineinzoomen wird feiner radiert
  const m = eraseMetrics();
  const size = (parseInt($('#scBrushSize', state.root).value, 10) / m.cssW) * (m.visW / m.bw);
  er.drawing = { size, points: [erasePoint(e)] };
  page.erase.push(er.drawing);
  renderErase();
  updateEraseButtons();
}

function onErasePointerMove(e) {
  const er = state.erasing;
  if (!er) return;
  if (er.pointers.has(e.pointerId)) er.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (er.pinch && er.pointers.size === 2) {
    e.preventDefault();
    const [a, b] = [...er.pointers.values()];
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    eraseZoomTo(er.pinch.zoom * (dist / er.pinch.dist), er.pinch.base);
    return;
  }
  if (!er.drawing) return;
  e.preventDefault();
  er.drawing.points.push(erasePoint(e));
  renderErase();
}

function onErasePointerUp(e) {
  const er = state.erasing;
  if (!er) return;
  if (e?.pointerId != null) er.pointers.delete(e.pointerId);
  if (er.pointers.size < 2) er.pinch = null;
  er.drawing = null;
}

function eraseUndo() {
  const er = state.erasing;
  if (!er || er.undo.length === 0) return;
  const page = state.pages[er.pageIndex];
  er.redo.push(JSON.stringify(page.erase));
  page.erase = JSON.parse(er.undo.pop());
  renderErase();
  updateEraseButtons();
}

function eraseRedo() {
  const er = state.erasing;
  if (!er || er.redo.length === 0) return;
  const page = state.pages[er.pageIndex];
  er.undo.push(JSON.stringify(page.erase));
  page.erase = JSON.parse(er.redo.pop());
  renderErase();
  updateEraseButtons();
}

function closeErase(discard) {
  const er = state.erasing;
  if (!er) return;
  if (discard) state.pages[er.pageIndex].erase = JSON.parse(er.backup);
  state.erasing = null;
  view('pages');
}

// ------------------------------------------------ Seitenübersicht & PDF

// Miniatur der fertigen PDF-Seite (inkl. A4-Einpassung/Streckung & Radierungen)
function composeThumb(page, thumbH = 190) {
  const { w, h } = outputSize(page.src.width, page.src.height, page.corners);
  const isA4 = page.format === 'a4p' || page.format === 'a4l';
  if (!isA4) {
    const tw = Math.max(24, Math.round(thumbH * (w / h)));
    const thumb = warpPerspective(page.src, page.corners, tw, thumbH);
    return applyErase(thumb, page.erase);
  }
  const [aw, ah] = page.format === 'a4p' ? [210, 297] : [297, 210];
  const tw = Math.max(24, Math.round(thumbH * (aw / ah)));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = thumbH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tw, thumbH);
  let iw = tw;
  let ih = thumbH;
  if (!page.stretch) {
    const s = Math.min(tw / w, thumbH / h);
    iw = Math.max(8, Math.round(w * s));
    ih = Math.max(8, Math.round(h * s));
  }
  const warped = applyErase(warpPerspective(page.src, page.corners, iw, ih), page.erase);
  ctx.drawImage(warped, Math.round((tw - iw) / 2), Math.round((thumbH - ih) / 2));
  return c;
}

// Große Vorschau einer Seite – zum Prüfen vor dem Übernehmen. Von hier aus
// lassen sich Zuschnitt und Radierer direkt öffnen.
function openPagePreview(idx) {
  const page = state.pages[idx];
  if (!page) return;
  const box = $('#scPreview', state.root);
  const stage = $('#scPreviewStage', state.root);
  const big = composeThumb(page, Math.max(900, Math.round(window.innerHeight * 1.6)));
  big.className = 'sc-preview-img';
  stage.innerHTML = '';
  stage.appendChild(big);
  $('#scPreviewLabel', state.root).textContent = `Seite ${idx + 1} von ${state.pages.length}`;
  $('#scPreviewPrev', state.root).disabled = idx === 0;
  $('#scPreviewNext', state.root).disabled = idx === state.pages.length - 1;
  state.previewIdx = idx;
  box.classList.remove('hidden');
}

function closePagePreview() {
  $('#scPreview', state.root)?.classList.add('hidden');
  state.previewIdx = null;
}

function renderPages() {
  const grid = $('#scPageGrid', state.root);
  grid.innerHTML = '';
  state.pages.forEach((page, idx) => {
    const cell = document.createElement('div');
    cell.className = 'sc-pagecell';
    const thumb = composeThumb(page, 420);
    thumb.className = 'sc-thumb';
    thumb.title = 'Tippen für große Vorschau';
    thumb.setAttribute('role', 'button');
    thumb.setAttribute('tabindex', '0');
    thumb.addEventListener('click', () => openPagePreview(idx));
    thumb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPagePreview(idx); }
    });
    const label = document.createElement('div');
    label.className = 'sc-pagelabel';
    let fmt = page.format === 'a4p' ? 'A4 hoch' : page.format === 'a4l' ? 'A4 quer' : 'Auto';
    if (page.format !== 'auto' && page.stretch) fmt += ' · gestreckt';
    label.textContent = `Seite ${idx + 1} · ${fmt}`;
    const bar = document.createElement('div');
    bar.className = 'sc-pagecell-bar';
    // Beschriftung ist Markup (Icons) – die Werte stammen ausschließlich aus
    // dem eigenen Icon-Set, nicht aus Benutzereingaben.
    const mk = (html, title, fn, disabled = false) => {
      const b = document.createElement('button');
      b.className = 'btn btn-small';
      b.innerHTML = html;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.disabled = disabled;
      b.addEventListener('click', fn);
      return b;
    };
    bar.append(
      mk(icon('crop', { size: 15 }), 'Zuschnitt/Format bearbeiten', () => openCrop(null, idx, 'pages')),
      mk(icon('eraser', { size: 15 }), 'Radieren – Ränder/Schatten weiß übermalen', () => openErase(idx)),
      mk(icon('chevronLeft', { size: 15 }), 'Nach vorne schieben', () => {
        [state.pages[idx - 1], state.pages[idx]] = [state.pages[idx], state.pages[idx - 1]];
        renderPages();
      }, idx === 0),
      mk(icon('chevronRight', { size: 15 }), 'Nach hinten schieben', () => {
        [state.pages[idx + 1], state.pages[idx]] = [state.pages[idx], state.pages[idx + 1]];
        renderPages();
      }, idx === state.pages.length - 1),
      mk(icon('close', { size: 15 }), 'Seite löschen', () => {
        state.pages.splice(idx, 1);
        if (state.pages.length === 0) view('capture');
        else renderPages();
        updatePageCount();
      }),
    );
    cell.append(thumb, label, bar);
    grid.appendChild(cell);
  });
  $('#scDoneBtn', state.root).innerHTML = `${icon('check', { size: 16 })} Als PDF übernehmen (${state.pages.length} Seite${state.pages.length === 1 ? '' : 'n'})`;
  updatePageCount();
}

async function buildPdf() {
  if (state.building || state.pages.length === 0) return;
  state.building = true;
  const btn = $('#scDoneBtn', state.root);
  btn.disabled = true;
  try {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.setProducer('PDF Presser Scanner (lokal im Browser)');
    for (let i = 0; i < state.pages.length; i++) {
      btn.textContent = `Erstelle PDF … Seite ${i + 1}/${state.pages.length}`;
      await new Promise((r) => setTimeout(r, 0)); // UI atmen lassen
      const page = state.pages[i];
      const { w, h } = outputSize(page.src.width, page.src.height, page.corners);
      const warped = applyErase(warpPerspective(page.src, page.corners, w, h), page.erase);
      const blob = await new Promise((r) => warped.toBlob(r, 'image/jpeg', 0.9));
      const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      if (page.format === 'a4p' || page.format === 'a4l') {
        const [pw, ph] = page.format === 'a4p' ? A4_PT : [A4_PT[1], A4_PT[0]];
        const pdfPage = doc.addPage([pw, ph]);
        // Weißer Seitenhintergrund, damit die Ränder auch nach der
        // Bild-Kompression sicher weiß bleiben
        pdfPage.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: window.PDFLib.rgb(1, 1, 1) });
        if (page.stretch) {
          pdfPage.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        } else {
          const s = Math.min(pw / w, ph / h);
          const iw = w * s;
          const ih = h * s;
          pdfPage.drawImage(img, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih });
        }
      } else {
        let pw;
        let ph;
        if (w <= h) { ph = A4_PT[1]; pw = ph * (w / h); }
        else { pw = A4_PT[1]; ph = pw * (h / w); }
        doc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
      }
    }
    const bytes = await doc.save({ useObjectStreams: true });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const file = new File([bytes], `Scan_${stamp}.pdf`, { type: 'application/pdf' });
    const done = state.onDone;
    closeScanner();
    done?.(file);
  } catch (e) {
    alert(`PDF konnte nicht erstellt werden: ${e?.message || e}`);
    btn.disabled = false;
    btn.innerHTML = `${icon('check', { size: 16 })} Als PDF übernehmen`;
  } finally {
    state.building = false;
  }
}

// ------------------------------------------------ Öffnen / Schließen

function closeScanner() {
  stopCamera();
  document.removeEventListener('keydown', onGlobalKeydown);
  window.removeEventListener('resize', onResize);
  state.root?.remove();
  state.root = null;
  state.pages = [];
  state.queue = [];
  state.editing = null;
  state.erasing = null;
  state.onDone = null;
  state.building = false;
}

function onGlobalKeydown(e) {
  if (e.key !== 'Escape' || !state.root) return;
  // Erst die Vorschau schließen, nicht gleich den ganzen Scanner.
  if (state.previewIdx != null) { closePagePreview(); return; }
  closeScanner();
}

function onResize() {
  if (state.root && state.editing) renderCrop();
  if (state.root && state.erasing) renderErase();
}

/**
 * Öffnet den Scanner. onDone(file) erhält das fertige Scan-PDF (File).
 */
export function openScanner(onDone, opts = {}) {
  if (state.root) return;
  const root = document.createElement('div');
  root.id = 'scannerRoot';
  root.innerHTML = TEMPLATE;
  hydrateIcons(root);
  document.body.appendChild(root);
  state.root = root;
  state.onDone = onDone;
  state.pages = [];
  state.queue = [];
  state.lastFormat = 'auto';
  state.netScan = opts.netScan || null;   // Funktion, die eine weitere Seite holt

  // Nachschub vom Netzwerk-Scanner: nur einblenden, wenn verfügbar.
  const netBtns = [$('#scNetScanBtn', root), $('#scAddNetBtn', root)];
  if (state.netScan) {
    netBtns.forEach((b) => { b.hidden = false; b.addEventListener('click', () => addNetworkPage(b)); });
  }

  state.onCancelBatch = opts.onCancelBatch || null;
  $('#scBatchStopBtn', root).addEventListener('click', () => {
    state.onCancelBatch?.();
    setScanStatus('Stapel wird beendet …');
  });
  $('#scCloseBtn', root).addEventListener('click', () => {
    state.onCancelBatch?.();
    if (state.pages.length > 0 && !confirm('Scanner schließen? Die aufgenommenen Seiten gehen verloren.')) return;
    closeScanner();
  });
  $('#scShutterBtn', root).addEventListener('click', capturePhoto);
  $('#scTorchBtn', root).addEventListener('click', toggleTorch);
  const fileInput = $('#scFileInput', root);
  $('#scPickBtn', root).addEventListener('click', () => fileInput.click());
  $('#scAddFileBtn', root).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    importFiles(fileInput.files);
    fileInput.value = '';
  });
  $('#scToPagesBtn', root).addEventListener('click', () => view('pages'));

  // Große Seitenvorschau
  $('#scPreviewClose', root).addEventListener('click', closePagePreview);
  $('#scPreviewPrev', root).addEventListener('click', () => openPagePreview(state.previewIdx - 1));
  $('#scPreviewNext', root).addEventListener('click', () => openPagePreview(state.previewIdx + 1));
  $('#scPreviewCrop', root).addEventListener('click', () => {
    const i = state.previewIdx;
    closePagePreview();
    openCrop(null, i, 'pages');
  });
  $('#scPreviewErase', root).addEventListener('click', () => {
    const i = state.previewIdx;
    closePagePreview();
    openErase(i);
  });
  $('#scAddCamBtn', root).addEventListener('click', () => view('capture'));

  // A4-Ausschnitt der Glasfläche erneut setzen
  $('#scA4BedBtn', root).addEventListener('click', () => {
    if (!state.editing) return;
    const c = a4CornersForScan(state.editing.src, {
      originX: state.scanOriginX || 'left',
      originY: state.scanOriginY || 'top',
    });
    if (!c) return;
    state.editing.corners = c;
    state.editing.format = a4FormatFor(state.editing.src, c);
    state.editing.stretch = true;   // erkanntes Blatt exakt auf A4 abbilden
    renderCrop();
  });
  // Liegt die Vorlage an einer anderen Ecke an? Durch alle vier durchschalten.
  $('#scA4CornerBtn', root).addEventListener('click', () => {
    if (!state.editing) return;
    const order = [['left', 'top'], ['right', 'top'], ['right', 'bottom'], ['left', 'bottom']];
    const cur = order.findIndex(([x, y]) => x === (state.scanOriginX || 'left') && y === (state.scanOriginY || 'top'));
    const [nx, ny] = order[(cur + 1) % order.length];
    state.scanOriginX = nx;
    state.scanOriginY = ny;
    const c = a4CornersForScan(state.editing.src, { originX: nx, originY: ny });
    if (c) { state.editing.corners = c; renderCrop(); }
    $('#scA4CornerBtn', root).title = `Vorlage liegt an: ${ny === 'top' ? 'oben' : 'unten'} ${nx === 'left' ? 'links' : 'rechts'}`;
  });

  $('#scAutoBtn', root).addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.corners = detectCornersOnCanvas(state.editing.src) || defaultCorners();
    renderCrop();
  });
  // „Alles“: das komplette Bild auswählen. Das Ausgabeformat bleibt bewusst
  // unangetastet – wer A4 will, wählt es daneben (und optional „strecken“).
  $('#scFullBtn', root).addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.corners = defaultCorners(0);
    renderCrop();
  });
  root.querySelectorAll('.sc-seg-btn').forEach((b) => b.addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.format = b.dataset.format;
    state.lastFormat = b.dataset.format;
    renderCrop();
  }));
  $('#scStretch', root).addEventListener('change', (e) => {
    if (!state.editing) return;
    state.editing.stretch = e.target.checked;
    state.lastStretch = e.target.checked;
  });
  $('#scRotateBtn', root).addEventListener('click', rotateEditing);
  $('#scCropOkBtn', root).addEventListener('click', applyCrop);
  $('#scCropCancelBtn', root).addEventListener('click', cancelCrop);
  $('#scDoneBtn', root).addEventListener('click', buildPdf);

  const svg = $('#scCropSvg', root);
  svg.addEventListener('pointerdown', onCropPointerDown);
  svg.addEventListener('pointermove', onCropPointerMove);
  svg.addEventListener('pointerup', onCropPointerUp);
  svg.addEventListener('pointercancel', onCropPointerUp);
  svg.addEventListener('keydown', onCropKeydown);

  const eraseCanvas = $('#scEraseCanvas', root);
  eraseCanvas.addEventListener('pointerdown', onErasePointerDown);
  eraseCanvas.addEventListener('pointermove', onErasePointerMove);
  eraseCanvas.addEventListener('pointerup', onErasePointerUp);
  eraseCanvas.addEventListener('pointercancel', onErasePointerUp);
  $('#scEraseZoomIn', root).addEventListener('click', () => eraseZoomTo((state.erasing?.zoom || 1) * 1.6));
  $('#scEraseZoomOut', root).addEventListener('click', () => eraseZoomTo((state.erasing?.zoom || 1) / 1.6));
  $('#scEraseZoomFit', root).addEventListener('click', () => {
    if (!state.erasing) return;
    state.erasing.pan = { x: 0, y: 0 };
    eraseZoomTo(1);
  });
  // Mausrad/Trackpad am Rechner
  $('#scEraseStage', root).addEventListener('wheel', (e) => {
    if (!state.erasing) return;
    e.preventDefault();
    const f = eraseBasePoint(e.clientX, e.clientY);
    eraseZoomTo(state.erasing.zoom * (e.deltaY > 0 ? 0.85 : 1.18), f);
  }, { passive: false });

  $('#scEraseUndoBtn', root).addEventListener('click', eraseUndo);
  $('#scEraseRedoBtn', root).addEventListener('click', eraseRedo);
  $('#scEraseCancelBtn', root).addEventListener('click', () => closeErase(true));
  $('#scEraseOkBtn', root).addEventListener('click', () => closeErase(false));
  const brushSize = $('#scBrushSize', root);
  const brushDot = $('#scBrushDot', root);
  const syncBrushDot = () => {
    const d = Math.min(46, parseInt(brushSize.value, 10));
    brushDot.style.width = `${d}px`;
    brushDot.style.height = `${d}px`;
  };
  brushSize.addEventListener('input', syncBrushDot);
  syncBrushDot();

  document.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('resize', onResize);

  // Kommen schon Bilder mit (z. B. frisch vom Netzwerk-Scanner), direkt in den
  // Zuschnitt-Editor springen – ohne die Kamera anzufordern (am iPhone würde
  // das sonst unnötig nach Kameraerlaubnis fragen).
  if (opts.initialFiles && opts.initialFiles.length) {
    importFiles(opts.initialFiles);
  } else {
    view('capture');
  }
}

/**
 * Fügt ein Bild direkt als fertige Seite an – ohne den Zuschnitt-Dialog.
 * Für den Stapel-Scan: die Ecken werden automatisch bestimmt (Blattkante bzw.
 * Randerkennung), nachjustieren kann man später in der Seitenübersicht.
 */
export async function addPageDirect(file) {
  if (!state.root) return null;
  const canvas = await fileToCanvas(file);
  const a4 = a4CornersForScan(canvas, {
    originX: state.scanOriginX || 'left',
    originY: state.scanOriginY || 'top',
  });
  const corners = a4 || detectCornersOnCanvas(canvas) || defaultCorners();
  const page = {
    src: canvas,
    corners: orderCorners(corners.map((p) => ({ ...p }))),
    format: a4 ? a4FormatFor(canvas, corners) : state.lastFormat,
    stretch: a4 ? true : state.lastStretch,
    erase: [],
  };
  state.pages.push(page);
  updatePageCount();
  return page;
}

/** Zur Seitenübersicht wechseln (nach einem Stapel-Scan) */
export function showPages() {
  if (state.root) view('pages');
}

/** Anzahl der bisher gesammelten Seiten */
export function pageCount() {
  return state.pages.length;
}

/** Fortschritt/Countdown im Scanner anzeigen (für den Stapel-Scan) */
export function setScanStatus(text) {
  if (!state.root) return;
  state.batchStatus = text || '';
  const stop = $('#scBatchStopBtn', state.root);
  if (stop) {
    stop.hidden = !text;
    stop.classList.toggle('hidden', !text);
  }
  const el = $('#scPageCount', state.root);
  if (!el) return;
  if (text) el.textContent = text;
  else updatePageCount();
}

// Weitere Seite vom Netzwerk-Scanner holen und an den laufenden Scan anhängen.
async function addNetworkPage(btn) {
  if (!state.netScan || state.netBusy) return;
  state.netBusy = true;
  const buttons = [$('#scNetScanBtn', state.root), $('#scAddNetBtn', state.root)].filter(Boolean);
  const labels = buttons.map((b) => b.innerHTML);
  buttons.forEach((b) => { b.disabled = true; b.classList.add('busy'); });
  if (btn) btn.innerHTML = '<span>Scanne … bitte Vorlage auflegen</span>';
  try {
    const file = await state.netScan();
    importFiles([file]);
  } catch (e) {
    alert(`Netzwerk-Scan fehlgeschlagen: ${e?.message || e}`);
  } finally {
    state.netBusy = false;
    buttons.forEach((b, i) => { b.disabled = false; b.classList.remove('busy'); b.innerHTML = labels[i]; });
  }
}

// Für die automatisierten Tests
window.__pdfscanner = {
  detectDocumentCorners,
  detectCornersOnCanvas,
  warpPerspective,
  orderCorners,
  outputSize,
  applyErase,
  openScanner,
  state,
};
