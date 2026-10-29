// Tests für den PDF-Editor: Einbrennen aller Objekttypen, Seitenverwaltung,
// Zuschnitt, Rotation, Signatur-Verarbeitung, Formulare, Daten-Export und
// vor allem: Bearbeitung + anschließende Kompression erfasst alles.
import { test, expect } from '@playwright/test';
import { ready as appReady, assertNoRawMarkup } from './helpers.js';

test.describe.configure({ mode: 'serial' });

async function ready(page) {
  await appReady(page);
  await page.waitForFunction(() => window.__pdfeditor);
}

/** PDF als Dokument anlegen und über den Inspektor den Editor öffnen. */
async function openEditorWith(page, make) {
  await page.evaluate(async (makeSrc) => {
    // eslint-disable-next-line no-eval
    const bytes = await (eval(makeSrc))();
    await window.__pdfpresser.addPdfDoc(new Uint8Array(bytes), 'edit.pdf', { kind: 'pdf' });
  }, make);
  await page.click('#inspector [data-act="edit"]');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();
  await page.waitForFunction(() => /^1\//.test(document.querySelector('#edPageInfo')?.textContent || ''));
}

const twoPages = (n) => `(async () => {
  const { PDFDocument, rgb } = window.PDFLib;
  const doc = await PDFDocument.create();
  for (let i = 0; i < ${n}; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawRectangle({ x: 60, y: 700 - i * 40, width: 300, height: 20, color: rgb(0.1, 0.1, 0.1) });
  }
  return doc.save();
})`;

const edited = (page) => page.evaluate(() => Array.from(window.__pdfpresser.state.docs[0].bytes));

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

test('Stempel, Schwärzen, Seitenzahlen, Seiten drehen', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ inspect }) => {
    eval(inspect);
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595.28, 841.89]);
    p1.drawText('GEHEIMNIS', { x: 100, y: 500, size: 20, font, color: rgb(0, 0, 0) });
    doc.addPage([595.28, 841.89]);
    const src = await doc.save();
    const state = {
      pages: [
        { src: 0, objects: [
          { type: 'rect', color: '#000000', x: 90, y: 320, w: 160, h: 40 },
          { type: 'stamp', x: 300, y: 100, w: 190, h: 60, color: '#c00000', title: 'BEZAHLT', date: '18.07.2026', note: 'per Überweisung' },
        ] },
        { src: 1, rotate: 90, objects: [] },
      ],
      pageNumbers: true,
      assets: { bytes: {}, kind: {}, url: {} },
    };
    const out = await window.__pdfeditor.applyEdits(src, state);
    const black = await inspectRegion(out, 1, 0.17, 0.39, 0.2, 0.04); // Schwärzung
    const p2 = await inspectRegion(out, 2, 0.4, 0.4, 0.2, 0.2);
    return { text: black.text, blackFrac: black.frac, p2w: p2.w, p2h: p2.h };
  }, { inspect: INSPECT });
  expect(res.blackFrac).toBeGreaterThan(0.85); // Balken deckt vollflächig
  expect(res.text).toContain('BEZAHLT');
  expect(res.text).toContain('18.07.2026');
  expect(res.text).toContain('per Überweisung');
  expect(res.text).toContain('1 / 2'); // Seitenzahlen
  expect(res.p2w).toBeGreaterThan(res.p2h); // Seite 2 gedreht (quer)
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



test('UI: Bearbeiten -> Text & Unterschrift -> Kompression erfasst alles', async ({ page }) => {
  test.setTimeout(240000);
  await ready(page);
  await openEditorWith(page, `(async () => {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText('Vertrag – bitte unterschreiben', { x: 60, y: 760, size: 22, font, color: rgb(0, 0, 0) });
    return doc.save();
  })`);

  await page.locator('[data-tool="text"]').click();
  const sb = await page.locator('#edStage').boundingBox();
  await page.mouse.click(sb.x + sb.width * 0.35, sb.y + sb.height * 0.3);
  await expect(page.locator('#edTextInput')).toBeVisible();
  await page.locator('#edTextInput').fill('Gelesen und akzeptiert');

  await page.locator('[data-tool="sign"]').click();
  await page.click('.ed-tab[data-tab="drawTab"]');
  await expect(page.locator('#sigPad')).toBeVisible();
  const pad = await page.locator('#sigPad').boundingBox();
  await page.mouse.move(pad.x + pad.width * 0.2, pad.y + pad.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(pad.x + pad.width * (0.2 + i * 0.06), pad.y + pad.height * (0.6 + Math.sin(i) * 0.15));
  await page.mouse.up();
  await page.locator('#sigUseDrawn').click();
  await page.waitForFunction(() => document.querySelector('#edModal').classList.contains('hidden'));
  await expect(page.locator('.toast')).toContainText('Unterschrift');   // Hinweis statt alert()
  await page.mouse.click(sb.x + sb.width * 0.5, sb.y + sb.height * 0.7);
  await page.waitForTimeout(150);

  await page.locator('#edApply').click();
  await expect(page.locator('.doc .doc-status')).toContainText('Bearbeitet', { timeout: 30000 });
  await expect(page.locator('.doc .doc-tags')).toContainText('bearbeitet');

  // Verlustfrei: Text bleibt durchsuchbar
  await page.click('.profile:has(input[value="verlustfrei"])');
  await page.click('#inspector .insp-foot [data-act="compress"]');
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].status === 'done', null, { timeout: 60000 });
  const lossless = await page.evaluate(async () => {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: window.__pdfpresser.state.docs[0].result.slice() }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    await doc.destroy();
    return tc.items.map((i) => i.str).join(' ');
  });
  expect(lossless).toContain('Gelesen und akzeptiert');

  // Scan S/W: Unterschrift steckt im Raster
  await page.click('.profile:has(input[value="extrem-sw"])');
  await page.locator('#inspOcr').evaluate((el) => { if (el.checked) el.click(); });
  await page.click('#inspector .insp-foot [data-act="compress"]');
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].status === 'done', null, { timeout: 120000 });
  const sw = await page.evaluate(async ({ inspect }) => {
    eval(inspect);
    // Die Unterschrift landet in der Mitte des sichtbaren Ausschnitts
    return inspectRegion(window.__pdfpresser.state.docs[0].result, 1, 0.25, 0.4, 0.5, 0.25);
  }, { inspect: INSPECT });
  expect(sw.numPages).toBe(1);
  expect(sw.frac).toBeGreaterThan(0.002);

  // Export/Import-Roundtrip der Unterschriften
  const roundtrip = await page.evaluate(async () => {
    const json = await (await window.__pdfpresser.exportAllData()).text();
    const count = JSON.parse(json).signatures.length;
    await window.__pdfpresser.importAllData(json);
    const again = JSON.parse(await (await window.__pdfpresser.exportAllData()).text()).signatures.length;
    return { count, again };
  });
  expect(roundtrip.count).toBeGreaterThanOrEqual(1);
  expect(roundtrip.again).toBe(roundtrip.count);
});

/** Ein echtes Bild als Datei für die Eingabefelder */
async function imageBuffer(page, color = '#3366aa') {
  const bytes = await page.evaluate(async (c) => {
    const cv = document.createElement('canvas');
    cv.width = 600; cv.height = 800;
    const x = cv.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 800);
    x.fillStyle = c; x.fillRect(80, 120, 440, 560);
    const b = await new Promise((r) => cv.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, color);
  return Buffer.from(bytes);
}

test('Seitenverwaltung: Fotos/Kamera anfügen, umsortieren, löschen, alles auf A4', async ({ page }) => {
  await ready(page);
  await openEditorWith(page, twoPages(3));
  await page.click('#edPagesBtn');
  await expect.poll(() => page.locator('.ed-pagecell').count()).toBe(3);
  await assertNoRawMarkup(expect, page, '#edModal');
  expect(await page.locator('#edPageCamInput').getAttribute('capture')).toBe('environment');

  await page.setInputFiles('#edPagePhotoInput', [
    { name: 'a.png', mimeType: 'image/png', buffer: await imageBuffer(page, '#3366aa') },
  ]);
  await expect.poll(() => page.locator('.ed-pagecell').count(), { timeout: 20000 }).toBe(4);
  await expect(page.locator('.ed-pagecell').nth(3)).toContainText('(Bild)');

  // Erste Seite nach hinten, danach die (neue) erste löschen
  await page.locator('.ed-pagecell').nth(0).locator('.btn[aria-label="Nach hinten schieben"]').click();
  await page.locator('.ed-pagecell').nth(0).locator('.btn[aria-label="Seite löschen"]').click();
  await expect.poll(() => page.locator('.ed-pagecell').count()).toBe(3);
  await page.click('#edAllA4');
  await page.click('#edPagesClose');
  await page.click('#edApply');
  await expect(page.locator('.doc .doc-status')).toContainText('Bearbeitet', { timeout: 40000 });
  const sizes = await page.evaluate(async () => {
    const doc = await window.PDFLib.PDFDocument.load(window.__pdfpresser.state.docs[0].bytes.slice());
    return doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  });
  expect(sizes).toEqual([[595, 842], [595, 842], [595, 842]]);
  expect(await page.evaluate(() => window.__pdfpresser.state.docs[0].pages)).toBe(3);
});

test('Editor: Textgröße kennt keine Obergrenze', async ({ page }) => {
  await ready(page);
  await openEditorWith(page, twoPages(1));
  await page.click('[data-tool="text"]');
  const box = await page.locator('#edStage').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#edTextSizeNum')).toBeVisible();
  await page.fill('#edTextSizeNum', '240');
  await page.dispatchEvent('#edTextSizeNum', 'input');
  const size = () => page.evaluate(() => window.__pdfeditorState().state.pages[0].objects.find((o) => o.type === 'text').size);
  expect(await size()).toBe(240);
  await page.click('#edTextSizeUp');
  expect(await size()).toBeGreaterThan(240);
  await page.click('#edCancel');
});

test('Editor: weißer Radierer übermalt und bleibt im PDF erhalten', async ({ page }) => {
  await ready(page);
  await openEditorWith(page, `(async () => {
    const { PDFDocument, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const p = doc.addPage([300, 300]);
    p.drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: rgb(1, 1, 1) });
    p.drawRectangle({ x: 40, y: 130, width: 220, height: 40, color: rgb(0, 0, 0) });
    return doc.save();
  })`);
  await page.click('[data-tool="whiteout"]');
  await expect(page.locator('#edWhiteWidthNum')).toBeVisible();
  await page.fill('#edWhiteWidthNum', '40');
  await page.dispatchEvent('#edWhiteWidthNum', 'input');
  const box = await page.locator('#edStage').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 8 });
  await page.mouse.up();
  const ink = await page.evaluate(() => window.__pdfeditorState().state.pages[0].objects.filter((x) => x.type === 'ink').map((x) => x.color));
  expect(ink).toEqual(['#ffffff']);
  await page.click('#edApply');
  await expect(page.locator('.doc .doc-status')).toContainText('Bearbeitet', { timeout: 30000 });
  const mid = await page.evaluate(async () => {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: window.__pdfpresser.state.docs[0].bytes.slice() }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data;
    await doc.destroy();
    return d[0];
  });
  expect(mid, 'Balkenmitte ist weiß übermalt').toBeGreaterThan(200);
});

test('Unterschrift aus transparentem PNG bleibt transparent (kein schwarzer Hintergrund)', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(() => {
    // Freigestelltes PNG: durchsichtiger Hintergrund (RGBA 0,0,0,0), blaue Striche
    const c = document.createElement('canvas');
    c.width = 400; c.height = 160;
    const x = c.getContext('2d');
    x.strokeStyle = '#1b2a80'; x.lineWidth = 8; x.lineCap = 'round';
    x.beginPath(); x.moveTo(40, 120); x.bezierCurveTo(120, 10, 220, 150, 360, 40); x.stroke();
    const ed = window.__pdfeditor;
    const transparent = ed.hasTransparency(c);
    const out = ed.processSignatureImage(c, { threshold: 50, color: 'original' });
    const d = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
    let opaque = 0, darkOpaque = 0, clear = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200) { opaque++; if (d[i + 2] < 60) darkOpaque++; }
      if (d[i + 3] === 0) clear++;
    }
    // Gleiches Bild, aber Umfärben auf Schwarz: Alpha bleibt, Farbe ändert sich
    const black = ed.processSignatureImage(c, { color: '#111111' });
    const bd = black.getContext('2d').getImageData(0, 0, black.width, black.height).data;
    let blackInk = 0;
    for (let i = 0; i < bd.length; i += 4) if (bd[i + 3] > 200 && bd[i] < 30 && bd[i + 2] < 30) blackInk++;
    return { transparent, total: d.length / 4, opaque, darkOpaque, clear, blackInk, corner: d[3] };
  });
  expect(res.transparent).toBe(true);
  expect(res.corner).toBe(0);                        // Ecke bleibt durchsichtig
  expect(res.clear / res.total).toBeGreaterThan(0.5); // überwiegend durchsichtig – nicht schwarz
  expect(res.darkOpaque).toBe(0);                    // Original-Blau, keine schwarzen Flächen
  expect(res.opaque).toBeGreaterThan(500);
  expect(res.blackInk).toBeGreaterThan(500);
});

test('UI: transparentes PNG als Unterschrift einfügen, Stempel mit Name einsetzen', async ({ page }) => {
  await ready(page);
  await openEditorWith(page, twoPages(1));
  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 500; c.height = 180;
    const x = c.getContext('2d');
    x.strokeStyle = '#0a1f7a'; x.lineWidth = 9; x.lineCap = 'round';
    x.beginPath(); x.moveTo(40, 130); x.bezierCurveTo(140, 10, 260, 170, 460, 50); x.stroke();
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.click('[data-tool="sign"]');
  await page.click('.ed-tab[data-tab="photoTab"]');
  await page.setInputFiles('#edSigPhotoInput', { name: 'unterschrift.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#sigPhotoInfo')).toContainText('Transparentes PNG');
  await expect(page.locator('#sigPhotoCtrls')).toBeHidden();
  await page.uncheck('#sigPhotoSave');
  await page.click('#sigUsePhoto');
  await expect(page.locator('#edModal')).toBeHidden();
  const sig = await page.evaluate(() => {
    const st = window.__pdfeditorState();
    const o = st.state.pages[0].objects.find((x) => x.type === 'sig-image');
    return { has: !!o, sel: st.selected, w: o?.w };
  });
  expect(sig.has).toBe(true);
  expect(sig.sel).toBe(0);                     // gleich ausgewählt, in der Mitte
  await expect(page.locator('#edProps')).toContainText('Unterschrift');

  // Stempel: Vorlage wählen, Name ergänzen, einfügen
  await page.click('[data-tool="stamp"]');
  await page.click('.ed-chip[data-title="ERLEDIGT"]');
  await page.fill('#stDBrand', 'Muster GmbH');
  await page.dispatchEvent('#stDBrand', 'input');
  await expect(page.locator('#edStampPreview')).toContainText('ERLEDIGT');
  await page.click('#edStampInsert');
  await expect(page.locator('#edProps')).toContainText('Stempel');
  await expect(page.locator('#edStTitle')).toHaveValue('ERLEDIGT');
  // Rückgängig entfernt den Stempel, Wiederholen bringt ihn zurück
  await page.click('#edUndoBtn');
  expect(await page.evaluate(() => window.__pdfeditorState().state.pages[0].objects.length)).toBe(1);
  await page.click('#edRedoBtn');
  expect(await page.evaluate(() => window.__pdfeditorState().state.pages[0].objects.length)).toBe(2);

  await page.click('#edApply');
  await expect(page.locator('.doc .doc-status')).toContainText('Bearbeitet', { timeout: 30000 });
  const out = await page.evaluate(async ({ inspect }) => {
    eval(inspect);
    return inspectRegion(window.__pdfpresser.state.docs[0].bytes, 1, 0.3, 0.3, 0.4, 0.4);
  }, { inspect: INSPECT });
  expect(out.text).toContain('ERLEDIGT');
  expect(out.text).toContain('Muster GmbH');
  expect(out.blueFrac).toBeGreaterThan(0.002);   // Unterschrift in Blau, kein schwarzer Kasten
});
