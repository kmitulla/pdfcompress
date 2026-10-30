// Bearbeiten-Werkzeug auf Herz und Nieren: jedes Werkzeug einzeln, mit Maus
// und am Handy (Touch), samt Prüfung des fertigen PDFs.
import { test, expect, devices } from '@playwright/test';
import { ready as appReady } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const ONE_PAGE = `(async () => {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText('VERTRAULICH ' + (i + 1), { x: 80, y: 600, size: 20, font, color: rgb(0, 0, 0) });
    p.drawText('Kontonummer 1234 5678', { x: 80, y: 560, size: 14, font, color: rgb(0, 0, 0) });
  }
  return doc.save();
})`;

async function open(page, make = ONE_PAGE) {
  await appReady(page);
  await page.waitForFunction(() => window.__pdfeditor || true);
  await page.evaluate(async (makeSrc) => {
    // eslint-disable-next-line no-eval
    const bytes = await (eval(makeSrc))();
    await window.__pdfpresser.addPdfDoc(new Uint8Array(bytes), 'werkzeuge.pdf', { kind: 'pdf' });
  }, make);
  // Am Handy ist der Inspektor ein Blatt – erst die Karte antippen
  if ((page.viewportSize()?.width || 1200) < 1180) {
    await page.click('.doc');
    await expect(page.locator('#inspector')).toHaveClass(/open/);
    await page.waitForTimeout(400);
  }
  await page.click('#inspector [data-act="edit"]');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();
  await page.waitForFunction(() => /^1\//.test(document.querySelector('#edPageInfo')?.textContent || ''));
  await page.waitForTimeout(200);
}

const st = (page) => page.evaluate(() => {
  const e = window.__pdfeditorState();
  return { tool: e.tool, selected: e.selected, page: e.pageIdx, objs: e.state.pages[e.pageIdx].objects, pages: e.state.pages.length, undo: e.undoStack.length };
});

/** Punkt auf der Seite (Anteile 0..1) → Bildschirmkoordinaten */
async function at(page, fx, fy) {
  const b = await page.locator('#edSvg').boundingBox();
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}
async function clickAt(page, fx, fy) {
  const p = await at(page, fx, fy);
  await page.mouse.click(p.x, p.y);
}
async function drag(page, from, to, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function applyAndRead(page) {
  await page.click('#edApply');
  await expect(page.locator('#editorRoot')).toBeHidden({ timeout: 30000 });
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].edited);
  return page.evaluate(async () => {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const bytes = window.__pdfpresser.state.docs[0].bytes;
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const tc = await p.getTextContent();
      const vp = p.getViewport({ scale: 1 });
      pages.push({ w: vp.width, h: vp.height, items: tc.items.map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5] })), text: tc.items.map((i) => i.str).join(' ') });
    }
    await doc.destroy();
    return pages;
  });
}

async function pixel(page, pageNo, fx, fy) {
  return page.evaluate(async ({ pageNo, fx, fy }) => {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: window.__pdfpresser.state.docs[0].bytes.slice() }).promise;
    const p = await doc.getPage(pageNo);
    const vp = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data;
    await doc.destroy();
    return [d[0], d[1], d[2]];
  }, { pageNo, fx, fy });
}

// ------------------------------------------------------------------ Text

test('Text: ein Tipp = ein Text, danach Auswahl; Tippen daneben legt keinen neuen an', async ({ page }) => {
  await open(page);
  await page.click('[data-tool="text"]');
  await clickAt(page, 0.3, 0.2);
  let s = await st(page);
  expect(s.objs.filter((o) => o.type === 'text')).toHaveLength(1);
  expect(s.tool).toBe('select');                       // Werkzeug springt zurück
  await expect(page.locator('#edTextInput')).toBeFocused();
  await page.keyboard.type('Hallo Welt');               // ersetzt den markierten Platzhalter
  s = await st(page);
  expect(s.objs[0].text).toBe('Hallo Welt');

  // Mehrmals daneben tippen: Auswahl weg, aber KEIN neuer Text
  await clickAt(page, 0.7, 0.7);
  await clickAt(page, 0.6, 0.5);
  await clickAt(page, 0.2, 0.8);
  s = await st(page);
  expect(s.objs).toHaveLength(1);
  expect(s.selected).toBeNull();

  // Text antippen = auswählen, nochmal antippen = bearbeiten
  const t = s.objs[0];
  const tx = (t.x + 10) / 595.28;
  const ty = (t.y + t.size * 0.5) / 841.89;
  await clickAt(page, tx, ty);
  expect((await st(page)).selected).toBe(0);
  await clickAt(page, tx, ty);
  await expect(page.locator('#edTextInput')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect((await st(page)).objs[0].text).toBe('Hallo Welt!');

  // Größe, Schrift, Farbe
  await page.fill('#edTextSizeNum', '30');
  await page.dispatchEvent('#edTextSizeNum', 'input');
  await page.click('#edTextSizeUp');
  await page.selectOption('#edTextFont', 'helvB');
  await page.click('[data-swatches="edTextColor"] .ed-swatch[data-color="#c00000"]');
  s = await st(page);
  expect(s.objs[0]).toMatchObject({ size: 32, font: 'helvB', color: '#c00000' });

  // Verschieben per Ziehen
  const before = { x: s.objs[0].x, y: s.objs[0].y };
  const from = await at(page, (before.x + 20) / 595.28, (before.y + 12) / 841.89);
  await drag(page, from, { x: from.x + 60, y: from.y + 80 });
  s = await st(page);
  expect(s.objs[0].x).toBeGreaterThan(before.x + 20);
  expect(s.objs[0].y).toBeGreaterThan(before.y + 20);

  // Text landet im PDF genau dort, wo er in der Vorschau stand
  const o = s.objs[0];
  const pages = await applyAndRead(page);
  const item = pages[0].items.find((i) => i.s.includes('Hallo Welt!'));
  expect(item).toBeTruthy();
  expect(Math.abs(item.x - o.x)).toBeLessThan(1);
  expect(Math.abs(item.y - (841.89 - o.y - o.size * 0.8))).toBeLessThan(1.5);
});

test('Text: leer gelassener Text verschwindet, Ecke ziehen vergrößert die Schrift, Rückgängig', async ({ page }) => {
  await open(page);
  await page.click('[data-tool="text"]');
  await clickAt(page, 0.3, 0.3);
  await page.keyboard.press('Backspace');               // Platzhalter gelöscht → leer
  await clickAt(page, 0.8, 0.8);
  expect((await st(page)).objs).toHaveLength(0);

  await page.click('[data-tool="text"]');
  await clickAt(page, 0.3, 0.3);
  await page.keyboard.type('Groß');
  const size0 = (await st(page)).objs[0].size;
  const h = page.locator('.ed-sel [data-handle="2"]');
  const hb = await h.boundingBox();
  await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + 120, y: hb.y + 60 });
  expect((await st(page)).objs[0].size).toBeGreaterThan(size0 * 1.5);
  // Rückgängig: erst Größe, dann Text weg
  await page.click('#edUndoBtn');
  expect((await st(page)).objs[0].size).toBeCloseTo(size0, 5);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect((await st(page)).objs).toHaveLength(0);
  await page.keyboard.press('Control+Shift+z');
  expect((await st(page)).objs).toHaveLength(1);
});

// ------------------------------------------------------------------ Auswahl-Werkzeuge

test('Auswahl: Lösch-Knopf liegt nicht auf dem Eck-Anfasser; Entf, Duplizieren, Nach vorne', async ({ page }) => {
  await open(page);
  await page.click('[data-tool="stamp"]');
  await page.click('#edStampInsert');
  const del = await page.locator('.ed-sel [data-del] circle').first().boundingBox();
  for (let k = 0; k < 4; k++) {
    const hd = await page.locator(`.ed-sel [data-handle="${k}"]`).boundingBox();
    const overlap = del.x < hd.x + hd.width && del.x + del.width > hd.x && del.y < hd.y + hd.height && del.y + del.height > hd.y;
    expect(overlap, `Lösch-Knopf überlappt Anfasser ${k}`).toBe(false);
  }
  await page.click('#edObjDup');
  let s = await st(page);
  expect(s.objs).toHaveLength(2);
  expect(s.selected).toBe(1);
  expect(s.objs[1].x).toBeCloseTo(s.objs[0].x + 14, 5);
  // erstes wählen und nach vorne holen
  await page.keyboard.press('Escape');
  await clickAt(page, (s.objs[0].x + 5) / 595.28, (s.objs[0].y + 5) / 841.89);
  expect((await st(page)).selected).toBe(0);
  await page.click('#edObjFront');
  s = await st(page);
  expect(s.selected).toBe(1);
  // Entf löscht, Pfeiltasten verschieben
  const x0 = s.objs[1].x;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  expect((await st(page)).objs[1].x).toBeCloseTo(x0 + 11, 5);
  await page.keyboard.press('Delete');
  expect((await st(page)).objs).toHaveLength(1);
  // Lösch-Knopf
  await clickAt(page, (s.objs[0].x + 5) / 595.28, (s.objs[0].y + 5) / 841.89);
  await page.locator('.ed-sel [data-del] circle').nth(1).click();
  expect((await st(page)).objs).toHaveLength(0);
});

// ------------------------------------------------------------------ Stift, Marker, Radierer, Abdecken

test('Stift, Marker, Radierer', async ({ page }) => {
  await open(page);
  await page.click('[data-tool="draw"]');
  await page.click('[data-swatches="edPenColor"] .ed-swatch[data-color="#c00000"]');
  await drag(page, await at(page, 0.2, 0.85), await at(page, 0.6, 0.85));
  await page.click('#edPenMode button[data-v="marker"]');
  await drag(page, await at(page, 0.2, 0.9), await at(page, 0.6, 0.9));
  let s = await st(page);
  const inks = s.objs.filter((o) => o.type === 'ink');
  expect(inks).toHaveLength(2);
  expect(inks[0]).toMatchObject({ color: '#c00000', opacity: 1 });
  expect(inks[1].opacity).toBeCloseTo(0.45, 5);
  // Radierer entfernt den Marker-Strich
  await page.click('#edPenMode button[data-v="erase"]');
  await drag(page, await at(page, 0.4, 0.88), await at(page, 0.4, 0.92));
  s = await st(page);
  expect(s.objs.filter((o) => o.type === 'ink')).toHaveLength(1);
  const pages = await applyAndRead(page);
  expect(pages).toHaveLength(2);
  const [r, g] = await pixel(page, 1, 0.4, 0.85);
  expect(r).toBeGreaterThan(150);
  expect(g).toBeLessThan(100);
});

// ------------------------------------------------------------------ Schwärzen

test('Schwärzen entfernt den Text wirklich (nicht nur abgedeckt), Balken verschieb- und skalierbar', async ({ page }) => {
  await open(page);
  await page.click('[data-tool="redact"]');
  // „Kontonummer 1234 5678“ steht bei y≈560 pt (von unten) → oben ≈ 0,32
  await drag(page, await at(page, 0.1, 0.305), await at(page, 0.6, 0.345));
  let s = await st(page);
  expect(s.objs).toHaveLength(1);
  expect(s.objs[0].type).toBe('rect');
  expect(s.selected).toBe(0);
  // Balken etwas verbreitern (rechte untere Ecke)
  const hb = await page.locator('.ed-sel [data-handle="2"]').boundingBox();
  await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + 40, y: hb.y + hb.height / 2 });
  s = await st(page);
  expect(s.objs[0].w).toBeGreaterThan(300);
  const pages = await applyAndRead(page);
  expect(pages[0].text).not.toContain('Kontonummer');   // wirklich weg
  expect(pages[0].text).not.toContain('VERTRAULICH');   // Seite ist jetzt ein Bild
  expect(pages[1].text).toContain('Kontonummer');       // andere Seite unberührt
  const [r] = await pixel(page, 1, 0.3, 0.325);
  expect(r).toBeLessThan(40);
});

// ------------------------------------------------------------------ Bild

test('Bild einfügen: PNG mit Transparenz bleibt PNG, Seitenverhältnis bleibt, abschaltbar', async ({ page }) => {
  await open(page);
  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 200;
    const x = c.getContext('2d'); x.fillStyle = '#1d4ed8'; x.beginPath(); x.arc(200, 100, 90, 0, 7); x.fill();
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.setInputFiles('#edImageInput', { name: 'logo.png', mimeType: 'image/png', buffer: png });
  await expect.poll(async () => (await st(page)).objs.length).toBe(1);
  let s = await st(page);
  expect(s.selected).toBe(0);
  const o = s.objs[0];
  expect(o.w / o.h).toBeCloseTo(2, 2);
  expect(await page.evaluate((id) => window.__pdfeditorState().state.assets.kind[id], o.assetId)).toBe('png');
  // Mitte des sichtbaren Ausschnitts
  expect(o.x + o.w / 2).toBeCloseTo(595.28 / 2, -1);
  const hb = await page.locator('.ed-sel [data-handle="2"]').boundingBox();
  await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + 80, y: hb.y + 10 });
  s = await st(page);
  expect(s.objs[0].w / s.objs[0].h).toBeCloseTo(2, 2);
  await page.uncheck('#edAspect');
  const hb2 = await page.locator('.ed-sel [data-handle="2"]').boundingBox();
  await drag(page, { x: hb2.x + hb2.width / 2, y: hb2.y + hb2.height / 2 }, { x: hb2.x + hb2.width / 2, y: hb2.y + 120 });
  s = await st(page);
  expect(s.objs[0].w / s.objs[0].h).toBeLessThan(1.6);
  await applyAndRead(page);
  const [r, , b] = await pixel(page, 1, (s.objs[0].x + s.objs[0].w / 2) / 595.28, (s.objs[0].y + s.objs[0].h / 2) / 841.89);
  expect(b).toBeGreaterThan(150);
  expect(r).toBeLessThan(80);
});

// ------------------------------------------------------------------ Unterschrift

test('Unterschrift: zeichnen & speichern, aus „Gespeichert“ einfügen, Farbe ändern, Foto ohne Transparenz', async ({ page }) => {
  await open(page);
  await page.click('[data-tool="sign"]');
  await page.click('.ed-tab[data-tab="drawTab"]');
  await expect(page.locator('#sigUseDrawn')).toBeDisabled();
  const pad = await page.locator('#sigPad').boundingBox();
  await page.mouse.move(pad.x + pad.width * 0.15, pad.y + pad.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(pad.x + pad.width * (0.15 + i * 0.05), pad.y + pad.height * (0.6 + Math.sin(i) * 0.15));
  await page.mouse.up();
  await page.fill('#sigName', 'Test-Unterschrift');
  await page.click('#sigUseDrawn');
  await expect(page.locator('#edModal')).toBeHidden();
  let s = await st(page);
  expect(s.objs[0].type).toBe('sig-vector');
  await page.click('[data-swatches="edSigColor"] .ed-swatch[data-color="#111111"]');
  expect((await st(page)).objs[0].color).toBe('#111111');

  // Gespeicherte Unterschrift: Blatt öffnet direkt mit „Gespeichert“
  await page.click('[data-tool="sign"]');
  await expect(page.locator('.ed-tab[data-tab="savedTab"]')).toHaveClass(/active/);
  const card = page.locator('.ed-sig-card', { hasText: 'Test-Unterschrift' }).first();
  await expect(card).toBeVisible();
  await card.locator('.ed-sig-use').click();
  expect((await st(page)).objs).toHaveLength(2);

  // Foto (ohne Transparenz): Regler sichtbar, Papier wird entfernt
  const photo = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 500; c.height = 200;
    const x = c.getContext('2d'); x.fillStyle = '#d8d2c6'; x.fillRect(0, 0, 500, 200);
    x.strokeStyle = '#222'; x.lineWidth = 7; x.beginPath(); x.moveTo(40, 150); x.bezierCurveTo(150, 20, 300, 180, 460, 60); x.stroke();
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.click('[data-tool="sign"]');
  await page.click('.ed-tab[data-tab="photoTab"]');
  await page.setInputFiles('#edSigPhotoInput', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('#sigPhotoCtrls')).toBeVisible();
  await expect(page.locator('#sigPhotoInfo')).toContainText('Papier wird entfernt');
  const corner = await page.evaluate(() => document.querySelector('#sigPhotoPreview').getContext('2d').getImageData(1, 1, 1, 1).data[3]);
  expect(corner).toBe(0);
  await page.uncheck('#sigPhotoSave');
  await page.click('#sigUsePhoto');
  s = await st(page);
  expect(s.objs.map((o) => o.type)).toEqual(['sig-vector', 'sig-vector', 'sig-image']);

  // Gespeicherte Unterschrift löschen (mit Rückfrage)
  await page.click('[data-tool="sign"]');
  const n = await page.locator('.ed-sig-card').count();
  await page.locator('.ed-sig-card', { hasText: 'Test-Unterschrift' }).first().locator('.ed-sig-del').click();
  await page.click('.dlg .btn-danger');
  await expect(page.locator('.ed-sig-card')).toHaveCount(n - 1);
  await page.click('#edSheetClose');
});

// ------------------------------------------------------------------ Stempel

test('Stempel: alle Stile, Felder nachträglich ändern, Vorlage speichern/laden/löschen, Bild-Stempel', async ({ page }) => {
  await open(page);
  await page.click('[data-tool="stamp"]');
  await page.click('.ed-chip[data-title="EINGEGANGEN"]');
  await page.fill('#stDNote', 'per Post');
  await page.dispatchEvent('#stDNote', 'input');
  await page.click('#stDStyle button[data-v="round"]');
  await expect(page.locator('#edStampPreview image')).toHaveCount(1);   // runder Stempel als Bild
  await page.click('#stDStyle button[data-v="frame"]');
  await expect(page.locator('#edStampPreview text').first()).toContainText('EINGEGANGEN');
  await page.click('#edStampSaveTpl');
  await expect(page.locator('#edTplList .ed-tpl')).toHaveCount(1);
  await page.click('#edStampInsert');
  let s = await st(page);
  expect(s.objs[0]).toMatchObject({ type: 'stamp', title: 'EINGEGANGEN', note: 'per Post', style: 'frame' });

  // Im Panel ändern
  await page.fill('#edStTitle', 'ERLEDIGT AM');
  await page.dispatchEvent('#edStTitle', 'input');
  await page.fill('#edStBrand', 'Familie Muster');
  await page.dispatchEvent('#edStBrand', 'input');
  await page.click('[data-swatches="edStColor"] .ed-swatch[data-color="#1d4ed8"]');
  s = await st(page);
  expect(s.objs[0]).toMatchObject({ title: 'ERLEDIGT AM', brand: 'Familie Muster', color: '#1d4ed8' });
  // Größe proportional
  const r0 = s.objs[0].w / s.objs[0].h;
  const hb = await page.locator('.ed-sel [data-handle="2"]').boundingBox();
  await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + 70, y: hb.y + 5 });
  s = await st(page);
  expect(s.objs[0].w / s.objs[0].h).toBeCloseTo(r0, 3);

  // Vorlage laden → Felder kommen zurück; „Stempel“-Stil einfügen
  await page.click('[data-tool="stamp"]');
  await page.locator('#edTplList .ed-tpl-use').first().click();
  await expect(page.locator('#stDTitle')).toHaveValue('EINGEGANGEN');
  await page.click('#stDStyle button[data-v="stamp"]');
  await page.click('#edStampInsert');
  expect((await st(page)).objs[1].style).toBe('stamp');

  // Vorlage löschen
  await page.click('[data-tool="stamp"]');
  await page.locator('#edTplList .ed-tpl-del').first().click();
  await expect(page.locator('#edTplList .ed-tpl')).toHaveCount(0);

  // Bild als Stempel (Logo auf weißem Grund → Weiß wird entfernt)
  const logo = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 120;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 120);
    x.fillStyle = '#15803d'; x.font = '700 60px Arial'; x.fillText('LOGO', 40, 85);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.setInputFiles('#edStampImageInput', { name: 'logo.png', mimeType: 'image/png', buffer: logo });
  await expect.poll(async () => (await st(page)).objs.length).toBe(3);
  await expect(page.locator('.toast').last()).toContainText('Bild-Stempel');

  const pages = await applyAndRead(page);
  expect(pages[0].text).toContain('ERLEDIGT AM');
  expect(pages[0].text).toContain('Familie Muster');
  expect(pages[0].text).toContain('per Post');
  // aufräumen: gespeicherter Bild-Stempel
  await page.evaluate(async () => {
    const store = await import('./js/store.js');
    for (const t of await store.listStamps()) await store.deleteStamp(t.id);
  });
});

// ------------------------------------------------------------------ Zuschnitt, Seiten, Navigation

test('Zuschnitt setzen/entfernen, Seiten: blättern, Objekte bleiben auf ihrer Seite, Seitenverwaltung', async ({ page }) => {
  await open(page);
  // Seite 1: Text, Seite 2: Stempel
  await page.click('[data-tool="text"]');
  await clickAt(page, 0.2, 0.1);
  await page.keyboard.type('Seite eins');
  await page.click('#edNext');
  await expect(page.locator('#edPageInfo')).toHaveText('2/2');
  await page.click('[data-tool="stamp"]');
  await page.click('#edStampInsert');
  expect((await st(page)).objs.map((o) => o.type)).toEqual(['stamp']);
  await page.click('#edPrev');
  expect((await st(page)).objs.map((o) => o.type)).toEqual(['text']);

  // Zuschnitt auf Seite 1
  await page.click('[data-tool="crop"]');
  await expect(page.locator('#edCropApply')).toBeDisabled();
  await drag(page, await at(page, 0.05, 0.05), await at(page, 0.85, 0.7));
  await expect(page.locator('#edCropApply')).toBeEnabled();
  await page.click('#edCropApply');
  await expect(page.locator('#edCropClear')).toBeEnabled();
  expect(await page.evaluate(() => !!window.__pdfeditorState().state.pages[0].crop)).toBe(true);

  // Seitenverwaltung: leere Seite, Seite 2 duplizieren, Seitenzahlen, Daumen springt zur Seite
  await page.click('#edPagesBtn');
  await expect(page.locator('.ed-pagecell')).toHaveCount(2);
  await page.click('#edAddBlank');
  await expect(page.locator('.ed-pagecell')).toHaveCount(3);
  await page.locator('.ed-pagecell').nth(1).locator('[aria-label="Seite duplizieren"]').click();
  await expect(page.locator('.ed-pagecell')).toHaveCount(4);
  await page.locator('.ed-pagecell').nth(3).locator('[aria-label="Seite drehen"]').click();
  await expect(page.locator('.ed-pagecell').nth(3)).toContainText('90°');
  await page.check('#edPageNums');
  await page.locator('.ed-pagecell').nth(2).locator('.ed-pagethumb').click();
  await expect(page.locator('#edModal')).toBeHidden();
  await expect(page.locator('#edPageInfo')).toHaveText('3/4');

  const pages = await applyAndRead(page);
  expect(pages).toHaveLength(4);
  expect(pages[0].text).toContain('Seite eins');
  expect(pages[0].text).not.toContain('2 / 4');
  expect(pages[1].text).toContain('2 / 4');                 // Seitenzahlen
  expect(Math.round(pages[0].w)).toBe(Math.round(595.28 * 0.8));   // Zuschnitt
  expect(pages[3].w).toBeGreaterThan(pages[3].h);           // gedreht
});

test('Zoom: Knöpfe, Mausrad zum Zeiger, Ansicht nur verschiebbar wenn hineingezoomt; Abbrechen fragt nach', async ({ page }) => {
  await open(page);
  await expect(page.locator('#edZoomFit')).toHaveText('Fit');
  // ungezoomt: Ziehen auf leerer Fläche verschiebt nichts
  await drag(page, await at(page, 0.5, 0.5), await at(page, 0.7, 0.7));
  expect(await page.evaluate(() => window.__pdfeditorState().pan)).toEqual({ x: 0, y: 0 });
  await page.click('#edZoomIn');
  await expect(page.locator('#edZoomFit')).toHaveText('125 %');
  await drag(page, await at(page, 0.5, 0.5), await at(page, 0.6, 0.6));
  expect((await page.evaluate(() => window.__pdfeditorState().pan)).x).not.toBe(0);
  await page.click('#edZoomFit');
  await expect(page.locator('#edZoomFit')).toHaveText('Fit');
  const p = await at(page, 0.2, 0.2);
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -200);
  const z = await page.evaluate(() => ({ zoom: window.__pdfeditorState().zoom, pan: window.__pdfeditorState().pan }));
  expect(z.zoom).toBeGreaterThan(1);
  expect(z.pan.x).toBeGreaterThan(0);   // zum Zeiger (links oben) hin
  // Ohne Änderungen schließt Abbrechen sofort; mit Änderungen kommt eine Rückfrage
  await page.click('[data-tool="stamp"]');
  await page.click('#edStampInsert');
  await page.click('#edCancel');
  await expect(page.locator('.dlg')).toBeVisible();
  await page.click('.dlg .btn:not(.btn-danger)');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();
  await page.click('#edCancel');
  await page.click('.dlg .btn-danger');
  await expect(page.locator('#editorRoot')).toBeHidden();
  expect(await page.evaluate(() => window.__pdfpresser.state.docs[0].edited)).toBe(false);
});

test('Formular ausfüllen über die Oberfläche', async ({ page }) => {
  await open(page, `(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    const p = doc.addPage([595.28, 841.89]);
    const f = doc.getForm();
    f.createTextField('Vorname').addToPage(p, { x: 60, y: 700, width: 200, height: 22 });
    f.createCheckBox('Zustimmung').addToPage(p, { x: 60, y: 650, width: 16, height: 16 });
    return doc.save();
  })`);
  await expect(page.locator('#edFormBtn')).toBeVisible();
  await page.click('#edFormBtn');
  await page.fill('.ed-form input[type="text"]', 'Kim');
  await page.check('.ed-form input[type="checkbox"]');
  await page.click('#edFormOk');
  const pages = await applyAndRead(page);
  expect(pages[0].text).toContain('Kim');
});

// ------------------------------------------------------------------ Handy (Touch)

test('Handy: Text per Tippen anlegen, weiteres Tippen legt keinen neuen an; Tastatur verdeckt nichts', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await open(page);
  await page.tap('[data-tool="text"]');
  const p = await at(page, 0.3, 0.25);
  await page.touchscreen.tap(p.x, p.y);
  await expect(page.locator('#edTextInput')).toBeVisible();
  let s = await st(page);
  expect(s.objs).toHaveLength(1);
  expect(s.tool).toBe('select');
  await page.fill('#edTextInput', 'Vom Handy');
  for (const [fx, fy] of [[0.7, 0.6], [0.5, 0.8], [0.2, 0.5]]) {
    const q = await at(page, fx, fy);
    await page.touchscreen.tap(q.x, q.y);
  }
  s = await st(page);
  expect(s.objs).toHaveLength(1);
  expect(s.objs[0].text).toBe('Vom Handy');
  // Text wieder antippen → Panel mit Eingabe
  const t = s.objs[0];
  const q = await at(page, (t.x + 8) / 595.28, (t.y + t.size * 0.5) / 841.89);
  await page.touchscreen.tap(q.x, q.y);
  await expect(page.locator('#edTextInput')).toHaveValue('Vom Handy');
  // Werkzeugleiste und Eingabe liegen im sichtbaren Bereich
  const vp = page.viewportSize();
  for (const sel of ['#edTextInput', '[data-tool="sign"]', '#edApply']) {
    const b = await page.locator(sel).boundingBox();
    expect(b.y + b.height, sel).toBeLessThanOrEqual(vp.height + 1);
    expect(b.y, sel).toBeGreaterThanOrEqual(0);
  }
  await page.tap('[data-tool="stamp"]');
  await page.tap('#edStampInsert');
  expect((await st(page)).objs).toHaveLength(2);
  const pages = await applyAndRead(page);
  expect(pages[0].text).toContain('Vom Handy');
  expect(pages[0].text).toContain('BEZAHLT');
  await ctx.close();
});

test('Schwärzen auf gedrehter Seite (Querformat): Balken an der Sichtposition, Text weg, neue Objekte darüber', async ({ page }) => {
  await appReady(page);
  await page.waitForFunction(() => window.__pdfeditor || (import('./js/editor.js'), false));
  const res = await page.evaluate(async () => {
    const { PDFDocument, StandardFonts, degrees, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595.28, 841.89]);
    p.drawText('GEHEIM-QUER', { x: 100, y: 300, size: 24, font, color: rgb(0, 0, 0) });
    p.drawText('BLEIBT-DA', { x: 100, y: 700, size: 24, font, color: rgb(0, 0, 0) });
    p.setRotation(degrees(90));
    const src = await doc.save();
    // Wo steht „GEHEIM-QUER“ in der (gedrehten) Ansicht?
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const pd = await pdfjs.getDocument({ data: src.slice() }).promise;
    const pg = await pd.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const it = (await pg.getTextContent()).items.find((i) => i.str === 'GEHEIM-QUER');
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    await pd.destroy();
    const out = await window.__pdfeditor.applyEdits(src, {
      pages: [{ src: 0, objects: [
        { type: 'rect', color: '#000000', x: x - 40, y: y - 160, w: 60, h: 200 },
        { type: 'text', x: 50, y: 50, size: 18, color: '#111111', font: 'helv', text: 'Neu darüber' },
      ] }],
      assets: { bytes: {}, kind: {}, url: {} },
    });
    const od = await pdfjs.getDocument({ data: out.slice() }).promise;
    const op = await od.getPage(1);
    const ovp = op.getViewport({ scale: 1 });
    const text = (await op.getTextContent()).items.map((i) => i.str).join(' ');
    const c = document.createElement('canvas'); c.width = ovp.width; c.height = ovp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await op.render({ canvasContext: ctx, viewport: ovp }).promise;
    const dark = ctx.getImageData(Math.round(x - 10), Math.round(y - 60), 1, 1).data[0];
    await od.destroy();
    return { view: [vp.width, vp.height], out: [ovp.width, ovp.height], text, dark };
  });
  expect(res.view[0]).toBeGreaterThan(res.view[1]);            // Ansicht quer
  expect(res.out[0]).toBeCloseTo(res.view[0], 0);               // bleibt quer
  expect(res.text).not.toContain('GEHEIM-QUER');
  expect(res.text).toContain('Neu darüber');
  expect(res.dark).toBeLessThan(40);                            // Balken an der richtigen Stelle
});
