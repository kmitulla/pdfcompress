// Scan-Studio & Netzwerk-Scanner: Eckenerkennung, Perspektive, fester
// A4-Ausschnitt auf der Glasfläche, Stapel-Scan, Zuschnitt- und Radierer-UI.
import { test, expect, devices } from '@playwright/test';
import {
  ready, MAKE_PHOTO, PHOTO_CORNERS, photoJpeg, bedScanJpeg, RENDER_HELPER, assertNoRawMarkup,
  mockScanner, mockState, clearScanJobs,
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

test('Netzwerk-Stapel-Scan: läuft als Server-Auftrag, Seiten exakt A4, Graustufen-Wunsch erreicht das Gerät', async ({ page }) => {
  test.setTimeout(180000);
  await clearScanJobs();
  await ready(page, { scanDelay: 0 });
  await mockScanner({ image: await bedScanJpeg(page, { dpi: 300 }), dpi: 300 });
  await page.click('#docsToolbar [data-add="scanner"]');
  await expect(page.locator('#scanSheet')).toHaveClass(/open/);
  await expect(page.locator('#scanSheetState')).toContainText('bereit');
  // Auflösungen kommen vom Gerät (Test-Scanner: 100/200/300/600)
  await expect(page.locator('#scanDpiSeg button')).toHaveText(['100', '200', '300', '600']);
  await expect(page.locator('#scanBgHint')).toContainText('App währenddessen schließen');
  await page.click('#scanSheet [data-step="1"]');            // 2 Seiten
  await expect(page.locator('#scanPages')).toHaveValue('2');
  await page.click('#scanDpiSeg button[data-v="300"]');
  await page.click('#scanColorSeg button[data-v="gray"]');
  await page.fill('#scanDelay', '0');
  await page.dispatchEvent('#scanDelay', 'change');
  await page.click('#scanStartBtn');
  await expect(page.locator('#scannerRoot .sc-overlay')).toBeVisible();
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(2, { timeout: 60000 });
  const st = await mockState();
  expect(st.posts.map((p) => [p.dpi, p.color, p.format])).toEqual([[300, 'Grayscale8', 'image/jpeg'], [300, 'Grayscale8', 'image/jpeg']]);
  await expect(page.locator('.sc-pagelabel').first()).toContainText('Glasfläche');
  // Der Auftrag liegt bis zum Fertigstellen sicher auf dem Server
  expect((await (await fetch('http://127.0.0.1:8823/api/scan-jobs')).json()).jobs.length).toBe(1);

  await page.click('#scDoneBtn');
  await expect(page.locator('.doc')).toHaveCount(1);
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].pages === 2);
  // … und wird danach weggeräumt
  await expect.poll(async () => (await (await fetch('http://127.0.0.1:8823/api/scan-jobs')).json()).jobs.length).toBe(0);
  const info = await page.evaluate(async ({ renderSrc }) => {
    eval(renderSrc);
    return inspectPdf(window.__pdfpresser.state.docs[0].bytes, 0.5);
  }, { renderSrc: RENDER_HELPER });
  expect(info.sizes).toEqual([[595, 842], [595, 842]]);
  // Rechter Rand: das weiße Blatt, nicht der graue Überstand der Glasfläche
  expect(info.rightLum).toBeGreaterThan(235);
  expect(info.leftLum).toBeGreaterThan(235);
});

test('Scan läuft ohne App weiter: neu laden, Hinweis „Scan wartet“, Seiten übernehmen, stoppen', async ({ page }) => {
  test.setTimeout(120000);
  await clearScanJobs();
  await ready(page, { scanPages: 4, scanDelay: 30, scanDpi: '200' });
  await mockScanner({ image: await bedScanJpeg(page, { dpi: 200 }), dpi: 200 });
  await page.click('#docsToolbar [data-add="scanner"]');
  await expect(page.locator('#scanStartBtn')).toContainText('4 Seiten');
  await page.click('#scanStartBtn');
  await expect(page.locator('#scPageCount')).toContainText('nächste in', { timeout: 30000 });

  // App „schließen“: neu laden – der Auftrag läuft auf dem Server weiter
  await page.reload();
  await page.waitForFunction(() => window.__pdfpresser);
  await page.evaluate(() => window.__pdfpresser.booted);
  await expect(page.locator('#jobBanner .job-card')).toHaveCount(1);
  await expect(page.locator('#jobBanner')).toContainText('1 Seite');
  await expect(page.locator('#jobBanner')).toContainText('läuft gerade');
  await page.click('#jobBanner [data-job-act="open"]');
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1, { timeout: 20000 });
  await expect(page.locator('#scPageCount')).toContainText('nächste in');
  await page.click('#scBatchStopBtn');
  await expect(page.locator('.toast')).toContainText('Gestoppt', { timeout: 10000 });
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1);
  await page.click('#scDoneBtn');
  await expect(page.locator('.doc')).toHaveCount(1);
  await expect.poll(async () => (await (await fetch('http://127.0.0.1:8823/api/scan-jobs')).json()).jobs.length).toBe(0);
});

test('Gerät meldet „belegt“ (409) wegen hängendem Auftrag: wird abgeräumt, Scan klappt trotzdem', async ({ page }) => {
  await clearScanJobs();
  await ready(page, { scanDpi: '200', scanColor: 'bw' });
  await mockScanner({ image: await bedScanJpeg(page, { dpi: 200 }), dpi: 200, config: { hangingJob: true } });
  const file = await page.evaluate(async () => {
    const f = await window.__pdfpresser.fetchScannedPage();
    return { name: f.name, dpi: f.scanDpi, size: f.size };
  });
  expect(file.dpi).toBe(200);
  expect(file.name).toMatch(/_200dpi\.jpg$/);
  const st = await mockState();
  // S/W wird als Graustufen-JPEG gescannt (1-Bit-JPEG lehnt das Gerät ab)
  expect(st.posts.at(-1)).toMatchObject({ dpi: 200, color: 'Grayscale8' });
  expect(st.jobs).not.toContain('stale');
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
  await clearScanJobs();
  await ready(page, { scanDelay: 0 });
  await mockScanner({ image: await bedScanJpeg(page, { dpi: 300 }), dpi: 300 });
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

  // Seitenverhältnis sperren: Ecke ziehen ändert Breite und Höhe gemeinsam (A4)
  await page.click('.sc-lock-btn[data-lock="a4"]');
  const h = page.locator('.sc-handle-corner circle:nth-child(2)').nth(2);
  const hb = await h.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 60, hb.y - 15, { steps: 6 });
  await page.mouse.up();
  const ratio = await page.evaluate(() => {
    const ed = window.__pdfscanner.state.editing;
    const xs = ed.corners.map((p) => p.x); const ys = ed.corners.map((p) => p.y);
    return ((Math.max(...xs) - Math.min(...xs)) * ed.src.width) / ((Math.max(...ys) - Math.min(...ys)) * ed.src.height);
  });
  expect(ratio).toBeCloseTo(210 / 297, 2);
  await page.click('.sc-lock-btn[data-lock="free"]');
  await page.click('#scCropCancelBtn');
  await page.click('#scCloseBtn');
  await page.click('.dlg .btn-danger');
  await expect.poll(async () => (await (await fetch('http://127.0.0.1:8823/api/scan-jobs')).json()).jobs.length).toBe(0);
  await page.evaluate(() => window.__pdfpresser.resetSettings());
});

test('A4-Bereich einrichten: Testscan, Höhe ändert Breite mit, Ergebnis gilt für Scans', async ({ page }) => {
  await clearScanJobs();
  await ready(page);
  // Blatt liegt 3 mm von links und 2 mm von oben
  await mockScanner({ image: await bedScanJpeg(page, { dpi: 200, offX: 3, offY: 2 }), dpi: 200 });
  await page.click('.nav-item[data-view="settings"]');
  await expect(page.locator('#scannerCard')).toBeVisible();
  await expect(page.locator('#scannerState')).toContainText('100/200/300/600');
  await page.click('#calibOpenBtn');
  await expect(page.locator('#calib')).toBeVisible();
  await page.click('#calibScanBtn');
  await expect(page.locator('#calibLoupes')).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => window.__calib.st.bed.w)).toBeCloseTo(215.9, 0);
  // Erst die Höhe (Breite folgt), dann die Lage
  await page.fill('#calibH', '294');
  await page.dispatchEvent('#calibH', 'change');
  await page.fill('#calibX', '3');
  await page.dispatchEvent('#calibX', 'change');
  await page.fill('#calibY', '2');
  await page.dispatchEvent('#calibY', 'change');
  // Seitenverhältnis gesperrt: Breite folgt
  await expect(page.locator('#calibW')).toHaveValue(String(Math.round((294 * 210 / 297) * 10) / 10));
  await page.click('#calibNudge [data-nudge="1,0"]');
  expect(await page.evaluate(() => window.__calib.st.rect.x)).toBeCloseTo(3.5, 5);
  await page.click('#calibSave');
  await expect(page.locator('#calib')).toBeHidden();
  const rect = await page.evaluate(() => window.__pdfpresser.settings.scanRect);
  expect(rect).toMatchObject({ x: 3.5, y: 2 });
  expect(rect.w).toBeCloseTo(207.9, 1);
  await expect(page.locator('#a4AreaInfo')).toContainText('Eingerichtet');
  // Der Ausschnitt eines Scans folgt dem eingerichteten Bereich
  const c = await page.evaluate(async () => {
    const { a4CornersForScan } = await import('./js/scanner.js');
    const cv = document.createElement('canvas');
    cv.width = 1700; cv.height = 2339; cv.scanDpi = 200;
    return a4CornersForScan(cv, { rect: { x: 3.5, y: 2, w: 207.9 } });
  });
  expect(c[0].x).toBeCloseTo(3.5 / 215.9, 3);
  expect(c[2].y - c[0].y).toBeCloseTo((207.9 * 297 / 210) / 297.1, 2);
  await page.evaluate(() => window.__pdfpresser.resetSettings());
});
