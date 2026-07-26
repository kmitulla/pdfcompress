// A4-Ausschnitt bei Flachbett-Scans, Ein-Finger-Bedienung, Textgröße ohne
// Obergrenze und der weiße Radierer im PDF-Editor.
import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
}

test('A4-Ausschnitt trifft die echten Maße des ET-2720 (215,9 x 297 mm)', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async () => {
    const { a4CornersForScan } = await import('/js/scanner.js');
    const mk = (mmW, mmH, dpi) => {
      const c = document.createElement('canvas');
      c.width = 10; c.height = 10;                       // Anzeigegröße egal
      c.scanDpi = dpi;
      c.sourcePx = { w: Math.round(mmW / 25.4 * dpi), h: Math.round(mmH / 25.4 * dpi) };
      return c;
    };
    // Glasfläche des ET-2720: Letter-Breite x A4-Höhe
    const bed = mk(215.9, 297, 300);
    const corners = a4CornersForScan(bed);
    // Auflösungsunabhängig?
    const bed600 = a4CornersForScan(mk(215.9, 297, 600));
    // Genau A4 grosse Fläche -> nichts zuzuschneiden
    const exact = a4CornersForScan(mk(210, 297, 300));
    // Ohne Angaben (Kamerafoto) -> kein Automatik-Zuschnitt
    const plain = a4CornersForScan(document.createElement('canvas'));
    // Anlegen unten rechts
    const br = a4CornersForScan(bed, { originX: 'right', originY: 'bottom' });
    return { corners, bed600, exact, plain, br };
  });

  // Ecke oben links, Breite = 210/215,9 = 0,9727, Höhe voll
  expect(res.corners).not.toBeNull();
  expect(res.corners[0].x).toBeCloseTo(0, 5);
  expect(res.corners[0].y).toBeCloseTo(0, 5);
  expect(res.corners[1].x).toBeCloseTo(210 / 215.9, 3);
  expect(res.corners[2].y).toBeCloseTo(1, 3);

  // Gleiches Ergebnis bei anderer Auflösung
  expect(res.bed600[1].x).toBeCloseTo(res.corners[1].x, 3);

  // Exakt A4 bzw. unbekannte Maße: keine Automatik
  expect(res.exact).toBeNull();
  expect(res.plain).toBeNull();

  // Andere Anlegekante: Ausschnitt sitzt rechts unten
  expect(res.br[1].x).toBeCloseTo(1, 3);
  expect(res.br[0].x).toBeCloseTo(1 - 210 / 215.9, 3);
});

test('Netzwerk-Scan öffnet den Zuschnitt bereits auf A4 vorbereitet', async ({ page }) => {
  await ready(page);

  // Scan vom Flachbett nachstellen: Bild in Glasflächen-Proportion mit dpi-Angabe
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    // 215,9 x 297 mm bei 100 dpi (klein, damit der Test flott bleibt)
    c.width = Math.round(215.9 / 25.4 * 100);
    c.height = Math.round(297 / 25.4 * 100);
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#111';
    for (let i = 0; i < 8; i++) x.fillRect(40, 60 + i * 40, 500, 12);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });

  await page.evaluate(async (bytes) => {
    const { openScanner } = await import('/js/scanner.js');
    const file = new File([new Uint8Array(bytes)], 'scan.png', { type: 'image/png' });
    file.scanDpi = 100;                       // wie vom Server gemeldet
    openScanner(() => {}, { initialFiles: [file], netScan: async () => file });
  }, png);

  await expect(page.locator('#scCropView')).toBeVisible();

  // Ecken sitzen auf dem A4-Bereich oben links – nicht auf der ganzen Fläche
  const st = await page.evaluate(() => ({
    corners: window.__pdfscanner.state.editing.corners,
    format: window.__pdfscanner.state.editing.format,
    isBed: window.__pdfscanner.state.editing.isBedScan,
  }));
  expect(st.isBed).toBe(true);
  expect(st.format).toBe('a4p');
  expect(st.corners[0].x).toBeCloseTo(0, 3);
  expect(st.corners[1].x).toBeCloseTo(210 / 215.9, 2);

  // Die A4-Schaltflächen sind sichtbar (nur bei Flachbett-Scans)
  await expect(page.locator('#scA4BedBtn')).toBeVisible();
  await expect(page.locator('#scA4CornerBtn')).toBeVisible();

  // Ecke umschalten: Ausschnitt wandert nach rechts
  await page.click('#scA4CornerBtn');
  const moved = await page.evaluate(() => window.__pdfscanner.state.editing.corners[1].x);
  expect(moved).toBeCloseTo(1, 2);
});

test('Große Seitenvorschau lässt sich öffnen und führt zum Radierer', async ({ page }) => {
  await ready(page);
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 420;
    const x = c.getContext('2d');
    x.fillStyle = '#333'; x.fillRect(0, 0, 300, 420);
    x.fillStyle = '#f4f2ea'; x.fillRect(20, 30, 260, 360);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.click('#scanBtn');
  await page.setInputFiles('#scFileInput', { name: 's.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(page.locator('#scCropView')).toBeVisible();
  await page.click('#scCropOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();

  // Miniatur antippen -> große Vorschau
  await page.click('.sc-thumb');
  await expect(page.locator('#scPreview')).toBeVisible();
  await expect(page.locator('#scPreviewLabel')).toContainText('Seite 1');

  // Von der Vorschau direkt in den Radierer
  await page.click('#scPreviewErase');
  await expect(page.locator('#scEraseView')).toBeVisible();
  await expect(page.locator('#scPreview')).toBeHidden();
});

// Reproduziert den gemeldeten Fehler: Geht ein pointerup verloren (auf iOS
// kommt das vor), blieb der Finger als "Geist" in der Liste stehen – der
// nächste einzelne Finger galt dann als zweiter und löste den Pinch-Zoom aus.
test('Ein Finger zeichnet auch nach einem verlorenen pointerup – erst zwei Finger zoomen', async ({ page }) => {
  await ready(page);
  const bytes = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    return Array.from(await doc.save());
  });
  await page.setInputFiles('#fileInput', { name: 't.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.click('.btn-edit');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();
  await page.click('[data-tool="draw"]');

  const result = await page.evaluate(() => {
    const stage = document.querySelector('#edStage');
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const fire = (type, { id, x, y, primary = true }) => stage.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: id, pointerType: 'touch', isPrimary: primary,
      clientX: x, clientY: y,
    }));

    // 1. Geste: Finger geht runter – das passende pointerup geht "verloren".
    fire('pointerdown', { id: 1, x: cx, y: cy });
    fire('pointermove', { id: 1, x: cx + 10, y: cy + 10 });
    // (kein pointerup!)

    const zoomBefore = window.__pdfeditorState().zoom;

    // 2. Geste: ein einzelner Finger soll ganz normal zeichnen.
    fire('pointerdown', { id: 2, x: cx - 40, y: cy - 30 });
    fire('pointermove', { id: 2, x: cx, y: cy });
    fire('pointermove', { id: 2, x: cx + 40, y: cy + 30 });
    fire('pointerup', { id: 2, x: cx + 40, y: cy + 30 });

    const ed = window.__pdfeditorState();
    const oneFinger = {
      zoom: ed.zoom,
      inks: ed.state.pages[0].objects.filter((o) => o.type === 'ink').length,
    };

    // 3. Jetzt wirklich zwei Finger: das muss zoomen.
    fire('pointerdown', { id: 3, x: cx - 60, y: cy });
    fire('pointerdown', { id: 4, x: cx + 60, y: cy, primary: false });
    fire('pointermove', { id: 3, x: cx - 120, y: cy });
    fire('pointermove', { id: 4, x: cx + 120, y: cy, primary: false });
    const zoomTwo = window.__pdfeditorState().zoom;
    fire('pointerup', { id: 3, x: cx - 120, y: cy });
    fire('pointerup', { id: 4, x: cx + 120, y: cy, primary: false });

    return { zoomBefore, oneFinger, zoomTwo };
  });

  // Ein Finger: zeichnet, Zoom unverändert
  expect(result.oneFinger.zoom, 'ein Finger darf nicht zoomen').toBeCloseTo(result.zoomBefore, 5);
  expect(result.oneFinger.inks, 'ein Finger zeichnet einen Strich').toBeGreaterThan(0);
  // Zwei Finger: zoomt
  expect(result.zoomTwo, 'zwei Finger zoomen').toBeGreaterThan(result.zoomBefore);
});

test('Textgröße kennt keine Obergrenze und lässt sich eintippen', async ({ page }) => {
  await ready(page);
  const bytes = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    return Array.from(await doc.save());
  });
  await page.setInputFiles('#fileInput', { name: 't.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.click('.btn-edit');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();

  // Text setzen
  await page.click('[data-tool="text"]');
  const box = await page.locator('#edStage').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#edTextSizeNum')).toBeVisible();

  // Zahl weit über dem alten Limit (60) eintippen
  await page.fill('#edTextSizeNum', '240');
  await page.dispatchEvent('#edTextSizeNum', 'input');
  let size = await page.evaluate(() => window.__pdfeditorState().state.pages[0].objects.find((o) => o.type === 'text').size);
  expect(size).toBe(240);

  // Schritt-Tasten arbeiten mit wachsender Schrittweite
  await page.click('#edTextSizeUp');
  size = await page.evaluate(() => window.__pdfeditorState().state.pages[0].objects.find((o) => o.type === 'text').size);
  expect(size).toBeGreaterThan(240);
});

test('Weißer Radierer übermalt im Editor und bleibt im PDF erhalten', async ({ page }) => {
  await ready(page);
  // Seite mit schwarzem Balken, den wir weiß übermalen
  const bytes = await page.evaluate(async () => {
    const { PDFDocument, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const p = doc.addPage([300, 300]);
    p.drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: rgb(1, 1, 1) });
    p.drawRectangle({ x: 40, y: 130, width: 220, height: 40, color: rgb(0, 0, 0) });
    return Array.from(await doc.save());
  });
  await page.setInputFiles('#fileInput', { name: 'balken.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.click('.btn-edit');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();

  await page.click('[data-tool="whiteout"]');
  await expect(page.locator('#edWhiteWidthNum')).toBeVisible();
  await page.fill('#edWhiteWidthNum', '40');
  await page.dispatchEvent('#edWhiteWidthNum', 'input');

  // Quer über den Balken ziehen
  const box = await page.locator('#edStage').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 8 });
  await page.mouse.up();

  const ink = await page.evaluate(() => {
    const o = window.__pdfeditorState().state.pages[0].objects.filter((x) => x.type === 'ink');
    return o.map((x) => ({ color: x.color, width: x.width, opacity: x.opacity }));
  });
  expect(ink.length).toBe(1);
  expect(ink[0].color).toBe('#ffffff');
  expect(ink[0].width).toBe(40);
  expect(ink[0].opacity).toBe(1);

  // Übernehmen -> weiße Übermalung steckt im PDF
  await page.click('#edApply');
  await expect(page.locator('.file-status')).toContainText('Bearbeitet', { timeout: 30000 });
  const whiter = await page.evaluate(async () => {
    const item = window.__pdfpresser.items[0];
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    const doc = await pdfjs.getDocument({ data: item.editedBytes.slice() }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    // Mitte des ehemals schwarzen Balkens prüfen
    const d = ctx.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data;
    await doc.destroy();
    return d[0];
  });
  expect(whiter, 'Balkenmitte ist jetzt weiß übermalt').toBeGreaterThan(200);
});
