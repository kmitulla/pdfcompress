// Tests für den PDF-Editor: Einbrennen aller Objekttypen, Seitenverwaltung,
// Zuschnitt, Rotation, Signatur-Verarbeitung, Formulare, Daten-Export und
// vor allem: Bearbeitung + anschließende Kompression erfasst alles.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.__pdfeditor && window.PDFLib);
}

// Rendert Seite n und liefert Text + Pixelstatistik einer Region
const INSPECT = `
async function inspectRegion(bytes, pageNo, rx, ry, rw, rh) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const sx = Math.round(rx * canvas.width), sy = Math.round(ry * canvas.height);
  const sw = Math.max(1, Math.round(rw * canvas.width)), sh = Math.max(1, Math.round(rh * canvas.height));
  const d = ctx.getImageData(sx, sy, sw, sh).data;
  let nonWhite = 0, red = 0, blue = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nonWhite++;
    if (d[i] > 140 && d[i+1] < 110 && d[i+2] < 110) red++;
    if (d[i+2] > 110 && d[i] < 110) blue++;
  }
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    text += tc.items.map((it) => it.str).join(' ') + ' ';
  }
  const info = { numPages: doc.numPages, w: viewport.width / 1.5, h: viewport.height / 1.5,
    frac: nonWhite / (d.length / 4), redFrac: red / (d.length / 4), blueFrac: blue / (d.length / 4), text };
  await doc.destroy();
  return info;
}
`;

test('applyEdits: Text, Stift, Vektor-Unterschrift, Bild, Seiten, Zuschnitt', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ inspect }) => {
    eval(inspect);
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      const p = doc.addPage([595.28, 841.89]);
      p.drawText(`Quellseite ${i + 1}`, { x: 60, y: 780, size: 24, font, color: rgb(0, 0, 0) });
    }
    const src = await doc.save();

    // rotes 4x4-PNG als Bild-Asset
    const c = document.createElement('canvas');
    c.width = 4; c.height = 4;
    const cx = c.getContext('2d');
    cx.fillStyle = '#e00000'; cx.fillRect(0, 0, 4, 4);
    const pngUrl = c.toDataURL('image/png');
    const pngBytes = Uint8Array.from(atob(pngUrl.split(',')[1]), (ch) => ch.charCodeAt(0));

    const state = {
      pages: [
        { // Seiten getauscht: zuerst Quellseite 2 mit Objekten
          src: 1,
          objects: [
            { type: 'text', x: 60, y: 400, size: 20, color: '#0000cc', font: 'helv', text: 'Signiert am 18.07.2026' },
            { type: 'ink', color: '#e00000', width: 3, paths: [[{ x: 100, y: 650 }, { x: 200, y: 630 }, { x: 300, y: 660 }, { x: 420, y: 640 }]] },
            { type: 'sig-vector', x: 320, y: 700, w: 150, h: 50, color: '#1b2a80', widthN: 0.03,
              strokes: [[{ x: 0, y: 0.8 }, { x: 0.3, y: 0.1 }, { x: 0.6, y: 0.9 }, { x: 1, y: 0.3 }]] },
            { type: 'image', assetId: 'img1', x: 480, y: 60, w: 60, h: 60 },
          ],
        },
        { src: 0, crop: { x: 100, y: 100, w: 300, h: 400 }, objects: [] },
        { src: null, blankSize: [595.28, 841.89], objects: [
          { type: 'text', x: 50, y: 60, size: 30, color: '#111111', font: 'times', text: 'Neue leere Seite' },
        ] },
      ],
      assets: { bytes: { img1: pngBytes }, kind: { img1: 'png' }, url: {} },
    };
    const out = await window.__pdfeditor.applyEdits(src, state);

    const p1 = await inspectRegion(out, 1, 0.75, 0.05, 0.18, 0.12); // Bild-Region oben rechts
    const inkR = await inspectRegion(out, 1, 0.15, 0.74, 0.55, 0.06); // Stift-Region
    const sigR = await inspectRegion(out, 1, 0.52, 0.82, 0.28, 0.08); // Unterschrift
    const p2 = await inspectRegion(out, 2, 0.4, 0.4, 0.2, 0.2);
    return {
      numPages: p1.numPages,
      text: p1.text,
      imgRed: p1.redFrac,
      inkNonWhite: inkR.frac,
      sigBlue: sigR.blueFrac,
      croppedW: p2.w,
      croppedH: p2.h,
    };
  }, { inspect: INSPECT });

  expect(res.numPages).toBe(3);
  expect(res.text).toContain('Quellseite 2'); // Reihenfolge getauscht
  expect(res.text).toContain('Signiert am 18.07.2026'); // Text eingebrannt & durchsuchbar
  expect(res.text).toContain('Neue leere Seite');
  expect(res.imgRed).toBeGreaterThan(0.1); // rotes Bild sichtbar
  expect(res.inkNonWhite).toBeGreaterThan(0.005); // Stift-Strich sichtbar
  expect(res.sigBlue).toBeGreaterThan(0.003); // Unterschrift (blau) sichtbar
  expect(Math.abs(res.croppedW - 300)).toBeLessThan(2); // Zuschnitt wirkt
  expect(Math.abs(res.croppedH - 400)).toBeLessThan(2);
});

test('applyEdits: gedrehte Seite (Rotate 90) erhält Objekte an Sichtposition', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ inspect }) => {
    eval(inspect);
    const { PDFDocument, degrees } = window.PDFLib;
    const doc = await PDFDocument.create();
    const p = doc.addPage([595.28, 841.89]);
    p.setRotation(degrees(90));
    const src = await doc.save();
    // Ansicht ist quer: 841.89 breit, 595.28 hoch; Strich mittig platzieren
    const state = {
      pages: [{ src: 0, objects: [
        { type: 'ink', color: '#e00000', width: 6, paths: [[{ x: 320, y: 290 }, { x: 520, y: 300 }]] },
        { type: 'text', x: 100, y: 100, size: 24, color: '#111111', font: 'helv', text: 'Quertext' },
      ] }],
      assets: { bytes: {}, kind: {}, url: {} },
    };
    const out = await window.__pdfeditor.applyEdits(src, state);
    const mid = await inspectRegion(out, 1, 0.35, 0.44, 0.3, 0.12);
    return { w: mid.w, h: mid.h, redFrac: mid.redFrac, text: mid.text };
  }, { inspect: INSPECT });

  expect(res.w).toBeGreaterThan(res.h); // Ansicht ist quer
  expect(res.redFrac).toBeGreaterThan(0.005); // Strich mittig sichtbar
  expect(res.text).toContain('Quertext');
});

test('Signatur: Foto-Freistellung und Strich-Glättung', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(() => {
    // "Foto": graues Papier mit dunklem Schriftzug und Schatten-Ecke
    const c = document.createElement('canvas');
    c.width = 400; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#cfc8bd'; x.fillRect(0, 0, 400, 200);
    x.fillStyle = '#b9b2a6'; x.fillRect(0, 0, 80, 200);
    x.strokeStyle = '#2a2620'; x.lineWidth = 6; x.lineCap = 'round';
    x.beginPath(); x.moveTo(60, 140); x.bezierCurveTo(120, 40, 200, 180, 340, 70); x.stroke();
    const processed = window.__pdfeditor.processSignatureImage(c, { threshold: 50, brightness: 0, contrast: 20, color: '#1b2a80' });
    const pc = processed.getContext('2d');
    const d = pc.getImageData(0, 0, processed.width, processed.height).data;
    let opaque = 0, blueish = 0, corner = d[3];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200) { opaque++; if (d[i + 2] > d[i]) blueish++; }
    }
    const path = window.__pdfeditor.strokeToSvgPath([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }, { x: 30, y: 8 }]);
    const norm = window.__pdfeditor.normalizeStrokes([[{ x: 10, y: 10 }, { x: 110, y: 60 }]]);
    return { w: processed.width, h: processed.height, opaque, blueRatio: blueish / Math.max(1, opaque), cornerAlpha: corner, path, aspect: norm.aspect };
  });

  expect(res.cornerAlpha).toBe(0); // Hintergrund transparent
  expect(res.opaque).toBeGreaterThan(300); // Schriftzug erhalten
  expect(res.blueRatio).toBeGreaterThan(0.9); // umgefärbt
  expect(res.w).toBeLessThan(400); // auf Inhalt beschnitten
  expect(res.path).toContain('C'); // Glättung: kubische Beziers
  expect(Math.abs(res.aspect - 2)).toBeLessThan(0.01);
});

test('Formular: Felder füllen und einbrennen', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ inspect }) => {
    eval(inspect);
    const { PDFDocument, StandardFonts } = window.PDFLib;
    const doc = await PDFDocument.create();
    const p = doc.addPage([595.28, 841.89]);
    const form = doc.getForm();
    const nameField = form.createTextField('name');
    nameField.addToPage(p, { x: 60, y: 700, width: 240, height: 22 });
    const check = form.createCheckBox('einverstanden');
    check.addToPage(p, { x: 60, y: 650, width: 16, height: 16 });
    await doc.embedFont(StandardFonts.Helvetica);
    const src = await doc.save();

    const out = await window.__pdfeditor.applyEdits(src, {
      pages: [{ src: 0, objects: [] }],
      formValues: { name: 'Katharina Musterfrau', einverstanden: true },
      flattenForm: true,
      assets: { bytes: {}, kind: {}, url: {} },
    });
    const info = await inspectRegion(out, 1, 0.1, 0.15, 0.5, 0.06);
    // Nach dem Flatten darf kein Formularfeld mehr existieren
    const check2 = await PDFDocument.load(out);
    let fieldsLeft = 0;
    try { fieldsLeft = check2.getForm().getFields().length; } catch { fieldsLeft = 0; }
    return { text: info.text, fieldsLeft };
  }, { inspect: INSPECT });

  expect(res.text).toContain('Katharina Musterfrau');
  expect(res.fieldsLeft).toBe(0);
});

test('UI: Bearbeiten -> Unterschrift zeichnen -> Kompression erfasst alles', async ({ page }) => {
  test.setTimeout(240000);
  page.on('dialog', (d) => d.accept());
  await ready(page);

  // Quelldatei laden
  await page.evaluate(async () => {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595.28, 841.89]);
    p.drawText('Vertrag – bitte unterschreiben', { x: 60, y: 760, size: 22, font, color: rgb(0, 0, 0) });
    const bytes = await doc.save();
    const file = new File([bytes], 'vertrag.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('.file-item')).toHaveCount(1);

  // Editor öffnen
  await page.locator('.btn-edit').click();
  await expect(page.locator('#edCanvas')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('#edPageInfo')?.textContent === '1/1');

  // Text-Werkzeug: Text platzieren und ändern
  await page.locator('[data-tool="text"]').click();
  const stage = page.locator('#edStage');
  const sb = await stage.boundingBox();
  await page.mouse.click(sb.x + sb.width * 0.35, sb.y + sb.height * 0.3);
  await expect(page.locator('#edTextInput')).toBeVisible();
  await page.locator('#edTextInput').fill('Gelesen und akzeptiert');

  // Unterschrift zeichnen und einfügen
  await page.locator('[data-tool="sign"]').click();
  await expect(page.locator('#sigPad')).toBeVisible();
  const pad = await page.locator('#sigPad').boundingBox();
  await page.mouse.move(pad.x + pad.width * 0.2, pad.y + pad.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(pad.x + pad.width * (0.2 + i * 0.06), pad.y + pad.height * (0.6 + Math.sin(i) * 0.15));
  }
  await page.mouse.up();
  await page.locator('#sigUseDrawn').click(); // speichert auch in der Bibliothek
  // Warten, bis das Modal zu ist und der Platzierungsmodus aktiv ist
  await page.waitForFunction(() => document.querySelector('#edModal').classList.contains('hidden'));
  await page.waitForTimeout(150);
  // Platzieren: unten mittig
  await page.mouse.click(sb.x + sb.width * 0.5, sb.y + sb.height * 0.7);
  await page.waitForTimeout(150);

  // Übernehmen
  await page.locator('#edApply').click();
  await expect(page.locator('.file-status')).toContainText('Bearbeitet', { timeout: 30000 });

  // Verlustfrei komprimieren -> Text muss durchsuchbar enthalten sein
  await page.locator('input[name="preset"][value="verlustfrei"]').check();
  await page.locator('#startBtn').click();
  await expect(page.locator('.file-status')).toContainText('Fertig', { timeout: 60000 });
  const lossless = await page.evaluate(async () => {
    const bytes = window.__pdfpresser.items[0].result;
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const text = tc.items.map((i) => i.str).join(' ');
    await doc.destroy();
    return text;
  });
  expect(lossless).toContain('Gelesen und akzeptiert');

  // Extrem S/W komprimieren -> Unterschrift muss im Raster sichtbar sein
  await page.locator('input[name="preset"][value="extrem-sw"]').check();
  await page.locator('#startBtn').click();
  await expect(page.locator('.file-status')).toContainText('Fertig', { timeout: 120000 });
  const swMarks = await page.evaluate(async ({ inspect }) => {
    eval(inspect);
    const bytes = window.__pdfpresser.items[0].result;
    const mid = await inspectRegion(bytes, 1, 0.15, 0.55, 0.7, 0.35);
    return { frac: mid.frac, pages: mid.numPages };
  }, { inspect: INSPECT });
  expect(swMarks.pages).toBe(1);
  expect(swMarks.frac).toBeGreaterThan(0.002); // Unterschrift im komprimierten PDF

  // Export/Import-Roundtrip: gespeicherte Unterschrift übersteht den Umzug
  const roundtrip = await page.evaluate(async () => {
    const blob = await window.__pdfpresser.exportAllData();
    const json = await blob.text();
    const parsed = JSON.parse(json);
    const count = parsed.signatures.length;
    await window.__pdfpresser.importAllData(json);
    const blob2 = await window.__pdfpresser.exportAllData();
    const parsed2 = JSON.parse(await blob2.text());
    return { count, countAfter: parsed2.signatures.length, sameName: parsed.signatures[0]?.name === parsed2.signatures[0]?.name };
  });
  expect(roundtrip.count).toBeGreaterThanOrEqual(1);
  expect(roundtrip.countAfter).toBe(roundtrip.count);
  expect(roundtrip.sameName).toBe(true);
});
