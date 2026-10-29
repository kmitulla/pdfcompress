// Oberfläche: Dokumente hinzufügen, komprimieren, Ergebnis weitergeben
// (Download, im Browser öffnen, teilen, Paperless), Vorschau & Simulation,
// Einstellungen, Handy-Layout.
import { test, expect, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ready, addTestPdf, photoJpeg, assertNoRawMarkup } from './helpers.js';

test.describe.configure({ mode: 'serial' });

async function pdfBuffer(pages = 2, label = 'Dokument') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawRectangle({ x: 0, y: 650, width: 595, height: 190, color: rgb(0.3, 0.5, 0.9) });
    p.drawText(`${label} ${i + 1}`, { x: 50, y: 720, size: 36, font, color: rgb(1, 1, 1) });
    for (let l = 0; l < 25; l++) p.drawText(`Zeile ${l} mit etwas Text`, { x: 50, y: 600 - l * 20, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

const waitDone = (page, idx = 0, timeout = 120000) => page.waitForFunction(
  (i) => window.__pdfpresser.state.docs[i]?.status === 'done', idx, { timeout },
);

test('Oberfläche lädt fehlerfrei: Icons statt Emojis, kein rohes Markup', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeVisible();
  expect(await page.locator('svg.icn').count()).toBeGreaterThan(10);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u);
  await assertNoRawMarkup(expect, page, 'body');
  // Test-Scanner ist eingerichtet: Scanner-Knopf sichtbar
  await expect(page.locator('#docsToolbar [data-add="scanner"]')).toBeVisible();
  // Paperless (Ordner) ist im Test eingerichtet
  await expect(page.locator('#statusPaperless')).toBeVisible();
  expect(errors).toEqual([]);
});

test('PDF hinzufügen, komprimieren, herunterladen, im Browser öffnen, teilen', async ({ page, context }) => {
  await page.addInitScript(() => {
    window.__shared = null;
    navigator.canShare = () => true;
    navigator.share = async (data) => { window.__shared = data.files.map((f) => ({ name: f.name, type: f.type, size: f.size })); };
  });
  await ready(page);
  await page.setInputFiles('#fileInput', { name: 'Rechnung Oktober.pdf', mimeType: 'application/pdf', buffer: await pdfBuffer(2) });
  await expect(page.locator('.doc')).toHaveCount(1);
  await expect(page.locator('.doc .doc-meta')).toContainText('2 Seiten');
  // Inspektor zeigt das Dokument, Standardprofil für PDFs
  await expect(page.locator('#inspName')).toHaveValue('Rechnung Oktober');
  await expect(page.locator('.profile.active')).toContainText('Ausgewogen');

  await page.click('.doc [data-act="compress"]');
  await waitDone(page);
  await expect(page.locator('.result-card')).toBeVisible();
  await expect(page.locator('.doc .doc-meta')).toContainText('→');

  // Herunterladen
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#inspector .result-card [data-act="download"]')]);
  expect(dl.suggestedFilename()).toBe('Rechnung Oktober.pdf');
  const head = fs.readFileSync(await dl.path()).subarray(0, 5).toString();
  expect(head).toBe('%PDF-');

  // Im Browser öffnen: neuer Tab mit dem PDF
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#inspector .result-card [data-act="open"]')]);
  expect(popup.url()).toMatch(/^blob:/);
  await popup.close();

  // Teilen über den System-Dialog
  await page.click('#inspector .result-card [data-act="share"]');
  await expect.poll(() => page.evaluate(() => window.__shared)).not.toBeNull();
  const shared = await page.evaluate(() => window.__shared);
  expect(shared[0].name).toBe('Rechnung Oktober.pdf');
  expect(shared[0].type).toBe('application/pdf');
});

test('Teilen ohne Browser-Unterstützung lädt herunter', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { pages: 1, name: 'Kurz.pdf' });
  await page.click('.doc [data-act="compress"]');
  await waitDone(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#inspector .result-card [data-act="share"]')]);
  expect(dl.suggestedFilename()).toBe('Kurz.pdf');
  await expect(page.locator('.toast')).toContainText('heruntergeladen');
});

test('Profilwechsel macht das Ergebnis veraltet; Simulation füllt alle Profile', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { pages: 2 });
  await page.click('.doc [data-act="compress"]');
  await waitDone(page);
  await page.click('.profile:has(input[value="extrem-sw"])');
  await expect(page.locator('.doc .chip-warn')).toContainText('geändert');
  await expect(page.locator('#inspector .insp-foot')).toContainText('Erneut komprimieren');
  await expect(page.locator('.result-card')).toHaveCount(0);

  await page.click('#inspector [data-act="simulate"]');
  await expect.poll(async () => page.locator('.profile-size b').count(), { timeout: 60000 }).toBe(7);
  const sizes = await page.evaluate(() => window.__pdfpresser.state.docs[0].sim.sizes);
  expect(Object.keys(sizes).length).toBe(7);
  expect(sizes['extrem-sw']).toBeLessThan(sizes.leicht);

  // Feinabstimmung: Auflösung ändern wirkt auf die Optionen
  await page.click('#inspector .tune summary');
  await page.selectOption('#inspector select[data-tune="dpi"]', '200');
  const opts = await page.evaluate(() => window.__pdfpresser.optsFor(window.__pdfpresser.state.docs[0]));
  expect(opts.dpi).toBe(200);
  expect(opts.colorMode).toBe('bw');
});

test('Vorschau: Original, simuliertes Ergebnis, echtes Ergebnis und Seitenausnahme', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { pages: 3, name: 'Drei.pdf' });
  await page.click('#inspector .insp-links [data-act="preview"]');
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#viewerInfo')).toContainText('für diese Seite', { timeout: 20000 });
  await expect(page.locator('#viewerPage')).toHaveText('1 / 3');
  await expect(page.locator('#viewerMode button[data-v="result"]')).toBeDisabled();

  await page.click('#viewerNext');
  await expect(page.locator('#viewerPage')).toHaveText('2 / 3');
  await page.selectOption('#viewerOverride', 'extrem-sw');
  await expect(page.locator('#viewerSub')).toContainText('Scan S/W');
  const ov = await page.evaluate(() => window.__pdfpresser.state.docs[0].pageProfiles);
  expect(ov).toEqual({ 2: 'extrem-sw' });

  await page.click('#viewerMode button[data-v="original"]');
  await expect(page.locator('#viewerInfo')).toContainText('Original');
  const src = await page.locator('#viewerImg').getAttribute('src');
  expect(src).toMatch(/^data:image\//);

  await page.click('#viewerClose');
  await expect(page.locator('#viewer')).toBeHidden();
  await expect(page.locator('.doc .doc-tags')).toContainText('Seitenausnahme');

  // Komprimieren nutzt die Ausnahme: Seite 2 ist dann 1-Bit
  const opts = await page.evaluate(() => window.__pdfpresser.optsFor(window.__pdfpresser.state.docs[0]));
  expect(opts.pageOverrides[2].colorMode).toBe('bw');
  await page.click('.doc [data-act="compress"]');
  await waitDone(page);
  await page.click('#inspector .result-card [data-act="preview"]');
  await expect(page.locator('#viewerMode button[data-v="result"]')).toHaveClass(/active/);
  await expect(page.locator('#viewerInfo')).toContainText('fertige PDF', { timeout: 20000 });
});

test('An Paperless senden: Datei mit gewähltem Namen landet im consume-Ordner', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { pages: 1 });
  const name = `Steuer Bürger ${Date.now()}`;
  await page.fill('#inspName', name);
  await page.press('#inspName', 'Enter');
  await expect(page.locator('.doc .doc-title')).toHaveText(`${name}.pdf`);
  await page.click('#inspector .insp-foot [data-act="compress"]');
  await waitDone(page);
  await page.click('#inspector .insp-foot [data-act="paperless"]');
  await expect(page.locator('.doc .chip-ok')).toContainText('Paperless');
  const file = path.join('test-results', 'consume', `${name}.pdf`);
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  expect(fs.readFileSync(file).subarray(0, 5).toString()).toBe('%PDF-');
});

test('Einstellungen: Standardprofil & Automatik gelten für neue Dokumente', async ({ page }) => {
  await ready(page);
  await page.click('.nav-item[data-view="settings"]');
  await expect(page.locator('#viewSettings')).toBeVisible();
  await page.selectOption('#setPdfProfile', 'extrem-grau');
  await page.locator('#setAutoCompress').evaluate((el) => el.click());
  await page.waitForTimeout(1200);   // Serverprofil-Upload abwarten

  await page.reload();
  await page.waitForFunction(() => window.__pdfpresser);
  await page.evaluate(() => window.__pdfpresser.booted);
  expect(await page.locator('#setPdfProfile').inputValue()).toBe('extrem-grau');
  expect(await page.locator('#setAutoCompress').isChecked()).toBe(true);

  await page.click('.nav-item[data-view="docs"]');
  await addTestPdf(page, { pages: 1 });
  await waitDone(page);
  const d = await page.evaluate(() => ({ profile: window.__pdfpresser.state.docs[0].profile, status: window.__pdfpresser.state.docs[0].status }));
  expect(d).toEqual({ profile: 'extrem-grau', status: 'done' });
  await page.evaluate(() => window.__pdfpresser.resetSettings());
  await page.waitForTimeout(1200);
});

test('Fotos landen im Scan-Studio und werden ein A4-Scan-Dokument', async ({ page }) => {
  await ready(page);
  const jpeg = await photoJpeg(page, 1600, 1200);
  await page.setInputFiles('#fileInput', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.locator('#scannerRoot .sc-overlay')).toBeVisible();
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1, { timeout: 20000 });
  await expect(page.locator('.sc-pagelabel').first()).toContainText('A4');
  await page.click('#scDoneBtn');
  await expect(page.locator('#scannerRoot')).toHaveCount(0);
  await expect(page.locator('.doc')).toHaveCount(1);
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].pages === 1);
  const d = await page.evaluate(async () => {
    const doc = window.__pdfpresser.state.docs[0];
    const pdf = await window.PDFLib.PDFDocument.load(doc.bytes);
    const { width, height } = pdf.getPage(0).getSize();
    return { kind: doc.kind, profile: doc.profile, ocr: doc.ocr, size: [Math.round(width), Math.round(height)] };
  });
  // Quer-Foto eines Hochformat-Blatts: Ecken erkannt, Seite A4
  expect(d.kind).toBe('scan');
  expect(d.profile).toBe('extrem-sw');
  expect(d.ocr).toBe(true);
  expect([[595, 842], [842, 595]]).toContainEqual(d.size);
});

test('Zusammenführen ersetzt die Einzeldokumente durch eines', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { pages: 2, name: 'A.pdf' });
  await addTestPdf(page, { pages: 3, name: 'B.pdf' });
  await expect(page.locator('.doc')).toHaveCount(2);
  await page.click('#moreBtn');
  await page.click('#moreMenu [data-more="merge"]');
  await page.click('.dlg .btn-primary');
  await expect(page.locator('.doc')).toHaveCount(1);
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].pages === 5);
  await expect(page.locator('.doc .doc-title')).toContainText('zusammengeführt');
});

test('Alle komprimieren arbeitet die Liste nacheinander ab', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { pages: 1, name: 'Eins.pdf' });
  await addTestPdf(page, { pages: 1, name: 'Zwei.pdf' });
  await expect(page.locator('#compressAllBtn')).toBeVisible();
  await page.click('#compressAllBtn');
  await waitDone(page, 0);
  await waitDone(page, 1);
  await expect(page.locator('#compressAllBtn')).toBeHidden();
});

test('Handy: Tab-Leiste, Hinzufügen-Blatt mit Kamera, Inspektor als Blatt', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await ready(page);
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  // Kamera: natives Kamera-Eingabefeld statt Live-Vorschau
  expect(await page.locator('#cameraInput').getAttribute('capture')).toBe('environment');
  expect(await page.locator('#cameraInput').getAttribute('accept')).toContain('image/');
  await page.click('#tabAdd');
  await expect(page.locator('#addSheet')).toHaveClass(/open/);
  await expect(page.locator('#addSheet [data-add="camera"]')).toBeVisible();
  await expect(page.locator('#addSheet [data-add="files"]')).toBeVisible();
  // Kamera-Kachel öffnet den Datei-Dialog des Kamera-Felds
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#addSheet [data-add="camera"]')]);
  expect(chooser.element()).toBeTruthy();
  await chooser.setFiles({ name: 'foto.jpg', mimeType: 'image/jpeg', buffer: await photoJpeg(page) });
  await expect(page.locator('#scannerRoot .sc-overlay')).toBeVisible();
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1, { timeout: 20000 });
  await page.click('#scDoneBtn');
  await expect(page.locator('.doc')).toHaveCount(1);

  // Karte antippen -> Inspektor als Blatt von unten
  await page.click('.doc .doc-title');
  await expect(page.locator('#inspector')).toHaveClass(/open/);
  const box = await page.locator('#inspector').boundingBox();
  expect(box.y).toBeGreaterThan(30);
  await page.click('#inspector [data-act="closeInspector"]');
  await expect(page.locator('#inspector')).not.toHaveClass(/open/);
  await ctx.close();
});

test('Dokumente bleiben nach Schließen/Neuladen erhalten – samt Ergebnis', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { name: 'Bleibt da.pdf', pages: 1 });
  await page.click('#inspector .insp-foot [data-act="compress"]');
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].status === 'done', null, { timeout: 60000 });
  const size = await page.evaluate(() => window.__pdfpresser.state.docs[0].result.length);
  await page.evaluate(() => window.__pdfpresser.saveDocsNow());
  await page.reload();
  await page.waitForFunction(() => window.__pdfpresser);
  await page.evaluate(() => window.__pdfpresser.booted);
  await expect(page.locator('.doc')).toHaveCount(1);
  await expect(page.locator('.doc .doc-title')).toHaveText('Bleibt da.pdf');
  const after = await page.evaluate(() => {
    const d = window.__pdfpresser.state.docs[0];
    return { status: d.status, size: d.result?.length, fresh: window.__pdfpresser.hasFresh(d) };
  });
  expect(after).toEqual({ status: 'done', size, fresh: true });
  // Entfernen wirkt ebenfalls dauerhaft
  await page.click('#inspector [data-act="remove"]');
  if (await page.locator('.dlg').isVisible()) await page.click('.dlg .btn-danger');
  await expect(page.locator('.doc')).toHaveCount(0);
  await page.evaluate(() => window.__pdfpresser.saveDocsNow());
  await page.reload();
  await page.waitForFunction(() => window.__pdfpresser);
  await page.evaluate(() => window.__pdfpresser.booted);
  await expect(page.locator('.doc')).toHaveCount(0);
});

test('Vorschau zeigt Dateigröße vorher → nachher in Prozent', async ({ page }) => {
  await ready(page);
  await addTestPdf(page, { pages: 2 });
  await page.click('#inspector [data-act="preview"]');
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#viewerSize')).toContainText('Dokument');
  await expect(page.locator('#viewerSize .vs-pct')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#viewerSize .vs-pct')).toHaveText(/[−+-]?\d+\s?%/);
  await page.click('#viewerClose');
  await page.click('#inspector .insp-foot [data-act="compress"]');
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].status === 'done', null, { timeout: 60000 });
  await page.click('#inspector [data-act="preview"]');
  await expect(page.locator('#viewerSize .vs-to')).not.toContainText('≈');
  await expect(page.locator('#viewerSize .vs-from')).toBeVisible();
});

test('Einstellungen: Paperless-API in der App hinterlegen und testen', async ({ page, request }) => {
  const http = await import('node:http');
  const mock = http.createServer((req, res) => {
    const ok = req.headers.authorization === 'Token abc123';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json', 'X-Version': '2.15' });
    res.end(JSON.stringify({ count: 7 }));
  });
  await new Promise((r) => mock.listen(8859, r));
  try {
    await ready(page);
    await page.click('.nav-item[data-view="settings"]');
    await expect(page.locator('#paperlessCard')).toBeVisible();
    await expect(page.locator('#paperlessPill')).toContainText('Ordner');
    await page.fill('#setPaperlessUrl', 'http://127.0.0.1:8859');
    await page.fill('#setPaperlessToken', 'falsch');
    await page.click('#paperlessTestBtn');
    await expect(page.locator('#paperlessTestInfo')).toContainText('Token');
    await page.fill('#setPaperlessToken', 'abc123');
    await page.click('#paperlessTestBtn');
    await expect(page.locator('#paperlessTestInfo')).toContainText('Verbunden mit Paperless 2.15');
    await page.click('#paperlessSaveBtn');
    await expect(page.locator('#paperlessPill')).toContainText('API');
    await expect(page.locator('#setPaperlessToken')).toHaveValue('');
    await expect(page.locator('#setPaperlessToken')).toHaveAttribute('placeholder', /gespeichert/);
    await expect(page.locator('#statusPaperless')).toContainText('API');
  } finally {
    await request.put('/api/settings', { data: { paperlessUrl: null, paperlessToken: null } });
    mock.close();
  }
});
