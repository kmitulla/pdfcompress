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
function makePhotoCanvas(w, h, corners) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a3f47';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 250; i++) {
    ctx.fillStyle = 'rgba(0,0,0,' + (0.05 + (i % 10) / 50) + ')';
    ctx.fillRect((i * 131) % w, (i * 197) % h, 9, 9);
  }
  ctx.fillStyle = '#f4f0e8';
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

async function photoJpegBuffer(page, w = 1200, h = 900) {
  const dataUrl = await page.evaluate(
    ({ makePhoto, w, h, corners }) => {
      // eslint-disable-next-line no-eval
      eval(makePhoto);
      return makePhotoCanvas(w, h, corners).toDataURL('image/jpeg', 0.92);
    },
    { makePhoto: MAKE_PHOTO, w, h, corners: PHOTO_CORNERS },
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
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

  // A4 hoch wählen und übernehmen -> Seitenübersicht
  await page.click('.sc-seg-btn[data-format="a4p"]');
  await page.click('#scCropOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();
  await expect(page.locator('.sc-pagecell')).toHaveCount(1);

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
