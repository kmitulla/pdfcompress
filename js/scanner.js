// Scan-Studio: Fotos (Kamera des Geräts oder Bilddateien) und Seiten vom
// Netzwerk-Scanner werden hier zu sauberen DIN-A4-Seiten: automatischer
// Zuschnitt (Flachbett: fester A4-Ausschnitt ab der Anlegeecke; Foto:
// Eckenerkennung mit Perspektivkorrektur), manuell nachjustierbar mit Lupe,
// weißer Radierer, Drehen, Umsortieren. Am Ende entsteht EIN PDF, das als
// Dokument in die Liste wandert.
//
// Eine Live-Kameravorschau gibt es bewusst nicht mehr: Die Kamera-App des
// Geräts liefert bessere Fotos (Fokus, Belichtung, HDR) und funktioniert auch
// ohne HTTPS.

import { hydrateIcons, icon } from './icons.js';
import { toast, confirmDialog, alertDialog } from './ui.js';
import { A4_PT, readJpegDpi } from './pdfkit.js';

const $ = (sel, root = document) => root.querySelector(sel);

const DETECT_MAX = 440;      // Analysebreite für die Eckenerkennung
// Längste Kante beim Einlesen: 300-dpi-A4-Scans (3508 px) bleiben unangetastet.
const IMPORT_MAX = /iPhone|iPad|Android/i.test(navigator.userAgent) ? 3600 : 4200;
const OUTPUT_MAX = 3600;     // längste Kante des entzerrten Scans

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

function defaultCorners(margin = 0) {
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
  // Nie hochrechnen – das erfindet keine Details, macht die Datei nur größer
  const scale = Math.min(1, OUTPUT_MAX / Math.max(quadW, quadH));
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

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- A4 auf der Glasfläche

/**
 * Fester A4-Ausschnitt für Flachbett-Scans.
 *
 * Aus Pixelgröße und Scanauflösung ergibt sich die echte Glasfläche in mm
 * (der Epson ET-2720 z. B. 215,9 × 297 mm). Der Ausschnitt ist exakt
 * 210 × 297 mm ab der Anlegeecke, optional um ein paar Millimeter
 * feinjustiert. Bewusst keine Kantenerkennung: Weißes Papier vor weißem
 * Deckel liefert kein verlässliches Signal – mit der festen Position sitzt
 * jede Seite immer exakt gleich.
 *
 * @param canvas  Bild mit `scanDpi` (und optional `sourcePx` = Originalpixel)
 * @param corner  'tl' | 'tr' | 'bl' | 'br' – wo die Vorlage anliegt
 * @param offX/offY Versatz in mm (+ = nach rechts/unten)
 * @param rect    kalibrierter Ausschnitt in mm auf der Glasfläche {x, y, w}
 *                (Höhe immer w · 297/210) – hat Vorrang vor Ecke/Versatz
 * @returns normierte Ecken (TL, TR, BR, BL) oder null ohne bekannte Maße
 */
export function a4CornersForScan(canvas, { corner = 'tl', offX = 0, offY = 0, rect = null } = {}) {
  const dpi = canvas?.scanDpi;
  const px = canvas?.sourcePx || (canvas ? { w: canvas.width, h: canvas.height } : null);
  if (!dpi || !px?.w || !px?.h) return null;
  const bedW = (px.w / dpi) * 25.4;
  const bedH = (px.h / dpi) * 25.4;
  const landscape = bedW > bedH * 1.05;
  if (rect && rect.w > 0 && !landscape) {
    const fw = Math.min(1, rect.w / bedW);
    const fh = Math.min(1, (rect.w * 297 / 210) / bedH);
    const x0 = clamp((Number(rect.x) || 0) / bedW, 0, 1 - fw);
    const y0 = clamp((Number(rect.y) || 0) / bedH, 0, 1 - fh);
    return [
      { x: x0, y: y0 }, { x: x0 + fw, y: y0 },
      { x: x0 + fw, y: y0 + fh }, { x: x0, y: y0 + fh },
    ];
  }
  const [aw, ah] = landscape ? [297, 210] : [210, 297];
  const fw = Math.min(1, aw / bedW);
  const fh = Math.min(1, ah / bedH);
  const right = corner === 'tr' || corner === 'br';
  const bottom = corner === 'bl' || corner === 'br';
  const x0 = clamp((right ? 1 - fw : 0) + (Number(offX) || 0) / bedW, 0, 1 - fw);
  const y0 = clamp((bottom ? 1 - fh : 0) + (Number(offY) || 0) / bedH, 0, 1 - fh);
  return [
    { x: x0, y: y0 }, { x: x0 + fw, y: y0 },
    { x: x0 + fw, y: y0 + fh }, { x: x0, y: y0 + fh },
  ];
}

/** Ist das ein Flachbett-Scan? Dann ist die physische Größe plausibel klein. */
export function plausibleBedScan(w, h, dpi) {
  if (!dpi || dpi < 100 || dpi > 1200) return false;
  const a = Math.min(w, h) / dpi * 25.4;
  const b = Math.max(w, h) / dpi * 25.4;
  return a >= 140 && a <= 330 && b >= 200 && b <= 460;
}

const A4_RATIO = 210 / 297;

/**
 * Automatischer Zuschnitt einer neuen Seite.
 *  - Flachbett: fester A4-Ausschnitt, exakt auf A4 abgebildet
 *  - Foto: Ecken erkennen; ist das Blatt (fast) A4, exakt aufziehen,
 *    sonst unverzerrt auf A4 einpassen
 *  - nichts erkannt: ganzes Bild, auf A4 eingepasst
 */
export function autoLayout(canvas, { geometry = {}, a4 = true } = {}) {
  const bed = canvas.scanDpi ? a4CornersForScan(canvas, geometry) : null;
  if (bed) return { corners: bed, format: a4FormatFor(canvas, bed), stretch: true, how: 'bed' };
  const det = detectCornersOnCanvas(canvas);
  const corners = det || defaultCorners(0);
  const { w, h } = outputSize(canvas.width, canvas.height, corners);
  const portrait = h >= w;
  const ratio = portrait ? w / h : h / w;
  if (!a4) return { corners, format: 'auto', stretch: false, how: det ? 'photo' : 'full' };
  return {
    corners,
    format: portrait ? 'a4p' : 'a4l',
    stretch: !!det && Math.abs(ratio / A4_RATIO - 1) < 0.06,
    how: det ? 'photo' : 'full',
  };
}

/** Hoch- oder Querformat für eine Auswahl bestimmen (in Quellpixeln gemessen) */
function a4FormatFor(src, corners) {
  const w = Math.abs(corners[1].x - corners[0].x) * (src?.width || 1);
  const h = Math.abs(corners[3].y - corners[0].y) * (src?.height || 1);
  return h >= w ? 'a4p' : 'a4l';
}

// ---------------------------------------------------------------- Bilder einlesen

async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Bild „${blob.name || 'Bild'}“ konnte nicht gelesen werden`));
      img.src = URL.createObjectURL(blob);
    });
  }
}

/** Bild in ein (ggf. verkleinertes) Canvas laden, gedreht um `rot` Grad. */
async function blobToCanvas(blob, rot = 0) {
  const bmp = await decodeImage(blob);
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, IMPORT_MAX / Math.max(w, h));
  let c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  if (bmp.src) URL.revokeObjectURL(bmp.src);
  for (let r = 0; r < ((rot / 90) | 0) % 4; r++) c = rotateCanvas90(c);
  c.origPx = { w, h };
  return c;
}

/** Scanauflösung einer Datei: vom Server mitgegeben, im Namen oder im JPEG-Kopf. */
async function scanDpiOf(file, w, h) {
  if (file.scanDpi) return file.scanDpi;
  const m = /(\d{2,4})\s*dpi/i.exec(file.name || '');
  let dpi = m ? parseInt(m[1], 10) : null;
  if (!dpi && /jpe?g/i.test(file.type || file.name || '')) {
    try { dpi = readJpegDpi(new Uint8Array(await file.slice(0, 131072).arrayBuffer())); } catch { dpi = null; }
  }
  return dpi && plausibleBedScan(w, h, dpi) ? dpi : null;
}

// Dekodierte Quellbilder nur für die zuletzt benutzten Seiten im Speicher
// halten. Am iPhone würden zehn 300-dpi-Seiten sonst über 300 MB belegen.
const srcCache = [];   // [{page, rot, canvas}]
async function getSrc(page) {
  const hit = srcCache.find((e) => e.page === page && e.rot === page.rot);
  if (hit) return hit.canvas;
  const canvas = await blobToCanvas(page.blob, page.rot);
  if (page.scanDpi) {
    canvas.scanDpi = page.scanDpi;
    const turned = (page.rot / 90) % 2 === 1;
    canvas.sourcePx = turned ? { w: page.px.h, h: page.px.w } : { ...page.px };
  }
  srcCache.unshift({ page, rot: page.rot, canvas });
  while (srcCache.length > 2) srcCache.pop();
  return canvas;
}
function dropSrc(page) {
  for (let i = srcCache.length - 1; i >= 0; i--) if (srcCache[i].page === page) srcCache.splice(i, 1);
}

// ---------------------------------------------------------------- Studio-Zustand

const state = {
  root: null,
  onDone: null,
  opts: {},
  pages: [],        // {blob, px:{w,h}, scanDpi, rot, corners, format, stretch, erase, thumb}
  pending: 0,       // Bilder, die gerade eingelesen werden
  editing: null,    // Zuschnitt: {src, corners, format, stretch, rot, isBedScan, pageIndex}
  erasing: null,
  drag: null,
  activeHandle: null,
  building: false,
  batchStatus: '',
  previewIdx: null,
  view: 'pages',
};

const geometry = () => state.opts.geometry?.() || { corner: 'tl', offX: 0, offY: 0 };
const wantA4 = () => (state.opts.a4 ? !!state.opts.a4() : true);

const TEMPLATE = `
<div class="sc-overlay" role="dialog" aria-modal="true" aria-label="Scan-Studio">
  <header class="sc-topbar">
    <button class="btn btn-icon btn-ghost" id="scCloseBtn" aria-label="Schließen"><i data-icon="close"></i></button>
    <div class="sc-title"><strong>Scan-Studio</strong><small id="scPageCount"></small></div>
    <button class="btn btn-small btn-danger hidden" id="scBatchStopBtn"><i data-icon="stop" data-icon-size="15"></i><span>Stopp</span></button>
    <button class="btn btn-primary" id="scDoneBtn" disabled><i data-icon="check" data-icon-size="17"></i><span>Fertig</span></button>
  </header>

  <!-- Seiten -->
  <div class="sc-view" id="scPagesView">
    <div class="sc-pagegrid" id="scPageGrid"></div>
    <p class="sc-hint" id="scPagesHint">Seite antippen für große Vorschau · <i data-icon="crop" data-icon-size="13"></i> Zuschnitt · <i data-icon="eraser" data-icon-size="13"></i> Radierer. <span class="sc-hint-long">Alle Seiten werden zusammen zu <strong>einer</strong> PDF.</span></p>
  </div>

  <!-- Zuschnitt -->
  <div class="sc-view hidden" id="scCropView">
    <div class="sc-toolbar">
      <span class="sc-tgroup">
        <span class="sc-tlabel">Auswahl</span>
        <button class="btn btn-small hidden" id="scA4BedBtn" title="Fester A4-Ausschnitt ab der Anlegeecke"><i data-icon="a4" data-icon-size="15"></i><span>A4-Fläche</span></button>
        <button class="btn btn-small hidden" id="scA4CornerBtn" title="Anlegeecke wechseln"><i data-icon="rotate" data-icon-size="15"></i><span id="scCornerLabel">Ecke</span></button>
        <button class="btn btn-small" id="scAutoBtn" title="Dokumentränder automatisch erkennen"><i data-icon="wand" data-icon-size="15"></i><span>Erkennen</span></button>
        <button class="btn btn-small" id="scFullBtn" title="Das ganze Bild auswählen"><i data-icon="square" data-icon-size="15"></i><span>Alles</span></button>
      </span>
      <span class="sc-sep"></span>
      <span class="sc-tgroup">
        <span class="sc-tlabel">Format</span>
        <span class="sc-seg" role="radiogroup" aria-label="Ausgabeformat">
          <button class="sc-seg-btn" data-format="a4p" title="DIN A4 hochkant">A4 hoch</button>
          <button class="sc-seg-btn" data-format="a4l" title="DIN A4 quer">A4 quer</button>
          <button class="sc-seg-btn" data-format="auto" title="Seitenformat folgt der Auswahl">Frei</button>
        </span>
        <label class="sc-check hidden" id="scStretchWrap" title="Auswahl auf das ganze A4-Blatt ziehen. Ohne Häkchen wird unverzerrt eingepasst.">
          <input type="checkbox" id="scStretch"> exakt füllen
        </label>
      </span>
      <span class="sc-sep"></span>
      <span class="sc-tgroup">
        <span class="sc-tlabel">Seitenverhältnis</span>
        <span class="sc-seg" role="radiogroup" aria-label="Seitenverhältnis beim Ziehen">
          <button class="sc-lock-btn" data-lock="free" title="Ecken frei ziehen (Perspektive)">Frei</button>
          <button class="sc-lock-btn" data-lock="a4" title="Rechteck im DIN-A4-Verhältnis">A4</button>
          <button class="sc-lock-btn" data-lock="keep" title="Aktuelles Verhältnis beibehalten">Fest</button>
        </span>
      </span>
      <span class="sc-sep"></span>
      <button class="btn btn-small" id="scRotateBtn" title="Um 90° drehen"><i data-icon="rotate" data-icon-size="15"></i><span>Drehen</span></button>
    </div>
    <div class="sc-crop-stage" id="scCropStage">
      <canvas id="scCropCanvas"></canvas>
      <svg id="scCropSvg" tabindex="0" aria-label="Ecken anpassen (Pfeiltasten bewegen die zuletzt gewählte Ecke)"></svg>
      <div class="sc-loupe hidden" id="scLoupe"><canvas width="150" height="150"></canvas></div>
    </div>
    <p class="sc-hint" id="scCropHint">Ecken (groß) oder Kanten (klein) ziehen – die Lupe zeigt die Ecke vergrößert. <span class="sc-hint-long">Pfeiltasten justieren fein nach.</span></p>
    <div class="sc-bottombar">
      <button class="btn" id="scCropCancelBtn">Abbrechen</button>
      <button class="btn btn-primary" id="scCropOkBtn"><i data-icon="check" data-icon-size="16"></i><span>Übernehmen</span></button>
    </div>
  </div>

  <!-- Radierer (weiß übermalen) -->
  <div class="sc-view hidden" id="scEraseView">
    <div class="sc-toolbar">
      <label class="sc-brush-label"><i data-icon="eraser" data-icon-size="16"></i> Pinsel
        <input type="range" id="scBrushSize" min="6" max="90" step="1" value="26">
        <span class="sc-brush-dot" id="scBrushDot"></span>
      </label>
      <span class="sc-sep"></span>
      <span class="sc-tgroup">
        <button class="btn btn-small btn-icon" id="scEraseZoomOut" title="Herauszoomen" aria-label="Herauszoomen"><i data-icon="minus" data-icon-size="15"></i></button>
        <span class="sc-zoomlabel" id="scEraseZoomLabel">100 %</span>
        <button class="btn btn-small btn-icon" id="scEraseZoomIn" title="Hineinzoomen" aria-label="Hineinzoomen"><i data-icon="plus" data-icon-size="15"></i></button>
        <button class="btn btn-small" id="scEraseZoomFit" title="Einpassen">Fit</button>
      </span>
      <span class="sc-sep"></span>
      <button class="btn btn-small btn-icon" id="scEraseUndoBtn" title="Rückgängig" aria-label="Rückgängig"><i data-icon="undo" data-icon-size="15"></i></button>
      <button class="btn btn-small btn-icon" id="scEraseRedoBtn" title="Wiederholen" aria-label="Wiederholen"><i data-icon="redo" data-icon-size="15"></i></button>
    </div>
    <div class="sc-erase-stage" id="scEraseStage"><canvas id="scEraseCanvas"></canvas></div>
    <p class="sc-hint">Mit dem weißen Pinsel über Ränder, Schatten oder Störungen malen. <span class="sc-hint-long">Zoomen mit zwei Fingern, Mausrad oder den Tasten – ein Finger radiert.</span></p>
    <div class="sc-bottombar">
      <button class="btn" id="scEraseCancelBtn">Abbrechen</button>
      <button class="btn btn-primary" id="scEraseOkBtn"><i data-icon="check" data-icon-size="16"></i><span>Fertig</span></button>
    </div>
  </div>

  <!-- Große Seitenvorschau -->
  <div class="sc-preview hidden" id="scPreview" role="dialog" aria-modal="true" aria-label="Seitenvorschau">
    <div class="sc-preview-bar">
      <button class="btn btn-icon btn-ghost" id="scPreviewClose" aria-label="Schließen"><i data-icon="close"></i></button>
      <span class="sc-preview-label" id="scPreviewLabel"></span>
      <button class="btn btn-small btn-icon" id="scPreviewPrev" aria-label="Vorherige Seite"><i data-icon="chevronLeft" data-icon-size="15"></i></button>
      <button class="btn btn-small btn-icon" id="scPreviewNext" aria-label="Nächste Seite"><i data-icon="chevronRight" data-icon-size="15"></i></button>
      <span class="sc-sep"></span>
      <button class="btn btn-small" id="scPreviewCrop"><i data-icon="crop" data-icon-size="15"></i><span>Zuschnitt</span></button>
      <button class="btn btn-small" id="scPreviewErase"><i data-icon="eraser" data-icon-size="15"></i><span>Radieren</span></button>
    </div>
    <div class="sc-preview-stage" id="scPreviewStage"></div>
  </div>

  <input type="file" id="scFileInput" accept="image/*,.heic,.heif" multiple hidden>
  <input type="file" id="scCamInput" accept="image/*" capture="environment" hidden>
</div>`;

function view(name) {
  state.view = name;
  $('#scPagesView', state.root).classList.toggle('hidden', name !== 'pages');
  $('#scCropView', state.root).classList.toggle('hidden', name !== 'crop');
  $('#scEraseView', state.root).classList.toggle('hidden', name !== 'erase');
  const onPages = name === 'pages';
  $('#scDoneBtn', state.root).classList.toggle('hidden', !onPages);
  if (onPages) renderPages();
  updatePageCount();
}

function updatePageCount() {
  if (!state.root) return;
  const el = $('#scPageCount', state.root);
  const n = state.pages.length;
  // Läuft gerade ein Stapel-Scan, hat dessen Fortschrittstext Vorrang.
  el.textContent = state.batchStatus
    || (n + state.pending === 0 ? 'Noch keine Seiten' : `${n} Seite${n === 1 ? '' : 'n'}${state.pending ? ` · ${state.pending} wird gelesen …` : ''}`);
  const done = $('#scDoneBtn', state.root);
  done.disabled = n === 0 || state.pending > 0 || state.building;
  if (!state.building) done.querySelector('span').textContent = n > 0 ? `Fertig (${n})` : 'Fertig';
}

// ---------------------------------------------------------------- Seiten anlegen

/** Bilddatei einlesen, automatisch zuschneiden und als Seite anhängen. */
async function addImageFile(file) {
  state.pending++;
  renderPages();
  try {
    const canvas = await blobToCanvas(file);
    const px = canvas.origPx;
    const dpi = await scanDpiOf(file, px.w, px.h);
    if (dpi) {
      canvas.scanDpi = dpi;
      canvas.sourcePx = px;
    }
    const lay = autoLayout(canvas, { geometry: geometry(), a4: wantA4() });
    const page = {
      blob: file,
      px,
      scanDpi: dpi,
      rot: 0,
      corners: orderCorners(lay.corners.map((p) => ({ ...p }))),
      format: lay.format,
      stretch: lay.stretch,
      how: lay.how,
      erase: [],
      thumb: null,
    };
    srcCache.unshift({ page, rot: 0, canvas });
    while (srcCache.length > 2) srcCache.pop();
    state.pages.push(page);
    return page;
  } finally {
    state.pending--;
    if (state.root && state.view === 'pages') renderPages();
    updatePageCount();
  }
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(f.name || ''));
  for (const f of files) {
    try {
      await addImageFile(f);
    } catch (e) {
      toast(e?.message || String(e), 'err', 5000);
    }
  }
}

// ---------------------------------------------------------------- Seitenübersicht

// Miniatur der fertigen Seite (inkl. A4-Einpassung/Streckung & Radierungen)
function composeThumb(page, src, thumbH = 190) {
  const { w, h } = outputSize(src.width, src.height, page.corners);
  const isA4 = page.format === 'a4p' || page.format === 'a4l';
  if (!isA4) {
    const tw = Math.max(24, Math.round(thumbH * (w / h)));
    return applyErase(warpPerspective(src, page.corners, tw, thumbH), page.erase);
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
  const warped = applyErase(warpPerspective(src, page.corners, iw, ih), page.erase);
  ctx.drawImage(warped, Math.round((tw - iw) / 2), Math.round((thumbH - ih) / 2));
  return c;
}

async function thumbFor(page) {
  if (!page.thumb) {
    const src = await getSrc(page);
    page.thumb = composeThumb(page, src, 460).toDataURL('image/jpeg', 0.85);
  }
  return page.thumb;
}

function formatLabel(page) {
  let fmt = page.format === 'a4p' ? 'A4 hoch' : page.format === 'a4l' ? 'A4 quer' : 'Frei';
  if (page.format !== 'auto' && page.stretch) fmt += ' · exakt';
  if (page.how === 'bed') fmt += ' · Glasfläche';
  return fmt;
}

let renderToken = 0;
async function renderPages() {
  if (!state.root) return;
  const token = ++renderToken;
  const grid = $('#scPageGrid', state.root);
  const frag = document.createDocumentFragment();
  const mk = (html, title, fn, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'btn btn-small btn-icon';
    b.innerHTML = html;   // Icons aus dem eigenen Set, keine Benutzereingabe
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = disabled;
    b.addEventListener('click', fn);
    return b;
  };
  state.pages.forEach((page, idx) => {
    const cell = document.createElement('div');
    cell.className = 'sc-pagecell';
    const wrap = document.createElement('div');
    wrap.className = 'sc-thumb-wrap';
    const img = document.createElement('img');
    img.className = 'sc-thumb';
    img.alt = `Seite ${idx + 1}`;
    img.title = 'Tippen für große Vorschau';
    img.setAttribute('role', 'button');
    img.tabIndex = 0;
    img.addEventListener('click', () => openPagePreview(idx));
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPagePreview(idx); }
    });
    if (page.thumb) img.src = page.thumb;
    else thumbFor(page).then((u) => { if (token === renderToken || img.isConnected) img.src = u; }).catch(() => {});
    const no = document.createElement('span');
    no.className = 'sc-pageno';
    no.textContent = String(idx + 1);
    wrap.append(img, no);
    const label = document.createElement('div');
    label.className = 'sc-pagelabel';
    label.textContent = formatLabel(page);
    const bar = document.createElement('div');
    bar.className = 'sc-pagecell-bar';
    bar.append(
      mk(icon('crop', { size: 15 }), 'Zuschnitt & Format', () => openCrop(idx)),
      mk(icon('eraser', { size: 15 }), 'Radieren – Ränder/Schatten weiß übermalen', () => openErase(idx)),
      mk(icon('chevronLeft', { size: 15 }), 'Nach vorne', () => {
        [state.pages[idx - 1], state.pages[idx]] = [state.pages[idx], state.pages[idx - 1]];
        renderPages();
      }, idx === 0),
      mk(icon('chevronRight', { size: 15 }), 'Nach hinten', () => {
        [state.pages[idx + 1], state.pages[idx]] = [state.pages[idx], state.pages[idx + 1]];
        renderPages();
      }, idx === state.pages.length - 1),
      mk(icon('trash', { size: 15 }), 'Seite löschen', () => {
        dropSrc(state.pages[idx]);
        state.pages.splice(idx, 1);
        renderPages();
      }),
    );
    cell.append(wrap, label, bar);
    frag.appendChild(cell);
  });
  for (let i = 0; i < state.pending; i++) {
    const cell = document.createElement('div');
    cell.className = 'sc-pagecell';
    cell.innerHTML = `<div class="sc-thumb-wrap sc-pending">${icon('spinner', { size: 28 })}</div><div class="sc-pagelabel">wird eingelesen …</div>`;
    frag.appendChild(cell);
  }
  // Kachel zum Anfügen weiterer Seiten
  const add = document.createElement('div');
  add.className = 'sc-addcell';
  add.innerHTML = `
    <span>${state.pages.length ? 'Weitere Seite' : 'Erste Seite hinzufügen'}</span>
    <button class="btn btn-small touch-only" data-sc-add="camera">${icon('camera', { size: 16 })}<span>Kamera</span></button>
    <button class="btn btn-small" data-sc-add="files">${icon('image', { size: 16 })}<span>Bilder</span></button>
    ${state.opts.netScan ? `<button class="btn btn-small btn-primary" data-sc-add="scan" ${state.batchStatus ? 'disabled' : ''}>${icon('scanner', { size: 16 })}<span>Scanner</span></button>` : ''}`;
  frag.appendChild(add);
  grid.replaceChildren(frag);
  updatePageCount();
}

// ---------------------------------------------------------------- Zuschnitt (Ecken + Lupe)

async function openCrop(pageIndex) {
  const page = state.pages[pageIndex];
  if (!page) return;
  closePagePreview();
  const src = await getSrc(page);
  state.editing = {
    src,
    corners: page.corners.map((p) => ({ ...p })),
    format: page.format,
    stretch: !!page.stretch,
    rot: page.rot,
    isBedScan: !!page.scanDpi,
    how: page.how,
    pageIndex,
  };
  state.activeHandle = null;
  view('crop');
  renderCrop();
}

// Rand um das Bild herum. Ecken liegen oft genau auf der Bildkante – ohne
// diesen Rand läge der halbe Anfasser außerhalb der Zeichenfläche.
const CROP_PAD = 34;

function cropDisplayMetrics() {
  const stage = $('#scCropStage', state.root);
  const src = state.editing.src;
  const maxW = stage.clientWidth - 16 - CROP_PAD * 2;
  const maxH = stage.clientHeight - 16 - CROP_PAD * 2;
  const fit = Math.min(maxW / src.width, maxH / src.height);
  return { dw: Math.max(1, src.width * fit), dh: Math.max(1, src.height * fit) };
}

const CORNER_LABEL = { tl: 'oben links', tr: 'oben rechts', br: 'unten rechts', bl: 'unten links' };

// Seitenverhältnis-Sperre beim Zuschnitt: 'free' | 'a4' | 'keep' (gemerkt)
let cropLock = (() => { try { return localStorage.getItem('pp.cropLock') || 'free'; } catch { return 'free'; } })();
function setCropLock(v) {
  cropLock = ['free', 'a4', 'keep'].includes(v) ? v : 'free';
  try { localStorage.setItem('pp.cropLock', cropLock); } catch { /* egal */ }
  const ed = state.editing;
  if (ed && cropLock !== 'free') {
    ed.lockRatio = cropLock === 'a4' ? a4RatioFor(ed) : currentRatio(ed);
    squareUp(ed);
  }
  renderCrop();
}

/** Breite/Höhe der Auswahl in Bildpixeln (umschließendes Rechteck). */
function selBox(ed) {
  const xs = ed.corners.map((p) => p.x);
  const ys = ed.corners.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
function currentRatio(ed) {
  const b = selBox(ed);
  return Math.max(0.05, ((b.x1 - b.x0) * ed.src.width) / Math.max(1e-6, (b.y1 - b.y0) * ed.src.height));
}
function a4RatioFor(ed) {
  const portrait = ed.format === 'a4l' ? false : ed.format === 'a4p' ? true : currentRatio(ed) <= 1;
  return portrait ? 210 / 297 : 297 / 210;
}

/** Auswahl als achsenparalleles Rechteck mit dem gesperrten Verhältnis (zentriert). */
function squareUp(ed) {
  const b = selBox(ed);
  const W = ed.src.width;
  const H = ed.src.height;
  const r = ed.lockRatio;
  let w = (b.x1 - b.x0) * W;
  let h = (b.y1 - b.y0) * H;
  if (w / h > r) w = h * r; else h = w / r;
  if (w > W) { w = W; h = w / r; }
  if (h > H) { h = H; w = h * r; }
  const cx = clamp(((b.x0 + b.x1) / 2) * W, w / 2, W - w / 2);
  const cy = clamp(((b.y0 + b.y1) / 2) * H, h / 2, H - h / 2);
  setRect(ed, (cx - w / 2) / W, (cy - h / 2) / H, (cx + w / 2) / W, (cy + h / 2) / H);
}
function setRect(ed, x0, y0, x1, y1) {
  ed.corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/** Ecke ziehen mit gesperrtem Verhältnis: gegenüberliegende Ecke bleibt stehen. */
function dragLockedCorner(ed, idx, p) {
  const W = ed.src.width;
  const H = ed.src.height;
  const r = ed.lockRatio;
  const a = ed.corners[(idx + 2) % 4];
  const sx = p.x >= a.x ? 1 : -1;
  const sy = p.y >= a.y ? 1 : -1;
  let w = Math.abs(p.x - a.x) * W;
  let h = Math.abs(p.y - a.y) * H;
  // dem Finger folgen: die größere Ausdehnung bestimmt
  if (w / r > h) h = w / r; else w = h * r;
  const maxW = (sx > 0 ? 1 - a.x : a.x) * W;
  const maxH = (sy > 0 ? 1 - a.y : a.y) * H;
  if (w > maxW) { w = maxW; h = w / r; }
  if (h > maxH) { h = maxH; w = h * r; }
  const minPx = Math.max(24, Math.min(W, H) * 0.04);
  if (w < minPx || h < minPx) return;
  const bx = a.x + (sx * w) / W;
  const by = a.y + (sy * h) / H;
  setRect(ed, Math.min(a.x, bx), Math.min(a.y, by), Math.max(a.x, bx), Math.max(a.y, by));
  // gezogene Ecke bleibt die aktive (Reihenfolge TL, TR, BR, BL)
  const right = bx > a.x;
  const bottom = by > a.y;
  return bottom ? (right ? 2 : 3) : (right ? 1 : 0);
}

/** Ganze Auswahl verschieben (innerhalb des Bildes). */
function moveSelection(ed, dx, dy) {
  const b = selBox(ed);
  const mx = clamp(dx, -b.x0, 1 - b.x1);
  const my = clamp(dy, -b.y0, 1 - b.y1);
  ed.corners = ed.corners.map((q) => ({ x: q.x + mx, y: q.y + my }));
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
  canvas.getContext('2d').drawImage(ed.src, 0, 0, canvas.width, canvas.height);
  svg.setAttribute('viewBox', `${-CROP_PAD} ${-CROP_PAD} ${dw + CROP_PAD * 2} ${dh + CROP_PAD * 2}`);
  svg.style.width = `${dw + CROP_PAD * 2}px`;
  svg.style.height = `${dh + CROP_PAD * 2}px`;
  drawCropOverlay();
  state.root.querySelectorAll('.sc-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.format === ed.format);
    b.setAttribute('aria-pressed', String(b.dataset.format === ed.format));
  });
  $('#scStretchWrap', state.root).classList.toggle('hidden', ed.format === 'auto');
  $('#scStretch', state.root).checked = !!ed.stretch;
  // A4-Werkzeuge nur bei Flachbett-Scans
  const bed = ed.isBedScan;
  $('#scA4BedBtn', state.root).classList.toggle('hidden', !bed);
  $('#scA4CornerBtn', state.root).classList.toggle('hidden', !bed || !!geometry().rect);
  $('#scCornerLabel', state.root).textContent = `Ecke: ${CORNER_LABEL[geometry().corner] || 'oben links'}`;
  state.root.querySelectorAll('.sc-lock-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.lock === cropLock);
    b.setAttribute('aria-pressed', String(b.dataset.lock === cropLock));
  });
  $('#scCropHint', state.root).innerHTML = cropLock === 'free'
    ? 'Ecken (groß) oder Kanten (klein) ziehen, innen verschieben – die Lupe zeigt die Ecke vergrößert. <span class="sc-hint-long">Pfeiltasten justieren fein nach.</span>'
    : `Seitenverhältnis gesperrt (${cropLock === 'a4' ? 'DIN A4' : 'fest'}): Ecke ziehen ändert Breite und Höhe gemeinsam, innen ziehen verschiebt.`;
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
  const c = '#4f7bff';
  const locked = cropLock !== 'free';
  svg.innerHTML = `
    <path d="M0,0 H${dw} V${dh} H0 Z ${quadPath}" fill="rgba(6,10,20,0.55)" fill-rule="evenodd"></path>
    <path class="sc-handle sc-handle-move" d="${quadPath}" fill="transparent" stroke="${c}" stroke-width="2.5"></path>
    ${locked ? '' : mids.map((m, i) => `
      <g class="sc-handle sc-handle-edge" data-edge="${i}">
        <circle cx="${m.x}" cy="${m.y}" r="26" fill="transparent"></circle>
        <circle cx="${m.x}" cy="${m.y}" r="8" fill="${c}" stroke="#fff" stroke-width="2"></circle>
      </g>`).join('')}
    ${pts.map((p, i) => `
      <g class="sc-handle sc-handle-corner" data-corner="${i}">
        <circle cx="${p.x}" cy="${p.y}" r="40" fill="transparent"></circle>
        <circle cx="${p.x}" cy="${p.y}" r="15" fill="rgba(79,123,255,0.25)" stroke="${c}" stroke-width="3.5"></circle>
        <circle cx="${p.x}" cy="${p.y}" r="3" fill="${c}"></circle>
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
  const region = clamp(Math.max(ed.src.width, ed.src.height) * 0.07, 40, 260);
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
  const toL = (q) => ({
    x: (q.x * (ed.src.width - 1) - (cx - region / 2)) * (size / region),
    y: (q.y * (ed.src.height - 1) - (cy - region / 2)) * (size / region),
  });
  ctx.strokeStyle = 'rgba(79,123,255,0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ed.corners.forEach((q, i) => {
    const l = toL(q);
    if (i === 0) ctx.moveTo(l.x, l.y); else ctx.lineTo(l.x, l.y);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,90,90,0.95)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(size / 2 - 14, size / 2); ctx.lineTo(size / 2 + 14, size / 2);
  ctx.moveTo(size / 2, size / 2 - 14); ctx.lineTo(size / 2, size / 2 + 14);
  ctx.stroke();
  ctx.restore();
  const onLeft = pointerX - stage.getBoundingClientRect().left > stage.clientWidth / 2;
  loupe.classList.toggle('sc-loupe-left', onLeft);
  loupe.classList.remove('hidden');
}

function hideLoupe() {
  $('#scLoupe', state.root)?.classList.add('hidden');
}

function svgPoint(e) {
  const svg = $('#scCropSvg', state.root);
  const r = svg.getBoundingClientRect();
  const { dw, dh } = cropDisplayMetrics();
  const padX = (CROP_PAD / (dw + CROP_PAD * 2)) * r.width;
  const padY = (CROP_PAD / (dh + CROP_PAD * 2)) * r.height;
  const innerW = r.width - padX * 2;
  const innerH = r.height - padY * 2;
  return {
    x: clamp((e.clientX - r.left - padX) / innerW, 0, 1),
    y: clamp((e.clientY - r.top - padY) / innerH, 0, 1),
  };
}

function onCropPointerDown(e) {
  const handle = e.target.closest?.('.sc-handle');
  if (!handle || !state.editing) return;
  e.preventDefault();
  $('#scCropSvg', state.root).setPointerCapture?.(e.pointerId);
  if (handle.dataset.corner != null) {
    const idx = Number(handle.dataset.corner);
    state.drag = { type: 'corner', idx };
    state.activeHandle = idx;
    if (cropLock !== 'free') {
      if (!state.editing.lockRatio) state.editing.lockRatio = cropLock === 'a4' ? a4RatioFor(state.editing) : currentRatio(state.editing);
      squareUp(state.editing);
      drawCropOverlay();
    }
    updateLoupe(idx, e.clientX);
  } else if (handle.classList.contains('sc-handle-move')) {
    state.drag = { type: 'move', last: svgPoint(e) };
  } else {
    state.drag = { type: 'edge', idx: Number(handle.dataset.edge), last: svgPoint(e) };
  }
}

function onCropPointerMove(e) {
  if (!state.drag || !state.editing) return;
  e.preventDefault();
  const ed = state.editing;
  const p = svgPoint(e);
  if (state.drag.type === 'corner') {
    if (cropLock !== 'free') {
      const idx = dragLockedCorner(ed, state.drag.idx, p);
      if (idx != null) state.drag.idx = state.activeHandle = idx;
    } else {
      ed.corners[state.drag.idx] = { x: p.x, y: p.y };
    }
    drawCropOverlay();
    updateLoupe(state.drag.idx, e.clientX);
  } else if (state.drag.type === 'move') {
    moveSelection(ed, p.x - state.drag.last.x, p.y - state.drag.last.y);
    state.drag.last = p;
    drawCropOverlay();
  } else {
    const dx = p.x - state.drag.last.x;
    const dy = p.y - state.drag.last.y;
    state.drag.last = p;
    const i = state.drag.idx;
    const j = (i + 1) % 4;
    ed.corners[i] = { x: clamp01(ed.corners[i].x + dx), y: clamp01(ed.corners[i].y + dy) };
    ed.corners[j] = { x: clamp01(ed.corners[j].x + dx), y: clamp01(ed.corners[j].y + dy) };
    drawCropOverlay();
  }
}

function onCropPointerUp() {
  state.drag = null;
  hideLoupe();
}

function onCropKeydown(e) {
  if (state.activeHandle == null || !state.editing) return;
  const step = ((e.shiftKey ? 10 : 1.5) / Math.max(state.editing.src.width, state.editing.src.height)) * 4;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!mv) return;
  e.preventDefault();
  const c = state.editing.corners[state.activeHandle];
  state.editing.corners[state.activeHandle] = { x: clamp01(c.x + mv[0]), y: clamp01(c.y + mv[1]) };
  drawCropOverlay();
}

function rotateEditing() {
  const ed = state.editing;
  const scanDpi = ed.src.scanDpi;
  const srcPx = ed.src.sourcePx;
  ed.src = rotateCanvas90(ed.src);
  if (scanDpi) {
    ed.src.scanDpi = scanDpi;
    ed.src.sourcePx = srcPx ? { w: srcPx.h, h: srcPx.w } : null;
  }
  ed.rot = (ed.rot + 90) % 360;
  ed.corners = orderCorners(ed.corners.map((p) => ({ x: 1 - p.y, y: p.x })));
  if (ed.format === 'a4p') ed.format = 'a4l';
  else if (ed.format === 'a4l') ed.format = 'a4p';
  if (ed.lockRatio) ed.lockRatio = 1 / ed.lockRatio;
  renderCrop();
}

function applyCrop() {
  const ed = state.editing;
  if (!ed) return;
  const page = state.pages[ed.pageIndex];
  if (page.rot !== ed.rot) {
    dropSrc(page);
    page.rot = ed.rot;
    srcCache.unshift({ page, rot: page.rot, canvas: ed.src });
    while (srcCache.length > 2) srcCache.pop();
  }
  page.corners = orderCorners(ed.corners.map((p) => ({ ...p })));
  page.format = ed.format;
  page.stretch = !!ed.stretch;
  page.how = ed.how;
  page.thumb = null;
  state.editing = null;
  view('pages');
}

function cancelCrop() {
  state.editing = null;
  view('pages');
}

// ------------------------------------------------ Radierer (weiß übermalen)

const ERASE_BASE_MAX = 2200;   // Auflösung der Arbeitskopie im Radierer

async function openErase(pageIndex) {
  const page = state.pages[pageIndex];
  if (!page) return;
  closePagePreview();
  page.erase = page.erase || [];
  const src = await getSrc(page);
  state.erasing = {
    pageIndex,
    src,
    backup: JSON.stringify(page.erase),
    undo: [],
    redo: [],
    base: null,
    drawing: null,
    zoom: 1,
    pan: { x: 0, y: 0 },
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
  if (!er.base) {
    const { w, h } = outputSize(er.src.width, er.src.height, page.corners);
    const s = Math.min(1, ERASE_BASE_MAX / Math.max(w, h));
    er.base = warpPerspective(er.src, page.corners, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
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
  const k = canvas.width / m.visW;
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
  $('#scEraseZoomLabel', state.root).textContent = `${Math.round(er.zoom * 100)} %`;
  $('#scEraseZoomOut', state.root).disabled = er.zoom <= 1.01;
  $('#scEraseZoomIn', state.root).disabled = er.zoom >= 7.9;
}

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

function erasePoint(e) {
  const er = state.erasing;
  const r = $('#scEraseCanvas', state.root).getBoundingClientRect();
  const m = eraseMetrics();
  const bx = er.pan.x + clamp((e.clientX - r.left) / r.width, 0, 1) * m.visW;
  const by = er.pan.y + clamp((e.clientY - r.top) / r.height, 0, 1) * m.visH;
  return { x: clamp01(bx / m.bw), y: clamp01(by / m.bh) };
}

function eraseBasePoint(clientX, clientY) {
  const er = state.erasing;
  const r = $('#scEraseCanvas', state.root).getBoundingClientRect();
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
  // nach einem verlorenen pointerup.
  if (e.isPrimary) {
    er.pointers.clear();
    er.pinch = null;
    er.drawing = null;
  }
  try { $('#scEraseCanvas', state.root).setPointerCapture?.(e.pointerId); } catch { /* nicht kritisch */ }
  er.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // Zwei Finger: zoomen und verschieben statt radieren
  if (er.pointers.size === 2 && e.pointerType === 'touch') {
    const [a, b] = [...er.pointers.values()];
    er.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: er.zoom,
      base: eraseBasePoint((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
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
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    eraseZoomTo(er.pinch.zoom * (d / er.pinch.dist), er.pinch.base);
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
  const page = state.pages[er.pageIndex];
  if (discard) page.erase = JSON.parse(er.backup);
  else page.thumb = null;
  state.erasing = null;
  view('pages');
}

// ------------------------------------------------ Große Seitenvorschau

async function openPagePreview(idx) {
  const page = state.pages[idx];
  if (!page) return;
  const box = $('#scPreview', state.root);
  const stage = $('#scPreviewStage', state.root);
  state.previewIdx = idx;
  $('#scPreviewLabel', state.root).textContent = `Seite ${idx + 1} von ${state.pages.length} · ${formatLabel(page)}`;
  $('#scPreviewPrev', state.root).disabled = idx === 0;
  $('#scPreviewNext', state.root).disabled = idx === state.pages.length - 1;
  box.classList.remove('hidden');
  const src = await getSrc(page);
  if (state.previewIdx !== idx) return;
  const big = composeThumb(page, src, Math.max(900, Math.round(window.innerHeight * 1.6)));
  big.className = 'sc-preview-img';
  stage.replaceChildren(big);
}

function closePagePreview() {
  $('#scPreview', state.root)?.classList.add('hidden');
  state.previewIdx = null;
}

// ------------------------------------------------ PDF bauen

async function buildPdf() {
  if (state.building || state.pages.length === 0 || state.pending) return;
  state.building = true;
  const btn = $('#scDoneBtn', state.root);
  btn.disabled = true;
  try {
    const { PDFDocument, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.setProducer('PDF Presser Scan-Studio (lokal im Browser)');
    for (let i = 0; i < state.pages.length; i++) {
      btn.querySelector('span').textContent = `PDF … ${i + 1}/${state.pages.length}`;
      await new Promise((r) => setTimeout(r, 0));
      const page = state.pages[i];
      const src = await getSrc(page);
      const { w, h } = outputSize(src.width, src.height, page.corners);
      const warped = applyErase(warpPerspective(src, page.corners, w, h), page.erase);
      const blob = await new Promise((r) => warped.toBlob(r, 'image/jpeg', 0.92));
      warped.width = 1;
      const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      if (page.format === 'a4p' || page.format === 'a4l') {
        const [pw, ph] = page.format === 'a4p' ? A4_PT : [A4_PT[1], A4_PT[0]];
        const pdfPage = doc.addPage([pw, ph]);
        pdfPage.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: rgb(1, 1, 1) });
        if (page.stretch) {
          pdfPage.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        } else {
          const s = Math.min(pw / w, ph / h);
          pdfPage.drawImage(img, { x: (pw - w * s) / 2, y: (ph - h * s) / 2, width: w * s, height: h * s });
        }
      } else {
        let pw;
        let ph;
        if (w <= h) { ph = A4_PT[1]; pw = ph * (w / h); } else { pw = A4_PT[1]; ph = pw * (h / w); }
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
    alertDialog('PDF konnte nicht erstellt werden', e?.message || String(e));
    state.building = false;
    updatePageCount();
  } finally {
    state.building = false;
  }
}

// ------------------------------------------------ Öffnen / Schließen

function closeScanner() {
  document.removeEventListener('keydown', onGlobalKeydown);
  window.removeEventListener('resize', onResize);
  state.root?.remove();
  state.root = null;
  state.pages = [];
  state.pending = 0;
  state.editing = null;
  state.erasing = null;
  state.onDone = null;
  state.building = false;
  state.batchStatus = '';
  srcCache.length = 0;
}

async function requestClose() {
  const n = state.pages.length;
  if (n > 0 || state.batchStatus) {
    const parts = [];
    if (state.batchStatus) parts.push('Der laufende Scan wird gestoppt.');
    if (n > 0) parts.push(`${n} Seite${n === 1 ? '' : 'n'} gehen verloren.`);
    const ok = await confirmDialog('Studio schließen?', parts.join(' '), 'Verwerfen', 'danger');
    if (!ok) return;
  }
  if (state.batchStatus) state.opts.onCancelBatch?.();
  const discard = state.opts.onDiscard;
  closeScanner();
  discard?.();
}

function onGlobalKeydown(e) {
  if (e.key !== 'Escape' || !state.root || document.querySelector('.dlg-wrap')) return;
  if (state.previewIdx != null) { closePagePreview(); return; }
  if (state.view === 'crop') { cancelCrop(); return; }
  if (state.view === 'erase') { closeErase(true); return; }
  requestClose();
}

function onResize() {
  if (state.root && state.editing) renderCrop();
  if (state.root && state.erasing) renderErase();
}

/**
 * Öffnet das Studio. onDone(file) erhält das fertige Scan-PDF (File).
 * opts:
 *   initialFiles  Bilder, die sofort als Seiten angelegt werden
 *   netScan       () => void – startet einen Scan (App steuert den Stapel)
 *   onCancelBatch () => void – Stapel abbrechen
 *   geometry      () => {corner, offX, offY} – A4-Lage auf der Glasfläche
 *   a4            () => boolean – Fotos standardmäßig auf A4 setzen
 *   onDiscard     () => void – Studio wurde ohne Ergebnis geschlossen
 */
export function openScanner(onDone, opts = {}) {
  if (state.root) closeScanner();
  const root = document.createElement('div');
  root.id = 'scannerRoot';
  root.innerHTML = TEMPLATE;
  hydrateIcons(root);
  document.body.appendChild(root);
  state.root = root;
  state.onDone = onDone;
  state.opts = opts;
  state.pages = [];
  state.pending = 0;
  state.batchStatus = '';

  $('#scCloseBtn', root).addEventListener('click', requestClose);
  $('#scBatchStopBtn', root).addEventListener('click', () => {
    state.opts.onCancelBatch?.();
    setScanStatus('Stapel wird beendet …', false);
  });
  $('#scDoneBtn', root).addEventListener('click', buildPdf);

  const fileInput = $('#scFileInput', root);
  const camInput = $('#scCamInput', root);
  const take = (input) => { const f = [...input.files]; input.value = ''; return f; };
  fileInput.addEventListener('change', () => addFiles(take(fileInput)));
  camInput.addEventListener('change', () => addFiles(take(camInput)));
  $('#scPageGrid', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-sc-add]');
    if (!b) return;
    if (b.dataset.scAdd === 'camera') camInput.click();
    else if (b.dataset.scAdd === 'files') fileInput.click();
    else if (b.dataset.scAdd === 'scan') state.opts.netScan?.();
  });

  // Große Seitenvorschau
  $('#scPreviewClose', root).addEventListener('click', closePagePreview);
  $('#scPreviewPrev', root).addEventListener('click', () => openPagePreview(state.previewIdx - 1));
  $('#scPreviewNext', root).addEventListener('click', () => openPagePreview(state.previewIdx + 1));
  $('#scPreviewCrop', root).addEventListener('click', () => openCrop(state.previewIdx));
  $('#scPreviewErase', root).addEventListener('click', () => openErase(state.previewIdx));

  // Zuschnitt-Werkzeuge
  $('#scA4BedBtn', root).addEventListener('click', () => {
    const ed = state.editing;
    if (!ed) return;
    const c = a4CornersForScan(ed.src, geometry());
    if (!c) return;
    ed.corners = c;
    ed.format = a4FormatFor(ed.src, c);
    ed.stretch = true;
    ed.how = 'bed';
    ed.lockRatio = null;
    renderCrop();
  });
  // Liegt die Vorlage an einer anderen Ecke an? Durch alle vier durchschalten
  // – die Wahl gilt ab jetzt auch für neue Scans.
  $('#scA4CornerBtn', root).addEventListener('click', () => {
    const ed = state.editing;
    if (!ed) return;
    const order = ['tl', 'tr', 'br', 'bl'];
    const g = geometry();
    const next = order[(order.indexOf(g.corner || 'tl') + 1) % order.length];
    state.opts.setCorner?.(next);
    const c = a4CornersForScan(ed.src, { ...g, corner: next });
    if (c) {
      ed.corners = c;
      ed.stretch = true;
      ed.how = 'bed';
    }
    renderCrop();
  });
  $('#scAutoBtn', root).addEventListener('click', () => {
    const ed = state.editing;
    if (!ed) return;
    const det = detectCornersOnCanvas(ed.src);
    if (!det) toast('Keine Dokumentränder erkannt – Ecken bitte von Hand setzen', 'info');
    ed.corners = det || defaultCorners(0.04);
    ed.how = det ? 'photo' : 'manual';
    ed.lockRatio = null;
    renderCrop();
  });
  $('#scFullBtn', root).addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.corners = defaultCorners(0);
    state.editing.how = 'full';
    state.editing.lockRatio = null;
    renderCrop();
  });
  root.querySelectorAll('.sc-seg-btn').forEach((b) => b.addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.format = b.dataset.format;
    if (cropLock === 'a4') {
      state.editing.lockRatio = a4RatioFor(state.editing);
      squareUp(state.editing);
    }
    renderCrop();
  }));
  root.querySelectorAll('.sc-lock-btn').forEach((b) => b.addEventListener('click', () => setCropLock(b.dataset.lock)));
  $('#scStretch', root).addEventListener('change', (e) => {
    if (state.editing) state.editing.stretch = e.target.checked;
  });
  $('#scRotateBtn', root).addEventListener('click', rotateEditing);
  $('#scCropOkBtn', root).addEventListener('click', applyCrop);
  $('#scCropCancelBtn', root).addEventListener('click', cancelCrop);

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
  $('#scEraseStage', root).addEventListener('wheel', (e) => {
    if (!state.erasing) return;
    e.preventDefault();
    eraseZoomTo(state.erasing.zoom * (e.deltaY > 0 ? 0.85 : 1.18), eraseBasePoint(e.clientX, e.clientY));
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

  view('pages');
  if (opts.initialFiles?.length) addFiles(opts.initialFiles);
}

/**
 * Bild direkt als fertige Seite anhängen (Stapel-Scan). Zuschnitt wird
 * automatisch gesetzt – bei Flachbett-Scans der feste A4-Ausschnitt.
 */
export async function addPageDirect(file) {
  if (!state.root) return null;
  return addImageFile(file);
}

/** Zur Seitenübersicht wechseln */
export function showPages() {
  if (state.root && state.view !== 'crop' && state.view !== 'erase') view('pages');
}

/** Anzahl der bisher gesammelten Seiten */
export function pageCount() {
  return state.pages.length;
}

/** Fortschritt/Countdown im Studio anzeigen; `stoppable` blendet „Stopp“ ein. */
export function setScanStatus(text, stoppable = !!text) {
  if (!state.root) return;
  const was = !!state.batchStatus;
  state.batchStatus = text || '';
  $('#scBatchStopBtn', state.root).classList.toggle('hidden', !text || !stoppable);
  updatePageCount();
  if (was !== !!state.batchStatus && state.view === 'pages') renderPages();
}

export const isOpen = () => !!state.root;

// Für die automatisierten Tests
window.__pdfscanner = {
  detectDocumentCorners,
  detectCornersOnCanvas,
  warpPerspective,
  orderCorners,
  outputSize,
  applyErase,
  a4CornersForScan,
  autoLayout,
  plausibleBedScan,
  openScanner,
  addPageDirect,
  state,
};
