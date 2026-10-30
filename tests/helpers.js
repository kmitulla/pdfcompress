// Gemeinsame Helfer für die Ende-zu-Ende-Tests.
import { PDFiumLibrary } from '@hyzyla/pdfium';

/** App laden und warten, bis Backend & Einstellungen stehen. */
export async function ready(page, settings = {}, { keepDocs = false } = {}) {
  // Dokumente liegen auch auf dem Test-Server – jeder Test beginnt mit leerer Liste
  if (!keepDocs) await clearServerDocs();
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib && window.Tesseract);
  await page.evaluate(() => window.__pdfpresser.booted);
  // Der Server ist über alle Tests derselbe – Einstellungen sauber zurücksetzen
  await page.evaluate((s) => window.__pdfpresser.resetSettings(s), settings);
}

/** Erzeugt im Browser ein PDF und legt es als Dokument an. Liefert die Doc-ID. */
export async function addTestPdf(page, { pages = 2, name = 'Test.pdf', kind = 'pdf', size = [595.28, 841.89], text = 'Testdokument' } = {}) {
  return page.evaluate(async ({ pages, name, kind, size, text }) => {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (let p = 0; p < pages; p++) {
      const pg = doc.addPage(size);
      pg.drawRectangle({ x: 0, y: size[1] - 140, width: size[0], height: 140, color: rgb(0.85, 0.9, 1) });
      pg.drawText(`${text} Seite ${p + 1}`, { x: 40, y: size[1] - 90, size: 26, font, color: rgb(0, 0, 0) });
      for (let l = 0; l < 12; l++) pg.drawText(`Zeile ${l}`, { x: 40, y: size[1] - 200 - l * 24, size: 14, font, color: rgb(0.1, 0.1, 0.1) });
    }
    const bytes = await doc.save();
    const d = await window.__pdfpresser.addPdfDoc(new Uint8Array(bytes), name, { kind });
    return d.id;
  }, { pages, name, kind, size, text });
}

// Erzeugt im Browser ein "großes" Quell-PDF (Foto-artiger JPEG-Hintergrund + Vektortext)
export const MAKE_TEST_PDF = `
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
export const RENDER_HELPER = `
async function inspectPdf(bytes, scale, pageNo = 1) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonWhite = 0;
  const W = canvas.width, H = canvas.height;
  const colLum = (x) => { let s = 0; for (let y = 0; y < H; y++) { const p = (y * W + x) * 4; s += (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8; } return s / H; };
  for (let p = 0; p < data.length; p += 4) {
    const lum = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    if (lum < 245) nonWhite++;
  }
  let text = '';
  const sizes = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tp = await doc.getPage(p);
    const vp = tp.getViewport({ scale: 1 });
    sizes.push([Math.round(vp.width), Math.round(vp.height)]);
    const tc = await tp.getTextContent();
    text += tc.items.map((it) => it.str).join(' ') + ' ';
  }
  const result = {
    numPages: doc.numPages,
    width: viewport.width / scale,
    height: viewport.height / scale,
    sizes,
    nonWhiteFrac: nonWhite / (W * H),
    leftLum: colLum(1), rightLum: colLum(W - 2),
    text,
  };
  await doc.destroy();
  return result;
}
`;

// Unabhängige Gegenprobe mit PDFium (Engine von Chrome/Edge): rendert Seite 1
// und liefert Schwarz-/Weiß-Anteile.
export async function pdfiumStats(bytes) {
  const lib = await PDFiumLibrary.init();
  try {
    const doc = await lib.loadDocument(Buffer.from(bytes));
    const page = doc.getPage(0);
    const r = await page.render({ scale: 0.6, render: 'bitmap' });
    const d = r.data;
    let black = 0;
    let white = 0;
    const total = r.width * r.height;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
      if (l < 60) black++;
      else if (l > 230) white++;
    }
    doc.destroy();
    return { blackFrac: black / total, whiteFrac: white / total };
  } finally {
    lib.destroy();
  }
}

/** Ergebnis-Bytes eines Dokuments (Uint8Array -> Buffer). */
export async function docResult(page, idx = 0, which = 'result') {
  const arr = await page.evaluate(({ idx, which }) => Array.from(window.__pdfpresser.state.docs[idx][which]), { idx, which });
  return Buffer.from(arr);
}

/** Gefälschte Backend-Konfiguration (z. B. Scanner vorhanden). */
export async function fakeConfig(page, over = {}) {
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ scanner: true, consume: true, paperless: 'folder', profile: true, raw: true, version: 'test', ...over }),
  }));
  await page.route('**/api/scanner/status', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, model: 'EPSON ET-2720 Series' }),
  }));
}

/**
 * JPEG wie vom Epson ET-2720 bei 300 dpi: Glasfläche 215,9 × 297 mm
 * (2550 × 3508 px), Blatt liegt oben links, rechts 6 mm grauer Überstand.
 */
export async function bedScanJpeg(page, { dpi = 300, w, h, overhang = '#9a9a9a', label = 'SEITE', offX = 0, offY = 0 } = {}) {
  const arr = await page.evaluate(async ({ dpi, w, h, overhang, label, offX, offY }) => {
    const mm = dpi / 25.4;
    const c = document.createElement('canvas');
    c.width = w || Math.round(215.9 * mm);
    c.height = h || Math.round(297 * mm);
    const x = c.getContext('2d');
    x.fillStyle = overhang; x.fillRect(0, 0, c.width, c.height);
    // Blatt (A4) liegt an der Ecke oben links, optional um offX/offY mm versetzt
    x.fillStyle = '#ffffff'; x.fillRect(Math.round(offX * mm), Math.round(offY * mm), Math.round(210 * mm), Math.round(297 * mm));
    x.fillStyle = '#111'; x.font = `700 ${Math.round(10 * mm)}px Arial`; x.fillText(label, 17 * mm, 34 * mm);
    for (let i = 0; i < 20; i++) x.fillRect(17 * mm, (50 + i * 10) * mm, 135 * mm, 2 * mm);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, { dpi, w, h, overhang, label, offX, offY });
  return Buffer.from(arr);
}

// ---- Test-Scanner (tests/escl-mock-server.mjs, Port 8861) ----
export const MOCK = 'http://127.0.0.1:8861';

/** Test-Scanner zurücksetzen und optional ein Bild für eine Auflösung hinterlegen. */
export async function mockScanner({ image, dpi = 'any', config, reset = true } = {}) {
  if (reset) await fetch(`${MOCK}/__mock/reset`, { method: 'POST' });
  if (image) await fetch(`${MOCK}/__mock/image?dpi=${dpi}`, { method: 'POST', body: image });
  if (config) await fetch(`${MOCK}/__mock/config`, { method: 'POST', body: JSON.stringify(config) });
  return mockState();
}
export const mockState = async () => (await fetch(`${MOCK}/__mock/state`)).json();

/** Alle Scan-Aufträge des Test-Servers wegräumen. */
export async function clearScanJobs(base = 'http://127.0.0.1:8823') {
  const { jobs } = await (await fetch(`${base}/api/scan-jobs`)).json();
  for (const j of jobs) {
    if (j.live) await fetch(`${base}/api/scan-jobs/${j.id}/cancel`, { method: 'POST' });
    await fetch(`${base}/api/scan-jobs/${j.id}`, { method: 'DELETE' });
  }
}

// Synthetisches „Foto“: helles, schräg liegendes Dokument auf dunklem Grund
export const MAKE_PHOTO = `
function makePhotoCanvas(w, h, corners, docColor) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a3f47';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 250; i++) {
    ctx.fillStyle = 'rgba(0,0,0,' + (0.05 + (i % 10) / 50) + ')';
    ctx.fillRect((i * 131) % w, (i * 197) % h, 9, 9);
  }
  ctx.fillStyle = docColor || '#f4f0e8';
  ctx.beginPath();
  corners.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x * w, y * h); else ctx.lineTo(x * w, y * h); });
  ctx.closePath();
  ctx.fill();
  const cx = corners.reduce((s, p) => s + p[0], 0) / 4 * w;
  const cy = corners.reduce((s, p) => s + p[1], 0) / 4 * h;
  ctx.fillStyle = '#222';
  for (let r = 0; r < 5; r++) {
    ctx.fillRect(cx - w * 0.12, cy - h * 0.1 + r * h * 0.05, w * 0.24, h * 0.012);
  }
  return c;
}
`;

export const PHOTO_CORNERS = [[0.15, 0.12], [0.85, 0.18], [0.9, 0.88], [0.12, 0.8]];

export async function photoJpeg(page, w = 1200, h = 900, docColor = null, corners = PHOTO_CORNERS) {
  const dataUrl = await page.evaluate(
    ({ makePhoto, w, h, corners, docColor }) => {
      // eslint-disable-next-line no-eval
      eval(makePhoto);
      return makePhotoCanvas(w, h, corners, docColor).toDataURL('image/jpeg', 0.92);
    },
    { makePhoto: MAKE_PHOTO, w, h, corners, docColor },
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** Regression: Icon-Markup darf nie als Text in der Oberfläche landen. */
export async function assertNoRawMarkup(expect, page, scope) {
  const text = await page.locator(scope).innerText();
  for (const needle of ['<svg', 'viewBox', 'stroke-linecap', '<path']) {
    expect(text, `rohes Markup „${needle}“ sichtbar in ${scope}`).not.toContain(needle);
  }
}

/** Alle Dokumente des Test-Servers löschen. */
export async function clearServerDocs(base = 'http://127.0.0.1:8823') {
  try {
    const { docs } = await (await fetch(`${base}/api/docs`)).json();
    for (const d of docs) await fetch(`${base}/api/docs/${d.id}`, { method: 'DELETE' });
  } catch { /* Server (noch) nicht da */ }
}
