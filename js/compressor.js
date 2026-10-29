// Kompressions-Pipeline: PDF -> (Render mit pdf.js) -> neu aufgebautes PDF (pdf-lib).
// Alles läuft lokal im Browser, es werden keine Daten hochgeladen.

import { encodeG4 } from './ccitt-g4.js';
import { recognizePage, warmOcr, releaseOcrSoon, ocrParallel, usesServerOcr, isMobileDevice } from './ocr.js';

const pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
}

// Zeichensatz-/Font-Ressourcen für pdf.js (für PDFs ohne eingebettete Fonts)
const PDFJS_DOC_OPTS = {
  cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
};

const PT_PER_INCH = 72;
export const A4_PT = [595.28, 841.89];

export const PRESETS = {
  verlustfrei: { mode: 'lossless' },
  leicht:      { mode: 'raster', colorMode: 'color', dpi: 200, quality: 0.80 },
  mittel:      { mode: 'raster', colorMode: 'color', dpi: 150, quality: 0.62 },
  stark:       { mode: 'raster', colorMode: 'color', dpi: 110, quality: 0.45 },
  'extrem-grau':  { mode: 'raster', colorMode: 'gray', dpi: 100, quality: 0.40 },
  'extrem-farbe': { mode: 'raster', colorMode: 'indexed', dpi: 150, colors: 16 },
  'extrem-sw': { mode: 'raster', colorMode: 'bw', dpi: 300 },
};

// Reihenfolge + Anzeigenamen (Oberfläche, Simulation)
export const PRESET_INFO = [
  { key: 'verlustfrei', name: 'Verlustfrei', desc: 'Nur aufräumen – Text & Bilder bleiben unangetastet' },
  { key: 'leicht', name: 'Leicht', desc: 'Farbe · 200 dpi · sehr hohe Qualität' },
  { key: 'mittel', name: 'Ausgewogen', desc: 'Farbe · 150 dpi · gute Balance' },
  { key: 'stark', name: 'Stark', desc: 'Farbe · 110 dpi · deutlich kleiner' },
  { key: 'extrem-grau', name: 'Graustufen', desc: 'Grau · 100 dpi · sehr klein' },
  { key: 'extrem-farbe', name: 'Scan Farbe', desc: '16 Farben · 150 dpi · Büroscanner-Look' },
  { key: 'extrem-sw', name: 'Scan S/W', desc: '1-Bit · 300 dpi · CCITT G4 · gestochen scharf' },
];
export const presetName = (key) => PRESET_INFO.find((p) => p.key === key)?.name || key;

const abortError = () => Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- Bild-Helfer

function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
  }
  return gray;
}

// Adaptive Binarisierung wie bei Büroscannern: jeder Pixel wird gegen den
// LOKALEN Hintergrund verglichen (Blockmittelwerte, bilinear interpoliert).
// Dadurch bleibt Text auf weißem, getöntem oder farbigem Papier schwarz auf
// weiß, statt dass dunkle/bunte Seiten komplett schwarz kippen (wie es ein
// globaler Otsu-Schwellwert täte). In dunklen Bereichen (z. B. Farbbalken
// mit weißer Schrift) wird lokal invertiert gearbeitet, damit die Schrift
// lesbar bleibt.
// bias:     Helligkeitsregler (-40..+40); positiv = heller (mehr Weiß)
// contrast: Kontrast/Empfindlichkeit (-50..+50); positiv = mehr Struktur wird
//           als Text gewertet, negativ = nur kräftige Tinte bleibt übrig.
// darkAreas: 'auto' | 'invert' | 'ignore'
//   invert = dunkle Flächen als Farbbalken behandeln (Fläche schwarz, helle
//            Schrift weiß) – richtig bei Briefköpfen und Tabellenköpfen.
//   ignore = dunkle Flächen wie normalen Untergrund behandeln – richtig bei
//            dunklen Fotos/Bildschirmaufnahmen, wo sonst der ganze Rand zu
//            schwarzem Rauschen kippt.
//   auto   = anhand des Bildes entscheiden.
export function binarize(imageData, bias, contrast = 0, darkAreas = 'auto') {
  const { width: w, height: h } = imageData;
  const gray = toGray(imageData);
  const b = bias | 0;
  const k = Math.max(-50, Math.min(50, contrast | 0));

  // Blockmittelwerte und -streuung (32er-Raster) + 3x3-Glättung
  const BLOCK = 32;
  const bw = Math.max(1, Math.ceil(w / BLOCK));
  const bh = Math.max(1, Math.ceil(h / BLOCK));
  const sums = new Float64Array(bw * bh);
  const sqSums = new Float64Array(bw * bh);
  const counts = new Uint32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const by = (y / BLOCK) | 0;
    const rowOff = y * w;
    const bOff = by * bw;
    for (let x = 0; x < w; x++) {
      const bi = bOff + ((x / BLOCK) | 0);
      const g = gray[rowOff + x];
      sums[bi] += g;
      sqSums[bi] += g * g;
      counts[bi]++;
    }
  }
  const means = new Float32Array(bw * bh);
  const devs = new Float32Array(bw * bh);
  for (let i = 0; i < means.length; i++) {
    const n = counts[i] || 1;
    const m = sums[i] / n;
    means[i] = m;
    devs[i] = Math.sqrt(Math.max(0, sqSums[i] / n - m * m));
  }
  const blurred = new Float32Array(bw * bh);
  const blurDev = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      let sd = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy;
          const xx = bx + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) {
            s += means[yy * bw + xx];
            // Für die Struktur zählt der stärkste Block der Umgebung: sonst
            // würden dünne Zeilen am Rand eines Textblocks verschluckt.
            sd = Math.max(sd, devs[yy * bw + xx]);
            n++;
          }
        }
      }
      blurred[by * bw + bx] = s / n;
      blurDev[by * bw + bx] = sd;
    }
  }

  // Ist ein großer Teil der Seite dunkel, handelt es sich nicht um einzelne
  // Farbbalken, sondern um eine insgesamt dunkle Aufnahme (Foto, Bildschirm,
  // starke Vignette). Dort ist die Inversion falsch: sie macht aus flächigem
  // Rauschen eine schwarze Masse.
  let dimBlocks = 0;
  for (let i = 0; i < blurred.length; i++) if (blurred[i] < 110) dimBlocks++;
  const dimFrac = dimBlocks / (blurred.length || 1);
  const invertDark = darkAreas === 'invert'
    || (darkAreas !== 'ignore' && dimFrac <= 0.22);

  // Pro Pixel: lokalen Hintergrund bilinear samplen und schwellen
  const C = Math.min(80, Math.max(5, 28 + b - k * 0.35)); // Abstand zum Papier
  // Flächen ohne Struktur (gleichmäßig dunkler Rand, Schattenverlauf,
  // Bildrauschen) enthalten keinen Text und werden weiß.
  const FLAT = Math.max(3, 11 - k * 0.12);
  const bitmap = new Uint8Array(gray.length);
  const half = BLOCK / 2;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y - half) / BLOCK));
    const y0 = fy | 0;
    const y1 = Math.min(bh - 1, y0 + 1);
    const wy = fy - y0;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x - half) / BLOCK));
      const x0 = fx | 0;
      const x1 = Math.min(bw - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = y0 * bw + x0;
      const i01 = y0 * bw + x1;
      const i10 = y1 * bw + x0;
      const i11 = y1 * bw + x1;
      const m =
        blurred[i00] * (1 - wx) * (1 - wy) +
        blurred[i01] * wx * (1 - wy) +
        blurred[i10] * (1 - wx) * wy +
        blurred[i11] * wx * wy;
      const sd = Math.max(
        Math.max(blurDev[i00], blurDev[i01]),
        Math.max(blurDev[i10], blurDev[i11]),
      );

      let t;
      if (m >= 110 || !invertDark) {
        // helles Papier bzw. dunkle Aufnahme ohne Inversion:
        // alles deutlich Dunklere als der lokale Untergrund ist Tinte
        t = Math.min(m - C, 210);
      } else if (sd < FLAT) {
        // dunkel, aber ohne Struktur: leerer Bereich – nichts einfärben
        bitmap[rowOff + x] = 0;
        continue;
      } else {
        // dunkler Bereich mit Struktur (Farbbalken/Header): Fläche schwarz,
        // helle Schrift bleibt weiß
        t = Math.min(Math.max(m + 60 - b, m + 20), 165);
      }
      bitmap[rowOff + x] = gray[rowOff + x] < t ? 1 : 0;
    }
  }
  return { bitmap };
}

function applyGrayInPlace(imageData) {
  const { data } = imageData;
  for (let p = 0; p < data.length; p += 4) {
    const g = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    data[p] = g;
    data[p + 1] = g;
    data[p + 2] = g;
  }
}

// --- Farbreduktion im "Scanner-Stil" (wie Xerox-Farbscans: wenige flache
// Farben, sauberer weißer Hintergrund). Median-Cut-Quantisierung auf
// maximal `colors` Palettenfarben, Weiß ist immer Index 0.
function quantizeIndexed(imageData, colors, bias) {
  const { data, width, height } = imageData;
  const n = width * height;
  const whiteLum = Math.min(250, Math.max(160, 225 - (bias | 0)));
  const isWhite = new Uint8Array(n);
  const samples = [];
  const stride = Math.max(1, Math.floor(n / 40000));
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const lum = (r * 77 + g * 151 + b * 28) >> 8;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum >= whiteLum && spread < 40) {
      isWhite[i] = 1;
    } else if (i % stride === 0) {
      samples.push([r, g, b]);
    }
  }

  // Median-Cut auf den Nicht-Weiß-Pixeln
  const maxBoxes = Math.max(1, colors - 1);
  const boxes = samples.length ? [samples] : [];
  const boxRange = (box) => {
    const mins = [255, 255, 255];
    const maxs = [0, 0, 0];
    for (const s of box) {
      for (let c = 0; c < 3; c++) {
        if (s[c] < mins[c]) mins[c] = s[c];
        if (s[c] > maxs[c]) maxs[c] = s[c];
      }
    }
    let ch = 0;
    let range = -1;
    for (let c = 0; c < 3; c++) {
      if (maxs[c] - mins[c] > range) {
        range = maxs[c] - mins[c];
        ch = c;
      }
    }
    return { ch, range };
  };
  while (boxes.length < maxBoxes) {
    let bi = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const { range } = boxRange(boxes[i]);
      const score = range * Math.sqrt(boxes[i].length);
      if (score > best) {
        best = score;
        bi = i;
      }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const { ch } = boxRange(box);
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  const palette = [[255, 255, 255]];
  for (const box of boxes) {
    if (!box.length) continue;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const s of box) {
      r += s[0];
      g += s[1];
      b += s[2];
    }
    palette.push([Math.round(r / box.length), Math.round(g / box.length), Math.round(b / box.length)]);
  }

  // Jedem Pixel die nächstliegende Palettenfarbe zuordnen
  const indices = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (isWhite[i]) continue; // Index 0 = Weiß
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let k = 1; k < palette.length; k++) {
      const dr = r - palette[k][0];
      const dg = g - palette[k][1];
      const db = b - palette[k][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = k;
      }
    }
    // Weiß bleibt erreichbar, falls es näher liegt
    const dw = (r - 255) * (r - 255) + (g - 255) * (g - 255) + (b - 255) * (b - 255);
    indices[i] = dw < bestDist ? 0 : bestIdx;
  }
  return { indices, palette };
}

// JPEG-Encode mit Verkleinerungs-Retry: Safari (v. a. iOS) liefert bei zu
// großen/zu speicherhungrigen Canvas null zurück – dann schrittweise kleiner.
async function canvasToJpeg(canvas, quality) {
  let current = canvas;
  for (let attempt = 0; attempt < 4; attempt++) {
    const blob = await new Promise((resolve) => current.toBlob(resolve, 'image/jpeg', quality));
    if (blob) return new Uint8Array(await blob.arrayBuffer());
    const smaller = document.createElement('canvas');
    smaller.width = Math.max(1, Math.round(current.width * 0.7));
    smaller.height = Math.max(1, Math.round(current.height * 0.7));
    smaller.getContext('2d').drawImage(current, 0, 0, smaller.width, smaller.height);
    current = smaller;
  }
  throw new Error('JPEG-Encoding fehlgeschlagen (Seite ist für diesen Browser zu groß)');
}

// 1-Bit-Bitmap (1 = schwarz) zeilenweise zu Bytes packen; Bit 1 = weiß
// (DeviceGray: 0 = schwarz), wie es FlateDecode erwartet.
function packBits(bitmap, width, height) {
  const rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const outOff = y * rowBytes;
    for (let x = 0; x < width; x++) {
      if (!bitmap[rowOff + x]) {
        out[outOff + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

// 4-Bit-Indizes packen (2 Pixel pro Byte, Zeilen byte-aligned)
function pack4Bit(indices, width, height) {
  const rowBytes = (width + 1) >> 1;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const outOff = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const v = indices[rowOff + x] & 0x0f;
      if ((x & 1) === 0) out[outOff + (x >> 1)] = v << 4;
      else out[outOff + (x >> 1)] |= v;
    }
  }
  return out;
}

// Größenschätzung per Deflate (nur für Vorschau/Simulation)
async function deflateSize(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes.length;
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = cs.readable.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
  }
  return total;
}

// ---------------------------------------------------------------- PDF-Einbettung

function embedBwImage(newDoc, PDFLib, bitmap, widthPx, heightPx, filter) {
  const { PDFName } = PDFLib;
  const mkFlate = () => newDoc.context.flateStream(packBits(bitmap, widthPx, heightPx), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: widthPx,
    Height: heightPx,
    ColorSpace: PDFName.of('DeviceGray'),
    BitsPerComponent: 1,
  });
  const mkG4 = () => newDoc.context.stream(encodeG4(bitmap, widthPx, heightPx), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: widthPx,
    Height: heightPx,
    ColorSpace: PDFName.of('DeviceGray'),
    BitsPerComponent: 1,
    Filter: PDFName.of('CCITTFaxDecode'),
    DecodeParms: { K: -1, Columns: widthPx, Rows: heightPx, BlackIs1: false },
  });
  let stream;
  if (filter === 'flate') {
    stream = mkFlate();
  } else if (filter === 'g4') {
    stream = mkG4();
  } else {
    // 'auto': pro Seite die kleinere der beiden Kompressionen verwenden
    const g4 = mkG4();
    const flate = mkFlate();
    stream = g4.contents.length <= flate.contents.length ? g4 : flate;
  }
  return newDoc.context.register(stream);
}

function embedIndexedImage(newDoc, PDFLib, indices, palette, widthPx, heightPx) {
  const { PDFName, PDFHexString } = PDFLib;
  let hex = '';
  for (const [r, g, b] of palette) {
    hex += r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
  }
  const colorSpace = newDoc.context.obj([
    PDFName.of('Indexed'),
    PDFName.of('DeviceRGB'),
    palette.length - 1,
    PDFHexString.of(hex),
  ]);
  const stream = newDoc.context.flateStream(pack4Bit(indices, widthPx, heightPx), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: widthPx,
    Height: heightPx,
    ColorSpace: colorSpace,
    BitsPerComponent: 4,
  });
  return newDoc.context.register(stream);
}

function drawImageRef(page, PDFLib, ref, wPt, hPt) {
  const { PDFName, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
  const key = `ImP${Math.floor(Math.random() * 1e9)}`;
  page.node.setXObject(PDFName.of(key), ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(wPt, 0, 0, hPt, 0, 0),
    drawObject(key),
    popGraphicsState(),
  );
}

// Unsichtbaren OCR-Textlayer über die Seite legen (durchsuchbar/kopierbar)
function drawOcrWords(page, font, words, dpi, pageHeightPt) {
  const s = PT_PER_INCH / dpi;
  for (const w of words) {
    const text = (w.text || '').trim();
    if (!text) continue;
    const boxH = (w.bbox.y1 - w.bbox.y0) * s;
    if (boxH <= 0.1) continue;
    const size = Math.max(2, Math.min(72, boxH));
    try {
      page.drawText(text, {
        x: w.bbox.x0 * s,
        y: pageHeightPt - w.bbox.y1 * s,
        size,
        font,
        opacity: 0,
      });
    } catch {
      // Zeichen außerhalb von WinAnsi (Standardfont) -> Wort überspringen
    }
  }
}

// ---------------------------------------------------------------- Rendern

// Obergrenzen an Pixeln pro Seite. iOS-Safari erlaubt nur ca. 16,7 Mio.
// Canvas-Pixel – darüber entstehen stillschweigend schwarze/leere Canvas.
// A4 bei 300 dpi (8,7 Mio.) bleibt überall unangetastet.
const MAX_PIXELS_BW = 16e6;
const MAX_PIXELS_COLOR = 12e6; // JPEG-Encode braucht zusätzlich Speicher

/**
 * Lage der Quellseite auf der Ausgabeseite (in Punkt).
 *  a4 = true: jede Seite landet auf DIN A4 (hoch oder quer wie die Vorlage).
 *    Fast-A4 (< 2,5 % Abweichung, z. B. Letter-Scans) wird exakt aufgezogen,
 *    alles andere unverzerrt eingepasst und mittig gesetzt.
 *  a4 = false: Originalgröße. Nur Pixelmaß-Scans (nominell größer als A2,
 *    z. B. MediaBox 2480x3507) werden auf A4-Äquivalent normiert – sonst
 *    bedeuteten die dpi-Stufen nichts.
 */
export function pageLayout(srcW, srcH, a4) {
  if (a4) {
    const landscape = srcW > srcH;
    const [tw, th] = landscape ? [A4_PT[1], A4_PT[0]] : A4_PT;
    const sx = tw / srcW;
    const sy = th / srcH;
    if (Math.abs(sx / sy - 1) < 0.025) return { wPt: tw, hPt: th, sx, sy, ox: 0, oy: 0 };
    const s = Math.min(sx, sy);
    return { wPt: tw, hPt: th, sx: s, sy: s, ox: (tw - srcW * s) / 2, oy: (th - srcH * s) / 2 };
  }
  let norm = 1;
  if (srcW * srcH > 1.7e6) {
    norm = Math.min(A4_PT[1] / Math.max(srcW, srcH), A4_PT[0] / Math.min(srcW, srcH));
  }
  return { wPt: srcW * norm, hPt: srcH * norm, sx: norm, sy: norm, ox: 0, oy: 0 };
}

async function renderPage(page, dpi, maxPixels, a4 = false) {
  const base = page.getViewport({ scale: 1 });
  const L = pageLayout(base.width, base.height, a4);
  let k = dpi / PT_PER_INCH;
  const projected = L.wPt * L.hPt * k * k;
  if (maxPixels && projected > maxPixels) k *= Math.sqrt(maxPixels / projected);
  const wPx = Math.max(1, Math.round(L.wPt * k));
  const hPx = Math.max(1, Math.round(L.hPt * k));
  const canvas = document.createElement('canvas');
  canvas.width = wPx;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, wPx, hPx);
  const viewport = page.getViewport({ scale: L.sx * k });
  await page.render({
    canvasContext: ctx,
    viewport,
    intent: 'print',
    transform: [1, 0, 0, L.sy / L.sx, L.ox * k, L.oy * k],
  }).promise;
  // Kaputte/leere Canvas erkennen (liefert überall Alpha 0 statt des weißen
  // Hintergrunds) -> klarer Fehler statt komplett schwarzer Seiten
  const corner1 = ctx.getImageData(0, 0, 1, 1).data;
  const corner2 = ctx.getImageData(wPx - 1, hPx - 1, 1, 1).data;
  if (corner1[3] === 0 && corner2[3] === 0) {
    throw new Error(`Seite konnte nicht gerendert werden (${wPx}×${hPx} Pixel sind für diesen Browser zu groß)`);
  }
  return { canvas, ctx, wPx, hPx, wPt: L.wPt, hPt: L.hPt, effDpi: (wPx / L.wPt) * PT_PER_INCH };
}

function freeCanvas(c) {
  // iOS gibt Canvas-Speicher sonst erst spät frei
  if (c) { c.width = 1; c.height = 1; }
}

// OCR arbeitet am besten und schnellsten um 300 dpi: darunter leidet die
// Erkennung, darüber steigt die Rechenzeit quadratisch ohne Gewinn.
const OCR_DPI = 300;
async function ocrInputFor(page, r, a4) {
  let canvas = r.canvas;
  let dpi = r.effDpi;
  let temp = null;
  if (dpi > 340) {
    const s = OCR_DPI / dpi;
    temp = document.createElement('canvas');
    temp.width = Math.max(1, Math.round(r.wPx * s));
    temp.height = Math.max(1, Math.round(r.hPx * s));
    temp.getContext('2d').drawImage(r.canvas, 0, 0, temp.width, temp.height);
    canvas = temp;
    dpi = (temp.width / r.wPt) * PT_PER_INCH;
  } else if (dpi < 220) {
    const rr = await renderPage(page, OCR_DPI, MAX_PIXELS_COLOR, a4);
    temp = rr.canvas;
    canvas = temp;
    dpi = rr.effDpi;
  }
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  freeCanvas(temp);
  return { image: blob || canvas, dpi };
}

// ---------------------------------------------------------------- pdf.js-Dokumente

async function openPdf(bytes) {
  // pdf.js überträgt den Puffer in seinen Worker -> immer eine Kopie übergeben
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice();
  return pdfjsLib.getDocument({ data, ...PDFJS_DOC_OPTS }).promise;
}

// Kleiner Zwischenspeicher für Vorschau/Miniaturen: dasselbe Dokument wird beim
// Blättern nicht jedes Mal neu eingelesen.
const pdfCache = [];   // [{key, promise, users, dead}]
async function withPdf(bytes, fn) {
  let entry = pdfCache.find((e) => e.key === bytes);
  if (!entry) {
    entry = { key: bytes, promise: openPdf(bytes), users: 0, dead: false };
    pdfCache.unshift(entry);
    while (pdfCache.length > 3) {
      const old = pdfCache.pop();
      old.dead = true;
      if (old.users === 0) old.promise.then((d) => d.destroy()).catch(() => {});
    }
  }
  entry.users++;
  try {
    const doc = await entry.promise;
    return await fn(doc);
  } catch (e) {
    const i = pdfCache.indexOf(entry);
    if (i >= 0) pdfCache.splice(i, 1);
    throw e;
  } finally {
    entry.users--;
    if (entry.dead && entry.users === 0) entry.promise.then((d) => d.destroy()).catch(() => {});
  }
}

/** Seitenzahl eines PDFs. */
export async function countPages(bytes) {
  return withPdf(bytes, (doc) => doc.numPages);
}

/**
 * Rendert eine Seite als Bild (Miniatur, Originalansicht).
 * @returns {Promise<{url:string, numPages:number, w:number, h:number}>}
 */
export async function renderPageImage(bytes, pageNumber = 1, maxW = 300, { a4 = false } = {}) {
  return withPdf(bytes, async (doc) => {
    const n = Math.min(Math.max(1, pageNumber), doc.numPages);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const L = pageLayout(base.width, base.height, a4);
    const dpi = (maxW / L.wPt) * PT_PER_INCH;
    const r = await renderPage(page, dpi, MAX_PIXELS_COLOR, a4);
    const url = r.canvas.toDataURL('image/jpeg', 0.86);
    page.cleanup();
    freeCanvas(r.canvas);
    return { url, numPages: doc.numPages, w: r.wPx, h: r.hPx };
  });
}

// ---------------------------------------------------------------- Kodieren einer Seite

/** Optionen für eine bestimmte Seite (Seiten-Ausnahmen überlagern die globalen). */
function optsForPage(opts, p) {
  return opts.pageOverrides?.[p] ? { ...opts, ...opts.pageOverrides[p] } : opts;
}

const clampDpi = (d) => Math.min(Math.max(d || 150, 50), 600);
const maxPixelsFor = (o) => (o.colorMode === 'bw' ? MAX_PIXELS_BW : MAX_PIXELS_COLOR);

// ---------------------------------------------------------------- Hauptpipeline

async function rasterCompress(srcBytes, opts, onProgress, signal) {
  const PDFLib = window.PDFLib;
  const srcDoc = await openPdf(srcBytes);
  const lang = opts.ocrLang || 'deu';
  if (opts.ocr) warmOcr(lang);   // Worker startet, während Seite 1 gerendert wird
  try {
    const pageNumbers = Array.from({ length: srcDoc.numPages }, (_, i) => i + 1);
    const total = pageNumbers.length;
    const newDoc = await PDFLib.PDFDocument.create();
    newDoc.setProducer('PDF Presser (lokal im Browser)');
    const font = opts.ocr ? await newDoc.embedFont(PDFLib.StandardFonts.Helvetica) : null;

    let rendered = 0;
    let recognized = 0;
    const report = (phase, page) => {
      const steps = opts.ocr ? total * 2 : total;
      onProgress?.({ phase, page, pages: total, rendered, recognized, frac: Math.min(0.99, (rendered + recognized) / steps) });
    };

    // OCR läuft (auf dem Server oder im Worker) parallel zum Rendern der
    // nächsten Seiten. Damit der Speicher nicht vollläuft, rendern wir höchstens
    // ein paar Seiten voraus. Am Handy ohne Server-OCR streng nacheinander:
    // Rendern und WebAssembly-Tesseract gleichzeitig bremsen sich dort aus.
    const pending = new Set();
    const ahead = !usesServerOcr(lang) && isMobileDevice() ? 1 : ocrParallel(lang) + 1;
    let ocrError = null;

    for (const p of pageNumbers) {
      checkAbort(signal);
      const pOpts = optsForPage(opts, p);
      report('render', p);
      const page = await srcDoc.getPage(p);
      const r = await renderPage(page, clampDpi(pOpts.dpi), maxPixelsFor(pOpts), !!opts.a4);
      const outPage = newDoc.addPage([r.wPt, r.hPt]);

      // Für OCR das (unveränderte) Farbbild sichern, bevor Graustufen es ändern
      const ocrIn = opts.ocr ? await ocrInputFor(page, r, !!opts.a4) : null;

      if (pOpts.colorMode === 'bw') {
        const { bitmap } = binarize(r.ctx.getImageData(0, 0, r.wPx, r.hPx), pOpts.bias || 0, pOpts.contrast || 0, pOpts.darkAreas || 'auto');
        const ref = embedBwImage(newDoc, PDFLib, bitmap, r.wPx, r.hPx, pOpts.bwFilter || 'auto');
        drawImageRef(outPage, PDFLib, ref, r.wPt, r.hPt);
      } else if (pOpts.colorMode === 'indexed') {
        const { indices, palette } = quantizeIndexed(
          r.ctx.getImageData(0, 0, r.wPx, r.hPx),
          Math.min(16, Math.max(4, pOpts.colors || 16)),
          pOpts.bias || 0,
        );
        const ref = embedIndexedImage(newDoc, PDFLib, indices, palette, r.wPx, r.hPx);
        drawImageRef(outPage, PDFLib, ref, r.wPt, r.hPt);
      } else {
        if (pOpts.colorMode === 'gray') {
          const imageData = r.ctx.getImageData(0, 0, r.wPx, r.hPx);
          applyGrayInPlace(imageData);
          r.ctx.putImageData(imageData, 0, 0);
        }
        const jpeg = await canvasToJpeg(r.canvas, pOpts.quality ?? 0.6);
        const img = await newDoc.embedJpg(jpeg);
        outPage.drawImage(img, { x: 0, y: 0, width: r.wPt, height: r.hPt });
      }
      page.cleanup();
      freeCanvas(r.canvas);
      rendered++;
      report('render', p);

      if (ocrIn) {
        const job = recognizePage(ocrIn.image, lang, { dpi: ocrIn.dpi })
          .then((words) => {
            drawOcrWords(outPage, font, words, ocrIn.dpi, r.hPt);
            recognized++;
            report('ocr', p);
          })
          .catch((e) => { ocrError = ocrError || e; })
          .finally(() => pending.delete(job));
        pending.add(job);
        while (pending.size >= ahead) await Promise.race(pending);
        if (ocrError) throw ocrError;
      }
      await nextFrame();   // Oberfläche zwischendurch atmen lassen
    }

    if (pending.size) report('ocr');
    while (pending.size) {
      checkAbort(signal);
      await Promise.race(pending);
    }
    if (ocrError) throw ocrError;
    onProgress?.({ phase: 'save', pages: total, frac: 0.995 });
    return await newDoc.save({ useObjectStreams: true });
  } finally {
    await srcDoc.destroy();
    if (opts.ocr) releaseOcrSoon();
  }
}

/** Seiten mit pdf-lib auf A4 bringen, ohne sie zu rastern (für „Verlustfrei“). */
function normalizeA4Vector(doc) {
  for (const page of doc.getPages()) {
    const box = page.getMediaBox();
    const L = pageLayout(box.width, box.height, true);
    if (Math.abs(L.wPt - box.width) < 1 && Math.abs(L.hPt - box.height) < 1) continue;
    page.scaleContent(L.sx, L.sy);
    page.scaleAnnotations?.(L.sx, L.sy);
    page.translateContent(L.ox - box.x * L.sx, L.oy - box.y * L.sy);
    page.setMediaBox(0, 0, L.wPt, L.hPt);
    page.setCropBox(0, 0, L.wPt, L.hPt);
    page.setTrimBox?.(0, 0, L.wPt, L.hPt);
    page.setBleedBox?.(0, 0, L.wPt, L.hPt);
    page.setArtBox?.(0, 0, L.wPt, L.hPt);
  }
}

async function losslessCompress(srcBytes, opts = {}, onProgress) {
  const PDFLib = window.PDFLib;
  onProgress?.({ phase: 'optimize', frac: 0.5 });
  const doc = await PDFLib.PDFDocument.load(srcBytes, { updateMetadata: false });
  if (opts.a4) normalizeA4Vector(doc);
  return doc.save({ useObjectStreams: true });
}

/**
 * opts: { mode: 'lossless'|'raster', colorMode: 'color'|'gray'|'bw'|'indexed',
 *         dpi, quality, colors, bias, contrast, darkAreas, bwFilter, ocr, ocrLang,
 *         a4: alle Seiten auf DIN A4,
 *         pageOverrides: { [seitennummer]: Teil-Opts, überlagern die globalen } }
 */
export async function compressPdf(arrayBuffer, opts, onProgress, signal) {
  const srcBytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  if (opts.mode === 'lossless') return losslessCompress(srcBytes, opts, onProgress);
  return rasterCompress(srcBytes, opts, onProgress, signal);
}

// ---------------------------------------------------------------- Vorschau

// Verarbeitet eine Seite mit den gegebenen Einstellungen und liefert ein
// Vorschaubild + die kodierte Größe dieser Seite.
export async function previewPage(bytes, opts, pageNumber = 1, maxW = 1100) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  return withPdf(bytes, async (doc) => {
    const n = Math.min(Math.max(1, pageNumber), doc.numPages);
    const page = await doc.getPage(n);
    const o = opts.mode === 'lossless'
      ? { ...opts, colorMode: 'color', dpi: 110, quality: 0.92 }
      : optsForPage(opts, n);
    const r = await renderPage(page, clampDpi(o.dpi), maxPixelsFor(o), !!opts.a4);
    const { canvas, ctx, wPx, hPx } = r;
    let pageBytes = 0;

    if (o.colorMode === 'bw') {
      const { bitmap } = binarize(ctx.getImageData(0, 0, wPx, hPx), o.bias || 0, o.contrast || 0, o.darkAreas || 'auto');
      const g4 = encodeG4(bitmap, wPx, hPx);
      const flate = await deflateSize(packBits(bitmap, wPx, hPx));
      pageBytes = Math.min(g4.length, flate);
      const out = ctx.createImageData(wPx, hPx);
      for (let i = 0, p = 0; i < bitmap.length; i++, p += 4) {
        const v = bitmap[i] ? 0 : 255;
        out.data[p] = v;
        out.data[p + 1] = v;
        out.data[p + 2] = v;
        out.data[p + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    } else if (o.colorMode === 'indexed') {
      const imageData = ctx.getImageData(0, 0, wPx, hPx);
      const { indices, palette } = quantizeIndexed(imageData, Math.min(16, Math.max(4, o.colors || 16)), o.bias || 0);
      pageBytes = await deflateSize(pack4Bit(indices, wPx, hPx));
      for (let i = 0, p = 0; i < indices.length; i++, p += 4) {
        const [rr, g, b] = palette[indices[i]];
        imageData.data[p] = rr;
        imageData.data[p + 1] = g;
        imageData.data[p + 2] = b;
        imageData.data[p + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    } else {
      if (o.colorMode === 'gray') {
        const imageData = ctx.getImageData(0, 0, wPx, hPx);
        applyGrayInPlace(imageData);
        ctx.putImageData(imageData, 0, 0);
      }
      const jpeg = await canvasToJpeg(canvas, o.quality ?? 0.6);
      pageBytes = jpeg.length;
      if (opts.mode !== 'lossless') {
        // Echte JPEG-Artefakte anzeigen
        const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
        ctx.drawImage(bmp, 0, 0);
        bmp.close?.();
      }
    }

    // Fürs UI verkleinern
    let view = canvas;
    if (wPx > maxW) {
      const s = maxW / wPx;
      view = document.createElement('canvas');
      view.width = Math.round(wPx * s);
      view.height = Math.round(hPx * s);
      const vctx = view.getContext('2d');
      vctx.imageSmoothingQuality = 'high';
      vctx.drawImage(canvas, 0, 0, view.width, view.height);
    }
    const dataUrl = view.toDataURL('image/png');
    page.cleanup();
    freeCanvas(canvas);
    if (view !== canvas) freeCanvas(view);
    return { dataUrl, pageBytes, numPages: doc.numPages, wPx, hPx };
  });
}

// ---------------------------------------------------------------- Simulation

const PAGE_OVERHEAD = 420;     // Seitenobjekt, Bildobjekt, Inhalt (gemessen)
const DOC_OVERHEAD = 900;      // Katalog, Seitenbaum, XRef, Producer

/**
 * Schätzt für mehrere Einstellungen die Ergebnisgröße.
 *
 * variants: [{ key, opts }] – vollständige Optionen je Zeile.
 * Gerechnet wird auf bis zu drei Beispielseiten (erste, mittlere, letzte).
 * Jede Seite wird pro Auflösung nur EINMAL gerendert und dann für alle
 * Varianten mit dieser Auflösung kodiert – deutlich schneller als jede Stufe
 * einzeln komplett durchzurechnen. OCR wird nicht mitgerechnet (der
 * unsichtbare Textlayer macht typischerweise nur wenige KB aus).
 *
 * @returns {Promise<{sizes: Object<string, number>, totalPages, sampledPages}>}
 */
export async function simulateVariants(bytes, variants, onProgress, signal) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const sizes = {};
  const raster = variants.filter((v) => v.opts.mode !== 'lossless');
  const lossless = variants.filter((v) => v.opts.mode === 'lossless');

  return withPdf(bytes, async (doc) => {
    const totalPages = doc.numPages;
    const samples = totalPages <= 3
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : [1, Math.ceil(totalPages / 2), totalPages];
    const acc = Object.fromEntries(raster.map((v) => [v.key, 0]));
    const steps = samples.length * new Set(raster.map((v) => clampDpi(v.opts.dpi))).size + lossless.length;
    let step = 0;
    const tick = (label) => onProgress?.({ frac: Math.min(1, step / Math.max(1, steps)), label });

    for (const v of lossless) {
      checkAbort(signal);
      tick(v.key);
      sizes[v.key] = (await losslessCompress(bytes.slice(), v.opts)).length;
      step++;
    }

    for (const p of samples) {
      const page = await doc.getPage(p);
      const byDpi = new Map();
      for (const v of raster) {
        const o = optsForPage(v.opts, p);
        const d = clampDpi(o.dpi);
        if (!byDpi.has(d)) byDpi.set(d, []);
        byDpi.get(d).push({ v, o });
      }
      for (const [dpi, group] of byDpi) {
        checkAbort(signal);
        tick(group[0].v.key);
        const maxPx = Math.min(...group.map(({ o }) => maxPixelsFor(o)));
        const a4 = !!group[0].v.opts.a4;
        const r = await renderPage(page, dpi, maxPx, a4);
        // Reihenfolge: erst alles, was das Canvas direkt kodiert, dann die
        // Pixel-Varianten, zuletzt Graustufen (verändert die Pixel).
        for (const { v, o } of group.filter((g) => g.o.colorMode === 'color')) {
          acc[v.key] += (await canvasToJpeg(r.canvas, o.quality ?? 0.6)).length + PAGE_OVERHEAD;
        }
        const pixelGroup = group.filter((g) => g.o.colorMode === 'bw' || g.o.colorMode === 'indexed');
        const grayGroup = group.filter((g) => g.o.colorMode === 'gray');
        if (pixelGroup.length || grayGroup.length) {
          const imageData = r.ctx.getImageData(0, 0, r.wPx, r.hPx);
          for (const { v, o } of pixelGroup) {
            checkAbort(signal);
            if (o.colorMode === 'bw') {
              const { bitmap } = binarize(imageData, o.bias || 0, o.contrast || 0, o.darkAreas || 'auto');
              const g4 = encodeG4(bitmap, r.wPx, r.hPx).length;
              const fl = await deflateSize(packBits(bitmap, r.wPx, r.hPx));
              acc[v.key] += Math.min(g4, fl) + PAGE_OVERHEAD;
            } else {
              const { indices, palette } = quantizeIndexed(imageData, Math.min(16, Math.max(4, o.colors || 16)), o.bias || 0);
              acc[v.key] += (await deflateSize(pack4Bit(indices, r.wPx, r.hPx))) + palette.length * 6 + PAGE_OVERHEAD;
            }
            await nextFrame();
          }
          if (grayGroup.length) {
            applyGrayInPlace(imageData);
            r.ctx.putImageData(imageData, 0, 0);
            for (const { v, o } of grayGroup) {
              acc[v.key] += (await canvasToJpeg(r.canvas, o.quality ?? 0.6)).length + PAGE_OVERHEAD;
            }
          }
        }
        freeCanvas(r.canvas);
        step++;
        tick(group[0].v.key);
        await nextFrame();
      }
      page.cleanup();
    }

    for (const v of raster) {
      sizes[v.key] = Math.round((acc[v.key] / samples.length) * totalPages + DOC_OVERHEAD);
    }
    onProgress?.({ frac: 1 });
    return { sizes, totalPages, sampledPages: samples.length, estimated: samples.length < totalPages };
  });
}

/** Kompatibel zur alten Schnittstelle: alle Stufen mit Standardwerten schätzen. */
export async function simulatePdf(arrayBuffer, onProgress, extra = {}) {
  const variants = PRESET_INFO.map(({ key }) => ({ key, opts: { ...PRESETS[key], ...extra } }));
  const { sizes, totalPages, sampledPages, estimated } = await simulateVariants(
    new Uint8Array(arrayBuffer), variants,
    onProgress ? (p) => onProgress({ label: p.label, frac: p.frac }) : null,
  );
  const results = PRESET_INFO.map(({ key, name }) => ({
    key, label: name, size: sizes[key], estimated: key !== 'verlustfrei' && estimated,
  }));
  return { results, totalPages, sampledPages };
}
