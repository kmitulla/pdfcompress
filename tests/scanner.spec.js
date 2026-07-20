// Ende-zu-Ende-Tests für den Dokumenten-Scanner: Rand-/Eckenerkennung,
// Perspektivkorrektur, kompletter UI-Ablauf (Bildimport & Fake-Kamera),
// A4-Format, Drehen, Lupe und anschließende Kompression des Scans.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
}

// Synthetisches „Foto“: helles, schräg liegendes Dokument auf dunklem Grund
const MAKE_PHOTO = `
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
  // „Textzeilen“ in der Mitte des Dokuments
  const cx = corners.reduce((s, p) => s + p[0], 0) / 4 * w;
  const cy = corners.reduce((s, p) => s + p[1], 0) / 4 * h;
  ctx.fillStyle = '#222';
  for (let r = 0; r < 5; r++) {
    ctx.fillRect(cx - w * 0.12, cy - h * 0.1 + r * h * 0.05, w * 0.24, h * 0.012);
  }
  return c;
}
`;

const PHOTO_CORNERS = [[0.15, 0.12], [0.85, 0.18], [0.9, 0.88], [0.12, 0.8]];

async function photoJpegBuffer(page, w = 1200, h = 900, docColor = null) {
  const dataUrl = await page.evaluate(
    ({ makePhoto, w, h, corners, docColor }) => {
      // eslint-disable-next-line no-eval
      eval(makePhoto);
      return makePhotoCanvas(w, h, corners, docColor).toDataURL('image/jpeg', 0.92);
    },
    { makePhoto: MAKE_PHOTO, w, h, corners: PHOTO_CORNERS, docColor },
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// Rendert Seite 1 des ersten Listeneintrags und misst den Blau-Anteil in
// Bildzeilen-Bändern (für die A4-Einpassungs-Tests mit blauem „Dokument“)
async function bluePageBands(page) {
  return page.evaluate(async () => {
    const item = window.__pdfpresser.items[0];
    const bytes = new Uint8Array(await window.__pdfpresser.itemBytes(item));
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 0.5 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const blueFrac = (y0, y1) => {
      let blue = 0;
      let tot = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          tot++;
          if (d[i + 2] - d[i] > 25) blue++;
        }
      }
      return blue / tot;
    };
    const h = c.height;
    const result = {
      top: blueFrac(0, Math.floor(h * 0.08)),
      mid: blueFrac(Math.floor(h * 0.45), Math.floor(h * 0.55)),
      aspect: c.width / c.height,
    };
    await doc.destroy();
    return result;
  });
}

test('Eckenerkennung findet das Dokument im Foto', async ({ page }) => {
  await ready(page);
  const { detected, expected } = await page.evaluate(async ({ makePhoto, corners }) => {
    // eslint-disable-next-line no-eval
    eval(makePhoto);
    const mod = await import('./js/scanner.js');
    const photo = makePhotoCanvas(1000, 750, corners);
    return {
      detected: mod.detectCornersOnCanvas(photo),
      expected: corners.map(([x, y]) => ({ x, y })),
    };
  }, { makePhoto: MAKE_PHOTO, corners: PHOTO_CORNERS });

  expect(detected).not.toBeNull();
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(detected[i].x - expected[i].x)).toBeLessThan(0.04);
    expect(Math.abs(detected[i].y - expected[i].y)).toBeLessThan(0.04);
  }
});

test('Perspektivkorrektur bildet die Ecken korrekt ab', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async () => {
    const mod = await import('./js/scanner.js');
    const src = document.createElement('canvas');
    src.width = 800; src.height = 600;
    const ctx = src.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 800, 600);
    // Farbige Scheiben exakt auf den Viereck-Ecken
    const quad = [
      { x: 0.2, y: 0.15, col: '#ff0000' },
      { x: 0.85, y: 0.2, col: '#00ff00' },
      { x: 0.9, y: 0.85, col: '#0000ff' },
      { x: 0.15, y: 0.8, col: '#ffff00' },
    ];
    for (const q of quad) {
      ctx.fillStyle = q.col;
      ctx.beginPath();
      ctx.arc(q.x * 799, q.y * 599, 25, 0, Math.PI * 2);
      ctx.fill();
    }
    const out = mod.warpPerspective(src, quad.map((q) => ({ x: q.x, y: q.y })), 400, 300);
    const octx = out.getContext('2d', { willReadFrequently: true });
    const px = (x, y) => [...octx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    return {
      tl: px(2, 2), tr: px(397, 2), br: px(397, 297), bl: px(2, 297),
      size: { w: out.width, h: out.height },
    };
  });
  expect(res.size).toEqual({ w: 400, h: 300 });
  // TL rot, TR grün, BR blau, BL gelb
  expect(res.tl[0]).toBeGreaterThan(200); expect(res.tl[1]).toBeLessThan(80);
  expect(res.tr[1]).toBeGreaterThan(200); expect(res.tr[0]).toBeLessThan(80);
  expect(res.br[2]).toBeGreaterThan(200); expect(res.br[0]).toBeLessThan(80);
  expect(res.bl[0]).toBeGreaterThan(200); expect(res.bl[1]).toBeGreaterThan(200); expect(res.bl[2]).toBeLessThan(80);
});

test('Scanner-UI: Bildimport, Ecken, Lupe, A4, Drehen, PDF & Kompression', async ({ page }) => {
  await ready(page);
  const jpeg = await photoJpegBuffer(page);

  // Scanner öffnen -> Aufnahme-Ansicht
  await page.click('#scanBtn');
  await expect(page.locator('#scannerRoot .sc-overlay')).toBeVisible();
  await expect(page.locator('#scCaptureView')).toBeVisible();

  // Bild „aus Dateien“ importieren -> Zuschnitt-Ansicht mit Auto-Erkennung
  await page.setInputFiles('#scFileInput', {
    name: 'foto.jpg', mimeType: 'image/jpeg', buffer: jpeg,
  });
  await expect(page.locator('#scCropView')).toBeVisible();
  const auto = await page.evaluate(() => window.__pdfscanner.state.editing.corners);
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(auto[i].x - PHOTO_CORNERS[i][0])).toBeLessThan(0.05);
    expect(Math.abs(auto[i].y - PHOTO_CORNERS[i][1])).toBeLessThan(0.05);
  }

  // Ecke ziehen: Lupe erscheint, Ecke bewegt sich, Lupe verschwindet wieder
  const handle = page.locator('#scCropSvg g.sc-handle-corner').first();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator('#scLoupe')).toBeVisible();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 25, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#scLoupe')).toBeHidden();
  const dragged = await page.evaluate(() => window.__pdfscanner.state.editing.corners[0]);
  expect(dragged.x).toBeGreaterThan(auto[0].x + 0.01);
  // Auto-Erkennung stellt die Ecke wieder her
  await page.click('#scAutoBtn');
  const restored = await page.evaluate(() => window.__pdfscanner.state.editing.corners[0]);
  expect(Math.abs(restored.x - auto[0].x)).toBeLessThan(0.01);

  // Drehen: Quelle wird 90° gedreht (Maße tauschen)
  const before = await page.evaluate(() => {
    const s = window.__pdfscanner.state.editing.src;
    return { w: s.width, h: s.height };
  });
  await page.click('#scRotateBtn');
  const after = await page.evaluate(() => {
    const s = window.__pdfscanner.state.editing.src;
    return { w: s.width, h: s.height };
  });
  expect(after).toEqual({ w: before.h, h: before.w });
  await page.click('#scRotateBtn'); // zurückdrehen
  await page.click('#scRotateBtn');
  await page.click('#scRotateBtn'); // wieder Original-Ausrichtung

  // A4 hoch wählen (Strecken-Checkbox erscheint nur bei A4) und übernehmen
  await expect(page.locator('#scStretchWrap')).toBeHidden();
  await page.click('.sc-seg-btn[data-format="a4p"]');
  await expect(page.locator('#scStretchWrap')).toBeVisible();
  await page.click('#scCropOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();
  await expect(page.locator('.sc-pagecell')).toHaveCount(1);

  // Radierer: weißer Strich mit Undo/Redo
  await page.locator('.sc-pagecell button[title^="Radieren"]').click();
  await expect(page.locator('#scEraseView')).toBeVisible();
  const ebox = await page.locator('#scEraseCanvas').boundingBox();
  await page.mouse.move(ebox.x + ebox.width * 0.3, ebox.y + ebox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(ebox.x + ebox.width * 0.7, ebox.y + ebox.height * 0.5, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.__pdfscanner.state.pages[0].erase.length)).toBe(1);
  await page.click('#scEraseUndoBtn');
  expect(await page.evaluate(() => window.__pdfscanner.state.pages[0].erase.length)).toBe(0);
  await page.click('#scEraseRedoBtn');
  expect(await page.evaluate(() => window.__pdfscanner.state.pages[0].erase.length)).toBe(1);
  await page.click('#scEraseOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();

  // Zweite Seite aus Bild hinzufügen, dann wieder löschen (Reorder-Buttons prüfen)
  await page.click('#scAddFileBtn');
  await page.setInputFiles('#scFileInput', {
    name: 'foto2.jpg', mimeType: 'image/jpeg', buffer: jpeg,
  });
  await expect(page.locator('#scCropView')).toBeVisible();
  await page.click('#scCropOkBtn');
  await expect(page.locator('.sc-pagecell')).toHaveCount(2);
  await page.locator('.sc-pagecell').nth(1).locator('button[title="Seite löschen"]').click();
  await expect(page.locator('.sc-pagecell')).toHaveCount(1);

  // PDF erstellen -> landet in der Dateiliste, Hinweis auf Kompression/Scan-Stil
  await page.click('#scDoneBtn');
  await expect(page.locator('#scannerRoot')).toHaveCount(0);
  await expect(page.locator('.file-item')).toHaveCount(1);
  await expect(page.locator('.file-item .file-name')).toContainText(/^Scan_/);
  await expect(page.locator('#scanHint')).toBeVisible();

  // Das Scan-PDF ist gültig und hat eine echte A4-Seite
  const pdfInfo = await page.evaluate(async () => {
    const item = window.__pdfpresser.items[0];
    const bytes = await window.__pdfpresser.itemBytes(item);
    const doc = await window.PDFLib.PDFDocument.load(bytes);
    const { width, height } = doc.getPage(0).getSize();
    return { pages: doc.getPageCount(), width, height };
  });
  expect(pdfInfo.pages).toBe(1);
  expect(Math.abs(pdfInfo.width - 595.28)).toBeLessThan(1);
  expect(Math.abs(pdfInfo.height - 841.89)).toBeLessThan(1);

  // Danach normal komprimieren („Scan-Stil“ S/W) – Ergebnis ist ein gültiges PDF
  await page.check('input[name="preset"][value="extrem-sw"]');
  await page.click('#startBtn');
  await expect(page.locator('.file-item .file-status')).toContainText('Fertig', { timeout: 120000 });
  const outOk = await page.evaluate(() => {
    const item = window.__pdfpresser.items[0];
    if (!item.result) return { ok: false };
    const head = String.fromCharCode(...item.result.slice(0, 5));
    return { ok: head === '%PDF-', size: item.result.length };
  });
  expect(outOk.ok).toBe(true);
  expect(outOk.size).toBeGreaterThan(500);
});

test('applyErase übermalt Bereiche weiß', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async () => {
    const mod = await import('./js/scanner.js');
    const c = document.createElement('canvas');
    c.width = 200; c.height = 100;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 200, 100);
    mod.applyErase(c, [{ size: 0.1, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }]);
    return {
      mid: [...ctx.getImageData(100, 50, 1, 1).data],
      corner: [...ctx.getImageData(3, 3, 1, 1).data],
    };
  });
  expect(res.mid[0]).toBeGreaterThan(250);
  expect(res.corner[0]).toBeLessThan(10);
});

test('A4-Layout passt unverzerrt ein – Strecken nur optional', async ({ page }) => {
  await ready(page);
  // „Dokument“ in Blau, damit weiße A4-Ränder messbar sind (Quermaß ~1,5:1)
  const jpeg = await photoJpegBuffer(page, 1200, 900, '#9cc4ee');

  // Standard: A4 hoch ohne Strecken -> oben/unten weiße Ränder, Mitte blau
  await page.click('#scanBtn');
  await page.setInputFiles('#scFileInput', { name: 'blau.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.locator('#scCropView')).toBeVisible();
  await page.click('.sc-seg-btn[data-format="a4p"]');
  await page.click('#scCropOkBtn');
  await page.click('#scDoneBtn');
  await expect(page.locator('#scannerRoot')).toHaveCount(0);
  const fit = await bluePageBands(page);
  expect(Math.abs(fit.aspect - 210 / 297)).toBeLessThan(0.02); // A4-Seite
  expect(fit.top).toBeLessThan(0.02);   // Rand bleibt weiß -> nicht verzerrt
  expect(fit.mid).toBeGreaterThan(0.5); // Scan liegt mittig

  // Mit „auf A4 strecken“: Scan füllt das Blatt (oben blau)
  await page.click('#clearBtn');
  await page.click('#scanBtn');
  await page.setInputFiles('#scFileInput', { name: 'blau2.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.locator('#scCropView')).toBeVisible();
  await page.click('.sc-seg-btn[data-format="a4p"]');
  await page.check('#scStretch');
  await page.click('#scCropOkBtn');
  await page.click('#scDoneBtn');
  await expect(page.locator('#scannerRoot')).toHaveCount(0);
  const stretched = await bluePageBands(page);
  expect(stretched.top).toBeGreaterThan(0.5);
  expect(stretched.mid).toBeGreaterThan(0.5);
});

test('Scanner-UI: Aufnahme mit (Fake-)Kamera', async ({ page }) => {
  await ready(page);
  await page.click('#scanBtn');
  await expect(page.locator('#scCaptureView')).toBeVisible();

  // Fake-Kamera liefert ein Testvideo -> Auslöser aktiv
  await page.waitForFunction(() => {
    const v = document.querySelector('#scVideo');
    return v && v.videoWidth > 0;
  });
  await page.click('#scShutterBtn');
  await expect(page.locator('#scCropView')).toBeVisible();

  // Aufnahme hat die Videoauflösung, Ecken sind gesetzt (auto oder Fallback)
  const info = await page.evaluate(() => {
    const ed = window.__pdfscanner.state.editing;
    return { w: ed.src.width, h: ed.src.height, corners: ed.corners.length };
  });
  expect(info.w).toBeGreaterThan(100);
  expect(info.corners).toBe(4);

  // Verwerfen -> zurück zur Kamera, Schließen räumt auf (Kamera gestoppt)
  await page.click('#scCropCancelBtn');
  await expect(page.locator('#scCaptureView')).toBeVisible();
  await page.click('#scCloseBtn');
  await expect(page.locator('#scannerRoot')).toHaveCount(0);
  const cameraStopped = await page.evaluate(() => window.__pdfscanner.state.stream === null);
  expect(cameraStopped).toBe(true);
});
