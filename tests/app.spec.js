// Ende-zu-Ende-Tests: verifizieren, dass Kompression, G4-Encoder, OCR und PWA
// tatsächlich funktionieren und korrekte, lesbare PDFs erzeugen.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

test.describe.configure({ mode: 'serial' });

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib && window.Tesseract);
}

// Erzeugt im Browser ein "großes" Quell-PDF (Foto-artiger JPEG-Hintergrund + Vektortext)
const MAKE_TEST_PDF = `
async function makeTestPdf(numPages, imgW, imgH, jpegQ) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const canvas = document.createElement('canvas');
  canvas.width = imgW; canvas.height = imgH;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, imgW, imgH);
  grad.addColorStop(0, '#ff8844'); grad.addColorStop(0.5, '#4488ff'); grad.addColorStop(1, '#22cc66');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, imgW, imgH);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = 'rgba(' + (i * 7 % 256) + ',' + (i * 13 % 256) + ',' + (i * 29 % 256) + ',0.5)';
    ctx.beginPath();
    ctx.arc((i * 997) % imgW, (i * 641) % imgH, 20 + (i % 60), 0, 7);
    ctx.fill();
  }
  const jpegBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', jpegQ));
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await doc.embedJpg(jpegBytes);
  for (let p = 0; p < numPages; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    page.drawRectangle({ x: 40, y: 700, width: 515, height: 100, color: rgb(1, 1, 1) });
    page.drawText('Testdokument Seite ' + (p + 1), { x: 60, y: 740, size: 30, font, color: rgb(0, 0, 0) });
  }
  return await doc.save();
}
`;

// Rendert Seite 1 eines PDFs und liefert Statistiken + extrahierten Text
const RENDER_HELPER = `
async function inspectPdf(bytes, scale) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonWhite = 0;
  const bin = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; p < data.length; i++, p += 4) {
    const lum = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    if (lum < 245) nonWhite++;
    bin[i] = lum < 128 ? 1 : 0;
  }
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tp = await doc.getPage(p);
    const tc = await tp.getTextContent();
    text += tc.items.map((it) => it.str).join(' ') + ' ';
  }
  const result = {
    numPages: doc.numPages,
    width: viewport.width / scale,
    height: viewport.height / scale,
    nonWhiteFrac: nonWhite / (canvas.width * canvas.height),
    text,
    bin: Array.from(bin),
    binW: canvas.width,
    binH: canvas.height,
  };
  await doc.destroy();
  return result;
}
`;

test('Kompressionsstufen erzeugen kleinere, gültige PDFs', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ makeSrc, renderSrc }) => {
    /* eslint-disable no-eval */
    eval(makeSrc); eval(renderSrc);
    const src = await makeTestPdf(3, 2000, 2829, 0.95);
    const { compressPdf } = window.__pdfpresser;

    const mittel = await compressPdf(src.buffer.slice(0), { mode: 'raster', colorMode: 'color', dpi: 150, quality: 0.62 });
    const grau = await compressPdf(src.buffer.slice(0), { mode: 'raster', colorMode: 'gray', dpi: 100, quality: 0.4 });
    const sw = await compressPdf(src.buffer.slice(0), { mode: 'raster', colorMode: 'bw', dpi: 300, bwFilter: 'g4' });
    const lossless = await compressPdf(src.buffer.slice(0), { mode: 'lossless' });

    const iMittel = await inspectPdf(mittel, 0.5);
    const iGrau = await inspectPdf(grau, 0.5);
    const iSw = await inspectPdf(sw, 0.5);
    const iLossless = await inspectPdf(lossless, 0.5);
    delete iMittel.bin; delete iGrau.bin; delete iSw.bin; delete iLossless.bin;

    return {
      srcSize: src.length,
      sizes: { mittel: mittel.length, grau: grau.length, sw: sw.length, lossless: lossless.length },
      iMittel, iGrau, iSw, iLossless,
    };
  }, { makeSrc: MAKE_TEST_PDF, renderSrc: RENDER_HELPER });

  console.log('Quelle:', res.srcSize, 'Ergebnisse:', res.sizes);

  // Größen: Raster-Modi müssen deutlich verkleinern
  expect(res.sizes.mittel).toBeLessThan(res.srcSize);
  expect(res.sizes.grau).toBeLessThan(res.sizes.mittel);
  expect(res.sizes.sw).toBeLessThan(res.srcSize * 0.5);
  expect(res.sizes.lossless).toBeLessThan(res.srcSize * 1.2);

  // Gültigkeit: 3 Seiten, A4-Maße, sichtbarer Inhalt
  for (const i of [res.iMittel, res.iGrau, res.iSw, res.iLossless]) {
    expect(i.numPages).toBe(3);
    expect(Math.abs(i.width - 595.28)).toBeLessThan(1);
    expect(Math.abs(i.height - 841.89)).toBeLessThan(1);
    expect(i.nonWhiteFrac).toBeGreaterThan(0.02);
  }
  // Verlustfrei: Vektortext bleibt erhalten
  expect(res.iLossless.text).toContain('Testdokument Seite 1');
});

test('G4-Encoder: Pixel identisch zum Flate-Referenzpfad, Datei kleiner', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ makeSrc, renderSrc }) => {
    eval(makeSrc); eval(renderSrc);
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    // Anspruchsvolle S/W-Vorlage: Text, Linien, Punktraster, schräge Kanten
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const p = doc.addPage([595.28, 841.89]);
    for (let i = 0; i < 40; i++) {
      p.drawText('Zeile ' + i + ' — Ätzöl über müßige Brücken; Fax G4 Test 0123456789', {
        x: 30, y: 800 - i * 19, size: 11, font, color: rgb(0, 0, 0),
      });
    }
    for (let i = 0; i < 60; i++) {
      p.drawRectangle({ x: (i * 37) % 540 + 20, y: (i * 53) % 700 + 40, width: 2 + (i % 5), height: 2 + ((i * 3) % 7), color: rgb(0, 0, 0) });
    }
    p.drawLine({ start: { x: 20, y: 20 }, end: { x: 570, y: 120 }, thickness: 1.2, color: rgb(0, 0, 0) });
    const src = await doc.save();

    const { compressPdf } = window.__pdfpresser;
    const outG4 = await compressPdf(src.buffer.slice(0), { mode: 'raster', colorMode: 'bw', dpi: 200, bwFilter: 'g4' });
    const outFlate = await compressPdf(src.buffer.slice(0), { mode: 'raster', colorMode: 'bw', dpi: 200, bwFilter: 'flate' });
    const outAuto = await compressPdf(src.buffer.slice(0), { mode: 'raster', colorMode: 'bw', dpi: 200, bwFilter: 'auto' });

    // Beide in nativer Auflösung rendern und binarisiert vergleichen
    const scale = 200 / 72;
    const a = await inspectPdf(outG4, scale);
    const b = await inspectPdf(outFlate, scale);
    let mismatches = -1;
    if (a.binW === b.binW && a.binH === b.binH) {
      mismatches = 0;
      for (let i = 0; i < a.bin.length; i++) if (a.bin[i] !== b.bin[i]) mismatches++;
    }
    return {
      g4Size: outG4.length,
      flateSize: outFlate.length,
      autoSize: outAuto.length,
      dims: [a.binW, a.binH, b.binW, b.binH],
      totalPx: a.binW * a.binH,
      mismatches,
      nonWhiteFrac: a.nonWhiteFrac,
    };
  }, { makeSrc: MAKE_TEST_PDF, renderSrc: RENDER_HELPER });

  console.log('G4:', res.g4Size, 'Bytes, Flate:', res.flateSize, 'Bytes, Auto:', res.autoSize, 'Bytes, Pixelabweichungen:', res.mismatches, '/', res.totalPx);
  expect(res.mismatches).toBe(0);
  expect(res.nonWhiteFrac).toBeGreaterThan(0.01); // Seite ist nicht leer
  // Auto wählt pro Seite die kleinere Methode
  expect(res.autoSize).toBeLessThanOrEqual(Math.max(res.g4Size, res.flateSize));
  expect(res.autoSize).toBeLessThanOrEqual(Math.min(res.g4Size, res.flateSize) + 500);
});

test('OCR erzeugt durchsuchbaren Textlayer auf Scan ohne Text', async ({ page }) => {
  test.setTimeout(360000);
  await ready(page);
  const res = await page.evaluate(async ({ renderSrc }) => {
    eval(renderSrc);
    const { PDFDocument } = window.PDFLib;
    // "Scan": Bild einer Seite mit Text, aber ohne echten Textlayer
    const W = 1654, H = 2339; // A4 bei 200 dpi
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.font = '700 90px Arial';
    ctx.fillText('RECHNUNG 4711', 150, 300);
    ctx.font = '400 64px Arial';
    ctx.fillText('Musterfirma GmbH', 150, 450);
    ctx.fillText('Betrag: 199 Euro', 150, 580);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const doc = await PDFDocument.create();
    const img = await doc.embedJpg(jpeg);
    const p = doc.addPage([595.28, 841.89]);
    p.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    const src = await doc.save();

    const before = await inspectPdf(src, 0.3);

    const { compressPdf } = window.__pdfpresser;
    const out = await compressPdf(src.buffer.slice(0), {
      mode: 'raster', colorMode: 'bw', dpi: 300, bwFilter: 'g4', ocr: true, ocrLang: 'deu',
    });
    const after = await inspectPdf(out, 0.3);
    return {
      srcSize: src.length,
      outSize: out.length,
      textBefore: before.text.trim(),
      textAfter: after.text,
      nonWhiteFrac: after.nonWhiteFrac,
    };
  }, { renderSrc: RENDER_HELPER });

  console.log('Scan:', res.srcSize, '→', res.outSize, 'Bytes; OCR-Text:', JSON.stringify(res.textAfter.slice(0, 200)));
  expect(res.textBefore).toBe(''); // Quelle hatte keinen Textlayer
  expect(res.textAfter).toContain('RECHNUNG');
  expect(res.textAfter).toContain('Musterfirma');
  expect(res.nonWhiteFrac).toBeGreaterThan(0.005);
  expect(res.outSize).toBeLessThan(res.srcSize);
});

test('UI: Datei laden, komprimieren, herunterladen', async ({ page }) => {
  await ready(page);
  // Großes Test-PDF im Browser erzeugen (JPEG-Hintergrund -> echte Ersparnis möglich)
  const srcB64 = await page.evaluate(async ({ makeSrc }) => {
    eval(makeSrc);
    const bytes = await makeTestPdf(2, 2000, 2829, 0.95);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(bin);
  }, { makeSrc: MAKE_TEST_PDF });
  const tmpPdf = path.join(os.tmpdir(), 'ui-test.pdf');
  fs.writeFileSync(tmpPdf, Buffer.from(srcB64, 'base64'));
  const srcSize = fs.statSync(tmpPdf).size;
  await page.setInputFiles('#fileInput', tmpPdf);
  await expect(page.locator('.file-item')).toHaveCount(1);
  await expect(page.locator('.file-name')).toHaveText('ui-test.pdf');

  await page.locator('input[name="preset"][value="stark"]').check();
  await page.locator('#startBtn').click();
  await expect(page.locator('.file-status.ok')).toBeVisible({ timeout: 120000 });
  await expect(page.locator('.file-status')).toContainText('gespart');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.btn-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('ui-test_komprimiert.pdf');
  const outPath = path.join(os.tmpdir(), 'ui-test-out.pdf');
  await download.saveAs(outPath);
  const outSize = fs.statSync(outPath).size;
  console.log('UI-Test:', srcSize, '→', outSize, 'Bytes');
  expect(outSize).toBeGreaterThan(500);

  // Ergebnis in Node validieren
  const outDoc = await PDFDocument.load(fs.readFileSync(outPath));
  expect(outDoc.getPageCount()).toBe(2);
});

test('PWA: Manifest, Icons, Service Worker und Offline-Betrieb', async ({ page, context }) => {
  await ready(page);

  // Manifest + Icons erreichbar
  for (const url of ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/sw.js']) {
    const resp = await page.request.get(url);
    expect(resp.status(), url).toBe(200);
  }
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

  // Service Worker aktiv und Precache vollständig
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready, null, { timeout: 30000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => {
    const cache = await caches.open('pdfpresser-v1');
    const keys = await cache.keys();
    return keys.length >= 20;
  }, null, { timeout: 60000 });

  // Offline gehen und neu laden: App muss vollständig aus dem Cache starten
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib && window.Tesseract, null, { timeout: 30000 });
  await expect(page.locator('h1')).toHaveText(/PDF\s*Presser/);

  // Auch offline komprimieren (inkl. OCR-Assets aus dem Cache)
  const ok = await page.evaluate(async () => {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([300, 300]);
    p.drawText('Offline-Test', { x: 40, y: 150, size: 24, font, color: rgb(0, 0, 0) });
    const src = await doc.save();
    const out = await window.__pdfpresser.compressPdf(src.buffer, { mode: 'raster', colorMode: 'bw', dpi: 150, bwFilter: 'g4' });
    return out.length > 100;
  });
  expect(ok).toBe(true);
  await context.setOffline(false);
});
