// Kompressions-Pipeline: PDF -> (Render mit pdf.js) -> neu aufgebautes PDF (pdf-lib).
// Alles läuft lokal im Browser, es werden keine Daten hochgeladen.

import { encodeG4 } from './ccitt-g4.js';
import { recognizePage } from './ocr.js';

const pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const PT_PER_INCH = 72;

export const PRESETS = {
  verlustfrei: { mode: 'lossless', label: 'Verlustfrei (nur Struktur-Optimierung)' },
  leicht:      { mode: 'raster', colorMode: 'color', dpi: 200, quality: 0.80 },
  mittel:      { mode: 'raster', colorMode: 'color', dpi: 150, quality: 0.62 },
  stark:       { mode: 'raster', colorMode: 'color', dpi: 110, quality: 0.45 },
  'extrem-grau': { mode: 'raster', colorMode: 'gray', dpi: 100, quality: 0.40 },
  'extrem-sw': { mode: 'raster', colorMode: 'bw', dpi: 300 },
};

// ---------------------------------------------------------------- Hilfsfunktionen

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

function grayToCanvas(imageData, ctx) {
  const { data } = imageData;
  for (let p = 0; p < data.length; p += 4) {
    const g = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    data[p] = g;
    data[p + 1] = g;
    data[p + 2] = g;
  }
  ctx.putImageData(imageData, 0, 0);
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

// ---------------------------------------------------------------- Hauptpipeline

async function rasterCompress(srcBytes, opts, onProgress) {
  const PDFLib = window.PDFLib;
  const loadingTask = pdfjsLib.getDocument({ data: srcBytes });
  const srcDoc = await loadingTask.promise;
  const numPages = srcDoc.numPages;

  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.setProducer('PDF Presser (lokal im Browser)');
  const font = opts.ocr ? await newDoc.embedFont(PDFLib.StandardFonts.Helvetica) : null;

  const dpi = Math.min(Math.max(opts.dpi || 150, 50), 600);
  const scale = dpi / PT_PER_INCH;

  for (let p = 1; p <= numPages; p++) {
    onProgress?.({ phase: 'render', page: p, pages: numPages });
    const page = await srcDoc.getPage(p);
    const viewport = page.getViewport({ scale });
    const wPx = Math.max(1, Math.round(viewport.width));
    const hPx = Math.max(1, Math.round(viewport.height));
    const wPt = viewport.width / scale;
    const hPt = viewport.height / scale;

    const canvas = document.createElement('canvas');
    canvas.width = wPx;
    canvas.height = hPx;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, wPx, hPx);
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

    const outPage = newDoc.addPage([wPt, hPt]);

    if (opts.colorMode === 'bw') {
      const imageData = ctx.getImageData(0, 0, wPx, hPx);
      const gray = toGray(imageData);
      const threshold = otsuThreshold(gray);
      const bitmap = new Uint8Array(gray.length);
      for (let i = 0; i < gray.length; i++) bitmap[i] = gray[i] < threshold ? 1 : 0;
      const ref = embedBwImage(newDoc, PDFLib, bitmap, wPx, hPx, opts.bwFilter || 'auto');
      drawImageRef(outPage, PDFLib, ref, wPt, hPt);
    } else {
      if (opts.colorMode === 'gray') {
        grayToCanvas(ctx.getImageData(0, 0, wPx, hPx), ctx);
      }
      const jpeg = await canvasToJpeg(canvas, opts.quality ?? 0.6);
      const img = await newDoc.embedJpg(jpeg);
      outPage.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    }

    if (opts.ocr) {
      onProgress?.({ phase: 'ocr', page: p, pages: numPages });
      // Für gute OCR-Qualität ggf. höher auflösen als das Zielbild
      let ocrCanvas = canvas;
      let ocrDpi = dpi;
      if (dpi < 200) {
        ocrDpi = 240;
        const ocrViewport = page.getViewport({ scale: ocrDpi / PT_PER_INCH });
        ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = Math.max(1, Math.round(ocrViewport.width));
        ocrCanvas.height = Math.max(1, Math.round(ocrViewport.height));
        const octx = ocrCanvas.getContext('2d');
        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
        await page.render({ canvasContext: octx, viewport: ocrViewport, intent: 'print' }).promise;
      }
      const words = await recognizePage(ocrCanvas, opts.ocrLang || 'deu', (prog) => {
        onProgress?.({ phase: 'ocr', page: p, pages: numPages, detail: prog });
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

// opts: { mode: 'lossless'|'raster', colorMode: 'color'|'gray'|'bw',
//         dpi, quality, bwFilter: 'g4'|'flate', ocr, ocrLang }
export async function compressPdf(arrayBuffer, opts, onProgress) {
  const srcBytes = new Uint8Array(arrayBuffer);
  if (opts.mode === 'lossless') {
    return losslessCompress(srcBytes, onProgress);
  }
  // pdf.js überträgt den Buffer in seinen Worker -> Kopie übergeben
  return rasterCompress(srcBytes.slice(), opts, onProgress);
}
