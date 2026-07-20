// Dokumenten-Scanner: Kamera (mit optionalem Blitz) oder Bilddateien,
// automatische Rand-/Eckenerkennung mit manueller Korrektur (inkl. Lupe),
// Perspektivkorrektur, A4-/Auto-Format, Drehen – Ergebnis wird als PDF an
// die Dateiliste übergeben, wo Kompressionsstufe & „Scan-Stil“ gewählt werden.

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
    <strong>📷 Dokument scannen</strong>
    <span class="sc-pagecount" id="scPageCount"></span>
    <button class="btn btn-small btn-ghost" id="scCloseBtn">✕ Schließen</button>
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
      <button class="sc-round-btn" id="scTorchBtn" title="Blitz (Taschenlampe) an/aus" aria-pressed="false" hidden>⚡</button>
      <button class="sc-shutter" id="scShutterBtn" title="Foto aufnehmen" aria-label="Foto aufnehmen"><span></span></button>
      <button class="sc-round-btn" id="scPickBtn" title="Bilder aus Dateien wählen">🖼️</button>
    </div>
    <div class="sc-bottombar">
      <button class="btn" id="scToPagesBtn" hidden>Zu den Seiten →</button>
    </div>
    <input type="file" id="scFileInput" accept="image/*" multiple hidden>
  </div>

  <!-- Zuschnitt -->
  <div class="sc-view hidden" id="scCropView">
    <div class="sc-toolbar">
      <button class="btn btn-small" id="scAutoBtn">🪄 Automatisch erkennen</button>
      <button class="btn btn-small" id="scFullBtn">⬜ Ganze Seite</button>
      <span class="sc-sep"></span>
      <span class="sc-seg" role="radiogroup" aria-label="Ausgabeformat">
        <button class="sc-seg-btn" data-format="auto">Auto</button>
        <button class="sc-seg-btn" data-format="a4p">A4 hoch</button>
        <button class="sc-seg-btn" data-format="a4l">A4 quer</button>
      </span>
      <label class="sc-check hidden" id="scStretchWrap" title="Scan auf das ganze A4-Blatt dehnen – verzerrt das Seitenverhältnis. Ohne Häkchen wird der Scan unverzerrt auf A4 eingepasst.">
        <input type="checkbox" id="scStretch"> auf A4 strecken
      </label>
      <span class="sc-sep"></span>
      <button class="btn btn-small" id="scRotateBtn">↻ Drehen 90°</button>
    </div>
    <div class="sc-crop-stage" id="scCropStage">
      <canvas id="scCropCanvas"></canvas>
      <svg id="scCropSvg" tabindex="0" aria-label="Ecken anpassen (Pfeiltasten bewegen die zuletzt gewählte Ecke)"></svg>
      <div class="sc-loupe hidden" id="scLoupe"><canvas width="150" height="150"></canvas></div>
    </div>
    <p class="sc-hint">Ecken (● groß) oder Kanten (● klein) ziehen – die Lupe zeigt die Ecke vergrößert, damit du sie exakt triffst. Pfeiltasten justieren fein nach.</p>
    <div class="sc-bottombar">
      <button class="btn" id="scCropCancelBtn">Verwerfen</button>
      <button class="btn btn-primary" id="scCropOkBtn">Übernehmen ✓</button>
    </div>
  </div>

  <!-- Radierer (weiß übermalen) -->
  <div class="sc-view hidden" id="scEraseView">
    <div class="sc-toolbar">
      <label class="sc-brush-label">🧽 Pinselgröße
        <input type="range" id="scBrushSize" min="6" max="90" step="1" value="26">
        <span class="sc-brush-dot" id="scBrushDot"></span>
      </label>
      <span class="sc-sep"></span>
      <button class="btn btn-small" id="scEraseUndoBtn" title="Rückgängig">↶</button>
      <button class="btn btn-small" id="scEraseRedoBtn" title="Wiederholen">↷</button>
    </div>
    <div class="sc-erase-stage" id="scEraseStage"><canvas id="scEraseCanvas"></canvas></div>
    <p class="sc-hint">Mit dem weißen Pinsel über Ränder, Schatten oder Störungen malen, um sie zu entfernen.</p>
    <div class="sc-bottombar">
      <button class="btn" id="scEraseCancelBtn">Verwerfen</button>
      <button class="btn btn-primary" id="scEraseOkBtn">Fertig ✓</button>
    </div>
  </div>

  <!-- Seitenübersicht -->
  <div class="sc-view hidden" id="scPagesView">
    <div class="sc-pagegrid" id="scPageGrid"></div>
    <div class="sc-row">
      <button class="btn" id="scAddCamBtn">📷 Seite mit Kamera</button>
      <button class="btn" id="scAddFileBtn">🖼️ Seiten aus Bildern</button>
    </div>
    <p class="sc-hint">Nach „Als PDF übernehmen“ wählst du links die Kompressionsstufe und den „Scan-Stil“ (z.&nbsp;B. „Extrem S/W – Scanner-Stil“) und klickst auf „Komprimieren“.</p>
    <div class="sc-bottombar">
      <button class="btn btn-primary" id="scDoneBtn">✓ Als PDF übernehmen</button>
    </div>
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
  el.textContent = n === 0 ? '' : `${n} Seite${n === 1 ? '' : 'n'}`;
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
    msg.innerHTML = 'Keine Kamera verfügbar.<br>Nutze <strong>🖼️ Bilder wählen</strong>, um Fotos aus Dateien zu scannen.';
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
    msg.innerHTML = `Kamera nicht verfügbar (${e?.name || e}).<br>Nutze <strong>🖼️ Bilder wählen</strong>, um Fotos aus Dateien zu scannen.`;
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
  return c;
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
  openCrop(canvases[0], null, state.pages.length > 0 ? 'pages' : 'capture');
}

// ------------------------------------------------ Zuschnitt (Ecken + Lupe)

function openCrop(srcCanvas, pageIndex, returnTo) {
  const existing = pageIndex != null ? state.pages[pageIndex] : null;
  state.cropReturn = returnTo;
  state.editing = {
    src: existing ? existing.src : srcCanvas,
    corners: existing ? existing.corners.map((p) => ({ ...p }))
      : (detectCornersOnCanvas(srcCanvas) || defaultCorners()),
    format: existing ? existing.format : state.lastFormat,
    stretch: existing ? !!existing.stretch : state.lastStretch,
    pageIndex,
  };
  state.activeHandle = null;
  view('crop');
  renderCrop();
}

function cropDisplayMetrics() {
  const stage = $('#scCropStage', state.root);
  const src = state.editing.src;
  const maxW = stage.clientWidth - 16;
  const maxH = stage.clientHeight - 16;
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
  svg.setAttribute('viewBox', `0 0 ${dw} ${dh}`);
  svg.style.width = `${dw}px`;
  svg.style.height = `${dh}px`;
  drawCropOverlay();
  // Formatwahl markieren
  state.root.querySelectorAll('.sc-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.format === ed.format);
    b.setAttribute('aria-pressed', String(b.dataset.format === ed.format));
  });
  $('#scStretchWrap', state.root).classList.toggle('hidden', ed.format === 'auto');
  $('#scStretch', state.root).checked = !!ed.stretch;
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
        <circle cx="${m.x}" cy="${m.y}" r="20" fill="transparent"></circle>
        <circle cx="${m.x}" cy="${m.y}" r="7" fill="#38bdf8" stroke="#06232f" stroke-width="2"></circle>
      </g>`).join('')}
    ${pts.map((p, i) => `
      <g class="sc-handle sc-handle-corner" data-corner="${i}">
        <circle cx="${p.x}" cy="${p.y}" r="26" fill="transparent"></circle>
        <circle cx="${p.x}" cy="${p.y}" r="11" fill="rgba(56,189,248,0.25)" stroke="#38bdf8" stroke-width="3"></circle>
        <circle cx="${p.x}" cy="${p.y}" r="2.5" fill="#38bdf8"></circle>
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
  return {
    x: clamp((e.clientX - r.left) / r.width, 0, 1),
    y: clamp((e.clientY - r.top) / r.height, 0, 1),
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
  };
  view('erase');
  renderErase();
  updateEraseButtons();
}

function renderErase() {
  const er = state.erasing;
  if (!er) return;
  const page = state.pages[er.pageIndex];
  const stage = $('#scEraseStage', state.root);
  const { w, h } = outputSize(page.src.width, page.src.height, page.corners);
  const fit = Math.min((stage.clientWidth - 16) / w, (stage.clientHeight - 16) / h, 1);
  const dw = Math.max(1, Math.round(w * fit));
  const dh = Math.max(1, Math.round(h * fit));
  if (!er.base || er.base.width !== dw || er.base.height !== dh) {
    er.base = warpPerspective(page.src, page.corners, dw, dh);
  }
  const canvas = $('#scEraseCanvas', state.root);
  canvas.width = dw;
  canvas.height = dh;
  canvas.getContext('2d').drawImage(er.base, 0, 0);
  applyErase(canvas, page.erase);
}

function updateEraseButtons() {
  const er = state.erasing;
  $('#scEraseUndoBtn', state.root).disabled = !er || er.undo.length === 0;
  $('#scEraseRedoBtn', state.root).disabled = !er || er.redo.length === 0;
}

function erasePoint(e) {
  const canvas = $('#scEraseCanvas', state.root);
  const r = canvas.getBoundingClientRect();
  return {
    x: clamp((e.clientX - r.left) / r.width, 0, 1),
    y: clamp((e.clientY - r.top) / r.height, 0, 1),
  };
}

function onErasePointerDown(e) {
  const er = state.erasing;
  if (!er) return;
  e.preventDefault();
  const canvas = $('#scEraseCanvas', state.root);
  canvas.setPointerCapture?.(e.pointerId);
  const page = state.pages[er.pageIndex];
  er.undo.push(JSON.stringify(page.erase));
  if (er.undo.length > 60) er.undo.shift();
  er.redo = [];
  const size = parseInt($('#scBrushSize', state.root).value, 10) / canvas.width;
  er.drawing = { size, points: [erasePoint(e)] };
  page.erase.push(er.drawing);
  renderErase();
  updateEraseButtons();
}

function onErasePointerMove(e) {
  const er = state.erasing;
  if (!er?.drawing) return;
  e.preventDefault();
  er.drawing.points.push(erasePoint(e));
  renderErase();
}

function onErasePointerUp() {
  if (state.erasing) state.erasing.drawing = null;
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

function renderPages() {
  const grid = $('#scPageGrid', state.root);
  grid.innerHTML = '';
  state.pages.forEach((page, idx) => {
    const cell = document.createElement('div');
    cell.className = 'sc-pagecell';
    const thumb = composeThumb(page);
    thumb.className = 'sc-thumb';
    const label = document.createElement('div');
    label.className = 'sc-pagelabel';
    let fmt = page.format === 'a4p' ? 'A4 hoch' : page.format === 'a4l' ? 'A4 quer' : 'Auto';
    if (page.format !== 'auto' && page.stretch) fmt += ' · gestreckt';
    label.textContent = `Seite ${idx + 1} · ${fmt}`;
    const bar = document.createElement('div');
    bar.className = 'sc-pagecell-bar';
    const mk = (txt, title, fn, disabled = false) => {
      const b = document.createElement('button');
      b.className = 'btn btn-small';
      b.textContent = txt;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      return b;
    };
    bar.append(
      mk('✂️', 'Zuschnitt/Format bearbeiten', () => openCrop(null, idx, 'pages')),
      mk('🧽', 'Radieren – Ränder/Schatten weiß übermalen', () => openErase(idx)),
      mk('←', 'Nach vorne schieben', () => {
        [state.pages[idx - 1], state.pages[idx]] = [state.pages[idx], state.pages[idx - 1]];
        renderPages();
      }, idx === 0),
      mk('→', 'Nach hinten schieben', () => {
        [state.pages[idx + 1], state.pages[idx]] = [state.pages[idx], state.pages[idx + 1]];
        renderPages();
      }, idx === state.pages.length - 1),
      mk('✕', 'Seite löschen', () => {
        state.pages.splice(idx, 1);
        if (state.pages.length === 0) view('capture');
        else renderPages();
        updatePageCount();
      }),
    );
    cell.append(thumb, label, bar);
    grid.appendChild(cell);
  });
  $('#scDoneBtn', state.root).textContent = `✓ Als PDF übernehmen (${state.pages.length} Seite${state.pages.length === 1 ? '' : 'n'})`;
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
    btn.textContent = '✓ Als PDF übernehmen';
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
  if (e.key === 'Escape' && state.root) closeScanner();
}

function onResize() {
  if (state.root && state.editing) renderCrop();
  if (state.root && state.erasing) renderErase();
}

/**
 * Öffnet den Scanner. onDone(file) erhält das fertige Scan-PDF (File).
 */
export function openScanner(onDone) {
  if (state.root) return;
  const root = document.createElement('div');
  root.id = 'scannerRoot';
  root.innerHTML = TEMPLATE;
  document.body.appendChild(root);
  state.root = root;
  state.onDone = onDone;
  state.pages = [];
  state.queue = [];
  state.lastFormat = 'auto';

  $('#scCloseBtn', root).addEventListener('click', () => {
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
  $('#scAddCamBtn', root).addEventListener('click', () => view('capture'));

  $('#scAutoBtn', root).addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.corners = detectCornersOnCanvas(state.editing.src) || defaultCorners();
    drawCropOverlay();
  });
  $('#scFullBtn', root).addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.corners = defaultCorners(0);
    drawCropOverlay();
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
  view('capture');
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
