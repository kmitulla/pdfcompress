// Kompressions-Pipeline: PDF -> (Render mit pdf.js) -> neu aufgebautes PDF (pdf-lib).
// Alles läuft lokal im Browser, es werden keine Daten hochgeladen.

import { encodeG4 } from './ccitt-g4.js';
import { recognizePage } from './ocr.js';

const pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const PT_PER_INCH = 72;

export const PRESETS = {
  verlustfrei: { mode: 'lossless' },
  leicht:      { mode: 'raster', colorMode: 'color', dpi: 200, quality: 0.80 },
  mittel:      { mode: 'raster', colorMode: 'color', dpi: 150, quality: 0.62 },
  stark:       { mode: 'raster', colorMode: 'color', dpi: 110, quality: 0.45 },
  'extrem-grau':  { mode: 'raster', colorMode: 'gray', dpi: 100, quality: 0.40 },
  'extrem-farbe': { mode: 'raster', colorMode: 'indexed', dpi: 150, colors: 16 },
  'extrem-sw': { mode: 'raster', colorMode: 'bw', dpi: 300 },
};

// Reihenfolge + Anzeigenamen für die Simulation
export const PRESET_INFO = [
  ['verlustfrei', 'Verlustfrei (nur Optimierung)'],
  ['leicht', 'Leicht – Farbe 200 dpi'],
  ['mittel', 'Mittel – Farbe 150 dpi'],
  ['stark', 'Stark – Farbe 110 dpi'],
  ['extrem-grau', 'Extrem – Graustufen 100 dpi'],
  ['extrem-farbe', 'Extrem Farbe – Scanner-Stil (16 Farben)'],
  ['extrem-sw', 'Extrem S/W – Scanner-Stil (G4)'],
];

// ---------------------------------------------------------------- Bild-Helfer

function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
  }
  return gray;
}

// Otsu-Schwellwert für die Binarisierung (S/W-Modus)
function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      threshold = t;
    }
  }
  return threshold;
}

// bias: Helligkeitsregler (-40..+40); positiv = heller (mehr Weiß)
function binarize(imageData, bias) {
  const gray = toGray(imageData);
  const threshold = Math.min(250, Math.max(5, otsuThreshold(gray) - (bias | 0)));
  const bitmap = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) bitmap[i] = gray[i] < threshold ? 1 : 0;
  return { bitmap, threshold };
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
  let boxes = samples.length ? [samples] : [];
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

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b))) : reject(new Error('JPEG-Encoding fehlgeschlagen'))),
      'image/jpeg',
      quality,
    );
  });
}

// 1-Bit-Bitmap (1 = schwarz) zeilenweise zu Bytes packen; Bit 1 = weiß
// (DeviceGray: 0 = schwarz), wie es FlateDecode + /Decode [0 1] erwartet.
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
    const size = Math.max(2, Math.min(72, boxH * 1.0));
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

async function renderPage(page, dpi) {
  const scale = dpi / PT_PER_INCH;
  const viewport = page.getViewport({ scale });
  const wPx = Math.max(1, Math.round(viewport.width));
  const hPx = Math.max(1, Math.round(viewport.height));
  const canvas = document.createElement('canvas');
  canvas.width = wPx;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, wPx, hPx);
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  return { canvas, ctx, wPx, hPx, wPt: viewport.width / scale, hPt: viewport.height / scale };
}

// ---------------------------------------------------------------- Hauptpipeline

async function rasterCompress(srcBytes, opts, onProgress) {
  const PDFLib = window.PDFLib;
  const loadingTask = pdfjsLib.getDocument({ data: srcBytes });
  const srcDoc = await loadingTask.promise;
  const pageNumbers = opts._pages?.length
    ? opts._pages.filter((p) => p >= 1 && p <= srcDoc.numPages)
    : Array.from({ length: srcDoc.numPages }, (_, i) => i + 1);

  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.setProducer('PDF Presser (lokal im Browser)');
  const font = opts.ocr ? await newDoc.embedFont(PDFLib.StandardFonts.Helvetica) : null;

  const dpi = Math.min(Math.max(opts.dpi || 150, 50), 600);

  for (let idx = 0; idx < pageNumbers.length; idx++) {
    const p = pageNumbers[idx];
    onProgress?.({ phase: 'render', page: idx + 1, pages: pageNumbers.length });
    const page = await srcDoc.getPage(p);
    const { canvas, ctx, wPx, hPx, wPt, hPt } = await renderPage(page, dpi);
    const outPage = newDoc.addPage([wPt, hPt]);

    if (opts.colorMode === 'bw') {
      const { bitmap } = binarize(ctx.getImageData(0, 0, wPx, hPx), opts.bias || 0);
      const ref = embedBwImage(newDoc, PDFLib, bitmap, wPx, hPx, opts.bwFilter || 'auto');
      drawImageRef(outPage, PDFLib, ref, wPt, hPt);
    } else if (opts.colorMode === 'indexed') {
      const { indices, palette } = quantizeIndexed(
        ctx.getImageData(0, 0, wPx, hPx),
        Math.min(16, Math.max(4, opts.colors || 16)),
        opts.bias || 0,
      );
      const ref = embedIndexedImage(newDoc, PDFLib, indices, palette, wPx, hPx);
      drawImageRef(outPage, PDFLib, ref, wPt, hPt);
    } else {
      if (opts.colorMode === 'gray') {
        const imageData = ctx.getImageData(0, 0, wPx, hPx);
        applyGrayInPlace(imageData);
        ctx.putImageData(imageData, 0, 0);
      }
      const jpeg = await canvasToJpeg(canvas, opts.quality ?? 0.6);
      const img = await newDoc.embedJpg(jpeg);
      outPage.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    }

    if (opts.ocr) {
      onProgress?.({ phase: 'ocr', page: idx + 1, pages: pageNumbers.length });
      // Für gute OCR-Qualität ggf. höher auflösen als das Zielbild
      let ocrCanvas = canvas;
      let ocrDpi = dpi;
      if (dpi < 200) {
        ocrDpi = 240;
        const rendered = await renderPage(page, ocrDpi);
        ocrCanvas = rendered.canvas;
      }
      const words = await recognizePage(ocrCanvas, opts.ocrLang || 'deu', (prog) => {
        onProgress?.({ phase: 'ocr', page: idx + 1, pages: pageNumbers.length, detail: prog });
      });
      drawOcrWords(outPage, font, words, ocrDpi, hPt);
    }

    page.cleanup();
  }

  await srcDoc.destroy();
  onProgress?.({ phase: 'save' });
  return newDoc.save({ useObjectStreams: true });
}

async function losslessCompress(srcBytes, onProgress) {
  const PDFLib = window.PDFLib;
  onProgress?.({ phase: 'optimize' });
  const doc = await PDFLib.PDFDocument.load(srcBytes, { updateMetadata: false });
  return doc.save({ useObjectStreams: true });
}

// opts: { mode: 'lossless'|'raster', colorMode: 'color'|'gray'|'bw'|'indexed',
//         dpi, quality, colors, bias, bwFilter: 'auto'|'g4'|'flate', ocr, ocrLang }
export async function compressPdf(arrayBuffer, opts, onProgress) {
  const srcBytes = new Uint8Array(arrayBuffer);
  if (opts.mode === 'lossless') {
    return losslessCompress(srcBytes, onProgress);
  }
  // pdf.js überträgt den Buffer in seinen Worker -> Kopie übergeben
  return rasterCompress(srcBytes.slice(), opts, onProgress);
}

// ---------------------------------------------------------------- Vorschau

// Verarbeitet Seite 1 mit den aktuellen Einstellungen und liefert ein
// Vorschaubild + die kodierte Größe dieser Seite.
export async function previewPage(arrayBuffer, opts, pageNumber = 1) {
  const srcBytes = new Uint8Array(arrayBuffer).slice();
  const doc = await pdfjsLib.getDocument({ data: srcBytes }).promise;
  const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
  const dpi = Math.min(Math.max(opts.dpi || 150, 50), 600);
  const { canvas, ctx, wPx, hPx } = await renderPage(page, dpi);

  let pageBytes;
  let viewCanvas = canvas;

  if (opts.colorMode === 'bw') {
    const { bitmap } = binarize(ctx.getImageData(0, 0, wPx, hPx), opts.bias || 0);
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
  } else if (opts.colorMode === 'indexed') {
    const imageData = ctx.getImageData(0, 0, wPx, hPx);
    const { indices, palette } = quantizeIndexed(imageData, Math.min(16, Math.max(4, opts.colors || 16)), opts.bias || 0);
    pageBytes = await deflateSize(pack4Bit(indices, wPx, hPx));
    for (let i = 0, p = 0; i < indices.length; i++, p += 4) {
      const [r, g, b] = palette[indices[i]];
      imageData.data[p] = r;
      imageData.data[p + 1] = g;
      imageData.data[p + 2] = b;
      imageData.data[p + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  } else {
    if (opts.colorMode === 'gray') {
      const imageData = ctx.getImageData(0, 0, wPx, hPx);
      applyGrayInPlace(imageData);
      ctx.putImageData(imageData, 0, 0);
    }
    const jpeg = await canvasToJpeg(canvas, opts.quality ?? 0.6);
    pageBytes = jpeg.length;
    // Echte JPEG-Artefakte anzeigen
    const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
  }

  // Fürs UI herunterskalieren
  const maxW = 900;
  if (wPx > maxW) {
    const s = maxW / wPx;
    const small = document.createElement('canvas');
    small.width = Math.round(wPx * s);
    small.height = Math.round(hPx * s);
    small.getContext('2d').drawImage(viewCanvas, 0, 0, small.width, small.height);
    viewCanvas = small;
  }
  const dataUrl = viewCanvas.toDataURL('image/png');
  const numPages = doc.numPages;
  page.cleanup();
  await doc.destroy();
  return { dataUrl, pageBytes, numPages, wPx, hPx };
}

// ---------------------------------------------------------------- Simulation

// Rechnet alle Presets durch. Bei langen Dokumenten wird auf Stichproben-
// Seiten (erste/mittlere/letzte) gerechnet und hochgerechnet.
export async function simulatePdf(arrayBuffer, onProgress) {
  const srcBytes = new Uint8Array(arrayBuffer);
  const probe = await pdfjsLib.getDocument({ data: srcBytes.slice() }).promise;
  const totalPages = probe.numPages;
  await probe.destroy();

  const samples = totalPages <= 3
    ? Array.from({ length: totalPages }, (_, i) => i + 1)
    : [1, Math.ceil(totalPages / 2), totalPages];
  const estimated = samples.length < totalPages;

  const results = [];
  for (const [key, label] of PRESET_INFO) {
    onProgress?.({ preset: key, label });
    const preset = PRESETS[key];
    let size;
    if (preset.mode === 'lossless') {
      const out = await losslessCompress(srcBytes);
      size = out.length;
      results.push({ key, label, size, estimated: false });
    } else {
      const out = await rasterCompress(srcBytes.slice(), { ...preset, _pages: samples });
      size = Math.round((out.length / samples.length) * totalPages);
      results.push({ key, label, size, estimated });
    }
  }
  return { results, totalPages, sampledPages: samples.length };
}
