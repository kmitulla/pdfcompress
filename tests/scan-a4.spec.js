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

// Der gemeldete Fall: Das Blatt endet sichtbar vor dem Rand der Scanfläche –
// unten nur als feine Schattenlinie (im echten Scan gemessen: 249 statt 255).
test('Blatterkennung findet die Kante auch als feine Schattenlinie', async ({ page }) => {
  await ready(page);
  const r = await page.evaluate(async () => {
    const { detectSheetOnBed, sheetEdgeFromProfile } = await import('/js/scanner.js');

    // a) Profil wie im echten Scan: Papier 255, bei Index 12 eine flache Senke
    // Profil wie im echten Scan gemessen: Papier 255, dicht am Rand eine
    // flache, schmale Senke (die Schattenlinie an der Blattkante).
    const prof = new Array(300).fill(255);
    prof[4] = 252; prof[5] = 249; prof[6] = 253;
    const linie = sheetEdgeFromProfile(prof);

    // b) Vollbild: Blatt endet unten bei 90 %, rechts bei 95 % (dort dunkler)
    const c = document.createElement('canvas');
    c.width = 600; c.height = 850;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 600, 850);
    x.fillStyle = '#8d8d8d'; x.fillRect(570, 0, 30, 850);      // freie Glasfläche rechts
    x.fillStyle = '#f2f2f2'; x.fillRect(0, 766, 570, 84);      // Deckel unten, fast weiß
    x.fillStyle = '#e2e2e2'; x.fillRect(0, 763, 570, 3);       // Schattenlinie an der Blattkante
    x.fillStyle = '#333';
    for (let i = 0; i < 8; i++) x.fillRect(60, 80 + i * 70, 420, 12);
    // Gegenprobe: breite dunkle Zeile weiter innen (Text) ist keine Kante
    const t = new Array(300).fill(255);
    for (let i = 20; i < 32; i++) t[i] = 60;
    const textZeile = sheetEdgeFromProfile(t);

    const sheet = detectSheetOnBed(c);
    return { linie, textZeile, sheet };
  });

  // Die Senke markiert die Kante – dahinter beginnt das Papier
  expect(r.linie).toBeGreaterThan(4);
  expect(r.linie).toBeLessThan(10);
  // Eine breite Textzeile weiter innen darf NICHT als Kante gelten
  expect(r.textZeile).toBe(0);

  // Blatt korrekt eingegrenzt
  expect(r.sheet).not.toBeNull();
  expect(r.sheet.x0).toBeCloseTo(0, 1);
  expect(r.sheet.y0).toBeCloseTo(0, 1);
  expect(r.sheet.x1, 'rechte Kante bei 95 %').toBeCloseTo(570 / 600, 1);
  expect(r.sheet.y1, 'untere Kante bei 90 %').toBeCloseTo(766 / 850, 1);
});

test('Erkanntes Blatt wird exakt als A4 ausgegeben (kein weißer Rand)', async ({ page }) => {
  await ready(page);
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 850; c.height = 1200;
    const x = c.getContext('2d');
    x.fillStyle = '#8d8d8d'; x.fillRect(0, 0, 850, 1200);   // Scanfläche
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 827, 1170);   // Blatt oben links
    x.fillStyle = '#333';
    for (let i = 0; i < 10; i++) x.fillRect(90, 120 + i * 95, 600, 16);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.evaluate(async (bytes) => {
    const { openScanner } = await import('/js/scanner.js');
    const f = new File([new Uint8Array(bytes)], 'scan.png', { type: 'image/png' });
    f.scanDpi = 100;
    openScanner((pdf) => { window.__scanResult = pdf; }, { initialFiles: [f], netScan: async () => f });
  }, png);
  await expect(page.locator('#scCropView')).toBeVisible();

  // Auswahl sitzt auf dem Blatt, Format A4 hoch, gestreckt
  const st = await page.evaluate(() => window.__pdfscanner.state.editing);
  expect(st.format).toBe('a4p');
  expect(st.stretch).toBe(true);
  expect(st.corners[1].x, 'rechte Kante am Blatt').toBeCloseTo(827 / 850, 1);
  expect(st.corners[2].y, 'untere Kante am Blatt').toBeCloseTo(1170 / 1200, 1);

  // Ergebnis: exakt A4, und der Inhalt füllt es ohne weißen Rand
  await page.click('#scCropOkBtn');
  await page.click('#scDoneBtn');
  await page.waitForFunction(() => !!window.__scanResult, null, { timeout: 30000 });
  const res = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.load(await window.__scanResult.arrayBuffer());
    const { width, height } = doc.getPage(0).getSize();
    return { width, height };
  });
  expect(res.width).toBeCloseTo(595.28, 0);
  expect(res.height).toBeCloseTo(841.89, 0);
});

test('Kantenverfeinerung korrigiert die Rechnung anhand der Glasfläche', async ({ page }) => {
  await ready(page);
  const r = await page.evaluate(async () => {
    const { a4CornersForScan } = await import('/js/scanner.js');
    const dpi = 100;
    // Glasfläche 215,9 x 297 mm; Papier liegt aber 4 mm weiter rechts als
    // angenommen -> reine Rechnung läge daneben.
    const bedW = Math.round(215.9 / 25.4 * dpi);
    const bedH = Math.round(297 / 25.4 * dpi);
    const paperW = Math.round(210 / 25.4 * dpi);
    const mk = (paperRight) => {
      const c = document.createElement('canvas');
      c.width = bedW; c.height = bedH;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#6a6a6a'; x.fillRect(0, 0, bedW, bedH);   // unbedecktes Glas
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, paperRight, bedH); // Papier
      c.scanDpi = dpi; c.sourcePx = { w: bedW, h: bedH };
      return c;
    };
    const shifted = Math.round(paperW + 4 / 25.4 * dpi);        // 4 mm breiter
    return {
      exakt: a4CornersForScan(mk(paperW))[1].x,
      verschoben: a4CornersForScan(mk(shifted))[1].x,
      ohneVerfeinerung: a4CornersForScan(mk(shifted), { detect: false })[1].x,
      erwartetVerschoben: shifted / bedW,
      rechnerisch: 210 / 215.9,
    };
  });
  // Liegt das Papier wie angenommen, ändert die Verfeinerung praktisch nichts
  expect(r.exakt).toBeCloseTo(r.rechnerisch, 2);
  // Liegt es anders, folgt der Ausschnitt der echten Kante statt der Rechnung
  expect(r.verschoben).toBeCloseTo(r.erwartetVerschoben, 2);
  expect(Math.abs(r.verschoben - r.rechnerisch)).toBeGreaterThan(0.01);
  // Ohne Verfeinerung bliebe es beim rechnerischen Wert
  expect(r.ohneVerfeinerung).toBeCloseTo(r.rechnerisch, 3);
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

// Der gemeldete Fehler: Die Werkzeugleiste brach in mehrere Zeilen um und schob
// die Bühne aus dem Bild – die Eckpunkte lagen ausserhalb und liessen sich am
// Handy nicht anfassen.
test('Eckpunkte liegen im sichtbaren Bereich und lassen sich ziehen (Handy)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await ready(page);

  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 850; c.height = 1170;
    const x = c.getContext('2d');
    x.fillStyle = '#6a6a6a'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff'; x.fillRect(0, 0, 827, c.height);
    x.fillStyle = '#222';
    for (let i = 0; i < 10; i++) x.fillRect(80, 120 + i * 90, 600, 16);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.evaluate(async (bytes) => {
    const { openScanner } = await import('/js/scanner.js');
    const f = new File([new Uint8Array(bytes)], 'scan.png', { type: 'image/png' });
    f.scanDpi = 100;
    openScanner(() => {}, { initialFiles: [f], netScan: async () => f });
  }, png);
  await expect(page.locator('#scCropView')).toBeVisible();

  // Alle vier Eckanfasser müssen vollständig im Sichtbereich liegen
  const vp = page.viewportSize();
  const handles = page.locator('#scCropSvg g.sc-handle-corner');
  expect(await handles.count()).toBe(4);
  for (let i = 0; i < 4; i++) {
    const b = await handles.nth(i).boundingBox();
    expect(b, `Ecke ${i} hat keine Fläche`).not.toBeNull();
    expect(b.x, `Ecke ${i} links ausserhalb`).toBeGreaterThanOrEqual(-1);
    expect(b.y, `Ecke ${i} oben ausserhalb`).toBeGreaterThanOrEqual(-1);
    expect(b.x + b.width, `Ecke ${i} rechts ausserhalb`).toBeLessThanOrEqual(vp.width + 1);
    expect(b.y + b.height, `Ecke ${i} unten ausserhalb`).toBeLessThanOrEqual(vp.height + 1);
    // Trefferfläche muss fingerfreundlich gross sein
    expect(Math.min(b.width, b.height), `Ecke ${i} zu klein`).toBeGreaterThan(38);
  }

  // Und eine Ecke lässt sich tatsächlich ziehen
  const before = await page.evaluate(() => ({ ...window.__pdfscanner.state.editing.corners[0] }));
  const b0 = await handles.first().boundingBox();
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width / 2 + 45, b0.y + b0.height / 2 + 55, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => ({ ...window.__pdfscanner.state.editing.corners[0] }));
  expect(after.x, 'Ecke wurde nicht bewegt').toBeGreaterThan(before.x + 0.01);
  expect(after.y).toBeGreaterThan(before.y + 0.01);
  await ctx.close();
});

test('A4-Schaltflächen bleiben auch beim erneuten Öffnen einer Seite erhalten', async ({ page }) => {
  await ready(page);
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 850; c.height = 1170;
    const x = c.getContext('2d');
    x.fillStyle = '#6a6a6a'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff'; x.fillRect(0, 0, 827, c.height);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.evaluate(async (bytes) => {
    const { openScanner } = await import('/js/scanner.js');
    const f = new File([new Uint8Array(bytes)], 'scan.png', { type: 'image/png' });
    f.scanDpi = 100;
    openScanner(() => {}, { initialFiles: [f], netScan: async () => f });
  }, png);
  await expect(page.locator('#scA4BedBtn')).toBeVisible();

  // Übernehmen -> Seitenübersicht -> Zuschnitt derselben Seite erneut öffnen
  await page.click('#scCropOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();
  await page.click('.sc-pagecell-bar .btn >> nth=0');
  await expect(page.locator('#scCropView')).toBeVisible();
  await expect(page.locator('#scA4BedBtn'), 'A4-Schaltfläche darf nicht verschwinden').toBeVisible();
  await expect(page.locator('#scA4CornerBtn')).toBeVisible();
});

test('Auswahl und Ausgabeformat sind unabhängig: alles wählen, dann A4 quer + strecken', async ({ page }) => {
  await ready(page);
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 800;
    const x = c.getContext('2d');
    x.fillStyle = '#888'; x.fillRect(0, 0, 600, 800);
    x.fillStyle = '#fff'; x.fillRect(40, 60, 500, 680);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.click('#scanBtn');
  await page.setInputFiles('#scFileInput', { name: 's.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(page.locator('#scCropView')).toBeVisible();

  // „Alles“ wählt das komplette Bild
  await page.click('#scFullBtn');
  const full = await page.evaluate(() => window.__pdfscanner.state.editing.corners);
  expect(full[0].x).toBeCloseTo(0, 5);
  expect(full[0].y).toBeCloseTo(0, 5);
  expect(full[2].x).toBeCloseTo(1, 5);
  expect(full[2].y).toBeCloseTo(1, 5);

  // Format A4 quer wählen – die Auswahl bleibt dabei unverändert
  await page.click('.sc-seg-btn[data-format="a4l"]');
  const st = await page.evaluate(() => ({
    format: window.__pdfscanner.state.editing.format,
    corners: window.__pdfscanner.state.editing.corners,
  }));
  expect(st.format).toBe('a4l');
  expect(st.corners[2].x).toBeCloseTo(1, 5);

  // „strecken“ ist jetzt anwählbar und wirkt
  await expect(page.locator('#scStretchWrap')).toBeVisible();
  await page.check('#scStretch');
  expect(await page.evaluate(() => window.__pdfscanner.state.editing.stretch)).toBe(true);

  // Ergebnis ist A4 quer
  await page.click('#scCropOkBtn');
  await page.click('#scDoneBtn');
  await expect(page.locator('.file-item')).toBeVisible({ timeout: 30000 });
  const size = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.load(await window.__pdfpresser.items[0].file.arrayBuffer());
    const { width, height } = doc.getPage(0).getSize();
    return { width, height };
  });
  expect(size.width).toBeCloseTo(841.89, 0);
  expect(size.height).toBeCloseTo(595.28, 0);
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
test('Scan-Radierer: Zoom, feineres Radieren und höhere Auflösung', async ({ page }) => {
  await ready(page);
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 900; c.height = 1250;
    const x = c.getContext('2d');
    x.fillStyle = '#555'; x.fillRect(0, 0, 900, 1250);
    x.fillStyle = '#fff'; x.fillRect(0, 0, 880, 1230);
    x.fillStyle = '#111';
    for (let i = 0; i < 12; i++) x.fillRect(70, 100 + i * 90, 620, 14);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.click('#scanBtn');
  await page.setInputFiles('#scFileInput', { name: 's.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(page.locator('#scCropView')).toBeVisible();
  await page.click('#scCropOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();
  await page.click('.sc-pagecell-bar .btn >> nth=1');   // Radierer
  await expect(page.locator('#scEraseView')).toBeVisible();

  // Startzustand: eingepasst
  await expect(page.locator('#scEraseZoomLabel')).toHaveText('100 %');
  const before = await page.evaluate(() => {
    const c = document.querySelector('#scEraseCanvas');
    return { w: c.width, h: c.height, zoom: window.__pdfscanner.state.erasing.zoom };
  });

  // Hineinzoomen: Zeichenfläche zeigt einen Ausschnitt in höherer Auflösung
  await page.click('#scEraseZoomIn');
  await page.click('#scEraseZoomIn');
  const after = await page.evaluate(() => {
    const er = window.__pdfscanner.state.erasing;
    const c = document.querySelector('#scEraseCanvas');
    return {
      zoom: er.zoom,
      base: { w: er.base.width, h: er.base.height },
      cssW: parseFloat(c.style.width),
    };
  });
  expect(after.zoom).toBeGreaterThan(before.zoom * 2);
  // Die Arbeitskopie liegt in voller Scanauflösung vor und ist deutlich größer
  // als die Anzeige – nur dadurch zeigt Hineinzoomen echte Details statt Matsch.
  expect(after.base.w).toBeGreaterThan(850);
  expect(after.base.w).toBeGreaterThan(after.cssW);

  // Radieren im gezoomten Zustand trifft die richtige Stelle und ist feiner
  const stage = await page.locator('#scEraseCanvas').boundingBox();
  await page.mouse.move(stage.x + stage.width * 0.4, stage.y + stage.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.5, { steps: 6 });
  await page.mouse.up();
  const stroke = await page.evaluate(() => {
    const p = window.__pdfscanner.state.pages[0];
    return { n: p.erase.length, size: p.erase[0].size, pts: p.erase[0].points.length };
  });
  expect(stroke.n).toBe(1);
  expect(stroke.pts).toBeGreaterThan(2);
  // Der Strich liegt im mittleren Bereich der Seite, nicht am Rand
  const mid = await page.evaluate(() => {
    const p = window.__pdfscanner.state.pages[0].erase[0].points;
    return p[Math.floor(p.length / 2)];
  });
  expect(mid.x).toBeGreaterThan(0.1);
  expect(mid.x).toBeLessThan(0.9);
  expect(mid.y).toBeGreaterThan(0.1);
  expect(mid.y).toBeLessThan(0.9);

  // Zurück auf Einpassen
  await page.click('#scEraseZoomFit');
  await expect(page.locator('#scEraseZoomLabel')).toHaveText('100 %');
});

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
