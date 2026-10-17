// Scan-Studio & Netzwerk-Scanner: Eckenerkennung, Perspektive, fester
// A4-Ausschnitt auf der Glasfläche, Stapel-Scan, Zuschnitt- und Radierer-UI.
import { test, expect, devices } from '@playwright/test';
import {
  ready, MAKE_PHOTO, PHOTO_CORNERS, photoJpeg, bedScanJpeg, fakeConfig, RENDER_HELPER, assertNoRawMarkup,
} from './helpers.js';

test.describe.configure({ mode: 'serial' });

test('Eckenerkennung findet das Dokument im Foto', async ({ page }) => {
  await ready(page);
  const { detected, expected } = await page.evaluate(async ({ makePhoto, corners }) => {
    eval(makePhoto);
    const mod = await import('./js/scanner.js');
    return {
      detected: mod.detectCornersOnCanvas(makePhotoCanvas(1000, 750, corners)),
      expected: corners.map(([x, y]) => ({ x, y })),
    };
  }, { makePhoto: MAKE_PHOTO, corners: PHOTO_CORNERS });
  expect(detected).not.toBeNull();
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(detected[i].x - expected[i].x)).toBeLessThan(0.04);
    expect(Math.abs(detected[i].y - expected[i].y)).toBeLessThan(0.04);
  }
});

test('Perspektivkorrektur bildet die Ecken korrekt ab, Radierer übermalt weiß', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async () => {
    const mod = await import('./js/scanner.js');
    const src = document.createElement('canvas');
    src.width = 800; src.height = 600;
    const ctx = src.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 800, 600);
    const quad = [
      { x: 0.2, y: 0.15, col: '#ff0000' }, { x: 0.85, y: 0.2, col: '#00ff00' },
      { x: 0.9, y: 0.85, col: '#0000ff' }, { x: 0.15, y: 0.8, col: '#ffff00' },
    ];
    for (const q of quad) {
      ctx.fillStyle = q.col;
      ctx.beginPath(); ctx.arc(q.x * 799, q.y * 599, 25, 0, Math.PI * 2); ctx.fill();
    }
    const out = mod.warpPerspective(src, quad.map((q) => ({ x: q.x, y: q.y })), 400, 300);
    const o = out.getContext('2d', { willReadFrequently: true });
    const px = (x, y) => [...o.getImageData(x, y, 1, 1).data.slice(0, 3)];
    const black = document.createElement('canvas');
    black.width = 200; black.height = 100;
    const b = black.getContext('2d', { willReadFrequently: true });
    b.fillStyle = '#000'; b.fillRect(0, 0, 200, 100);
    mod.applyErase(black, [{ size: 0.1, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }]);
    return {
      tl: px(2, 2), tr: px(397, 2), br: px(397, 297), bl: px(2, 297),
      erasedMid: b.getImageData(100, 50, 1, 1).data[0], erasedCorner: b.getImageData(3, 3, 1, 1).data[0],
    };
  });
  expect(res.tl[0]).toBeGreaterThan(200); expect(res.tl[1]).toBeLessThan(80);
  expect(res.tr[1]).toBeGreaterThan(200); expect(res.tr[0]).toBeLessThan(80);
  expect(res.br[2]).toBeGreaterThan(200); expect(res.br[0]).toBeLessThan(80);
  expect(res.bl[0]).toBeGreaterThan(200); expect(res.bl[2]).toBeLessThan(80);
  expect(res.erasedMid).toBeGreaterThan(250);
  expect(res.erasedCorner).toBeLessThan(10);
});

test('Fester A4-Ausschnitt: exakt 210 × 297 mm ab der Anlegeecke, mit Feinjustage', async ({ page }) => {
  await ready(page);
  const r = await page.evaluate(async () => {
    const { a4CornersForScan, plausibleBedScan } = await import('./js/scanner.js');
    // ET-2720 bei 300 dpi: 2550 × 3508 px = 215,9 × 297 mm
    const c = { width: 2550, height: 3508, scanDpi: 300 };
    const mm = (q) => ({
      x0: q[0].x * 215.9, x1: q[1].x * 215.9, y0: q[0].y * 297.01, y1: q[2].y * 297.01,
    });
    // Herunterskaliertes Bild mit Originalmaßen (Studio liest große Scans verkleinert ein)
    const small = { width: 1275, height: 1754, scanDpi: 300, sourcePx: { w: 2550, h: 3508 } };
    return {
      tl: mm(a4CornersForScan(c, { corner: 'tl' })),
      tr: mm(a4CornersForScan(c, { corner: 'tr' })),
      off: mm(a4CornersForScan(c, { corner: 'tl', offX: 2, offY: -3 })),
      small: mm(a4CornersForScan(small, { corner: 'tl' })),
      // 600 dpi liefert dieselbe Lage
      hi: mm(a4CornersForScan({ width: 5100, height: 7016, scanDpi: 600 }, { corner: 'tl' })),
      // Scanner liefert schon A4 -> ganzes Bild
      exact: a4CornersForScan({ width: 2480, height: 3508, scanDpi: 300 }, {}),
      noDpi: a4CornersForScan({ width: 2550, height: 3508 }, {}),
      bed: plausibleBedScan(2550, 3508, 300),
      phone: plausibleBedScan(4032, 3024, 72),
    };
  });
  const near = (a, b, tol = 0.15) => expect(Math.abs(a - b)).toBeLessThan(tol);
  near(r.tl.x0, 0); near(r.tl.x1, 210); near(r.tl.y0, 0); near(r.tl.y1, 297);
  near(r.tr.x0, 5.9); near(r.tr.x1, 215.9);
  near(r.off.x0, 2); near(r.off.x1, 212); near(r.off.y0, 0); // nach oben begrenzt
  near(r.small.x1, 210); near(r.hi.x1, 210);
  expect(r.exact[1].x).toBeCloseTo(1, 2);
  expect(r.exact[2].y).toBeCloseTo(1, 2);
  expect(r.noDpi).toBeNull();
  expect(r.bed).toBe(true);
  expect(r.phone).toBe(false);
});

test('Scannerauflösung aus dem JPEG-Kopf erkennt Flachbett-Dateien (Sammelordner)', async ({ page }) => {
  await ready(page);
  const r = await page.evaluate(async () => {
    const { readJpegDpi } = await import('./js/pdfkit.js');
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
    const b = new Uint8Array(await blob.arrayBuffer());
    const before = readJpegDpi(b);
    // JFIF-Dichte auf 300 dpi setzen, wie es Scanner tun
    b[13] = 1; b[14] = 1; b[15] = 44; b[16] = 1; b[17] = 44;
    return { before, after: readJpegDpi(b), png: readJpegDpi(new Uint8Array([137, 80, 78, 71])) };
  });
  expect(r.before).toBeNull();
  expect(r.after).toBe(300);
  expect(r.png).toBeNull();
});

test('Netzwerk-Stapel-Scan: Seiten exakt A4, Überstand der Glasfläche abgeschnitten', async ({ page }) => {
  test.setTimeout(180000);
  await fakeConfig(page);
  await ready(page, { scanDelay: 0 });
  const jpeg = await bedScanJpeg(page);
  const calls = [];
  await page.route('**/api/scanner/scan*', async (route) => {
    calls.push(route.request().url());
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'image/jpeg', 'X-Scan-Dpi': '300' }, body: jpeg });
  });
  await page.click('#docsToolbar [data-add="scanner"]');
  await expect(page.locator('#scanSheet')).toHaveClass(/open/);
  await expect(page.locator('#scanSheetState')).toContainText('bereit');
  await page.click('#scanSheet [data-step="1"]');            // 2 Seiten
  await expect(page.locator('#scanPages')).toHaveValue('2');
  await page.click('#scanDpiSeg button[data-v="300"]');
  await page.click('#scanColorSeg button[data-v="gray"]');
  await page.fill('#scanDelay', '0');
  await page.dispatchEvent('#scanDelay', 'change');
  await page.click('#scanStartBtn');
  await expect(page.locator('#scannerRoot .sc-overlay')).toBeVisible();
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(2, { timeout: 60000 });
  expect(calls.length).toBe(2);
  expect(calls[0]).toContain('dpi=300');
  expect(calls[0]).toContain('color=gray');
  await expect(page.locator('.sc-pagelabel').first()).toContainText('Glasfläche');

  await page.click('#scDoneBtn');
  await expect(page.locator('.doc')).toHaveCount(1);
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].pages === 2);
  const info = await page.evaluate(async ({ renderSrc }) => {
    eval(renderSrc);
    return inspectPdf(window.__pdfpresser.state.docs[0].bytes, 0.5);
  }, { renderSrc: RENDER_HELPER });
  expect(info.sizes).toEqual([[595, 842], [595, 842]]);
  // Rechter Rand: das weiße Blatt, nicht der graue Überstand der Glasfläche
  expect(info.rightLum).toBeGreaterThan(235);
  expect(info.leftLum).toBeGreaterThan(235);
});

test('Stapel-Scan lässt sich stoppen und hält das Gerät wach', async ({ page }) => {
  await fakeConfig(page);
  await page.addInitScript(() => {
    window.__wake = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: async () => { window.__wake++; return { release() {}, addEventListener() {} }; } },
    });
  });
  await ready(page, { scanPages: 5, scanDelay: 30 });
  const jpeg = await bedScanJpeg(page, { w: 1275, h: 1754 });
  await page.route('**/api/scanner/scan*', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'image/jpeg', 'X-Scan-Dpi': '150' }, body: jpeg }));
  await page.click('#docsToolbar [data-add="scanner"]');
  await expect(page.locator('#scanStartBtn')).toContainText('5 Seiten');
  await page.click('#scanStartBtn');
  await expect(page.locator('#scPageCount')).toContainText('nächste in', { timeout: 30000 });
  expect(await page.evaluate(() => window.__wake)).toBeGreaterThan(0);
  await page.click('#scBatchStopBtn');
  await expect(page.locator('.toast')).toContainText('Gestoppt', { timeout: 10000 });
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1);
});

test('Studio: Zuschnitt mit Lupe am Handy, Format, Drehen, Radierer mit Zoom', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await ready(page);
  const jpeg = await photoJpeg(page, 1200, 900);
  await page.evaluate(async (arr) => {
    const f = new File([new Uint8Array(arr)], 'foto.jpg', { type: 'image/jpeg' });
    await window.__pdfpresser.openStudio({ files: [f] });
  }, Array.from(jpeg));
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1, { timeout: 20000 });
  await assertNoRawMarkup(expect, page, '#scannerRoot');

  // Zuschnitt öffnen: alle Ecken liegen im sichtbaren Bereich und sind ziehbar
  await page.click('.sc-pagecell button[title="Zuschnitt & Format"]');
  await expect(page.locator('#scCropView')).toBeVisible();
  const vp = page.viewportSize();
  const handles = page.locator('.sc-handle-corner circle:nth-child(2)');
  await expect(handles).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    const b = await handles.nth(i).boundingBox();
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  }
  const before = await page.evaluate(() => window.__pdfscanner.state.editing.corners[0]);
  const hb = await handles.nth(0).boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 30, hb.y + 40, { steps: 5 });
  await expect(page.locator('#scLoupe')).toBeVisible();
  await page.mouse.up();
  const after = await page.evaluate(() => window.__pdfscanner.state.editing.corners[0]);
  expect(after.x).not.toBeCloseTo(before.x, 3);

  await page.click('.sc-seg-btn[data-format="a4l"]');
  await page.click('#scRotateBtn');
  expect(await page.evaluate(() => window.__pdfscanner.state.editing.format)).toBe('a4p');
  await page.click('#scCropOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();
  expect(await page.evaluate(() => window.__pdfscanner.state.pages[0].rot)).toBe(90);

  // Radierer: zoomen und malen
  await page.click('.sc-pagecell button[title^="Radieren"]');
  await expect(page.locator('#scEraseView')).toBeVisible();
  await page.click('#scEraseZoomIn');
  await expect(page.locator('#scEraseZoomLabel')).toHaveText('160 %');
  const cb = await page.locator('#scEraseCanvas').boundingBox();
  await page.mouse.move(cb.x + cb.width * 0.3, cb.y + cb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.6, cb.y + cb.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.click('#scEraseOkBtn');
  expect(await page.evaluate(() => window.__pdfscanner.state.pages[0].erase.length)).toBe(1);

  // Große Vorschau
  await page.click('.sc-thumb');
  await expect(page.locator('#scPreview')).toBeVisible();
  await expect(page.locator('#scPreviewStage canvas')).toHaveCount(1);
  await page.click('#scPreviewClose');
  await ctx.close();
});

test('Studio: A4-Werkzeuge nur für Flachbett-Scans, Anlegeecke wird gemerkt', async ({ page }) => {
  await fakeConfig(page);
  await ready(page, { scanDelay: 0 });
  const jpeg = await bedScanJpeg(page);
  await page.route('**/api/scanner/scan*', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'image/jpeg', 'X-Scan-Dpi': '300' }, body: jpeg }));
  await page.click('#docsToolbar [data-add="scanner"]');
  await page.click('#scanStartBtn');
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1, { timeout: 30000 });
  await page.click('.sc-pagecell button[title="Zuschnitt & Format"]');
  await expect(page.locator('#scA4BedBtn')).toBeVisible();
  await page.click('#scA4CornerBtn');
  await expect(page.locator('#scCornerLabel')).toContainText('oben rechts');
  const x0 = await page.evaluate(() => window.__pdfscanner.state.editing.corners[0].x);
  expect(x0).toBeGreaterThan(0.02);
  expect(await page.evaluate(() => window.__pdfpresser.settings.scanCorner)).toBe('tr');
  await page.click('#scCropCancelBtn');
  await page.evaluate(() => window.__pdfpresser.resetSettings());
});
