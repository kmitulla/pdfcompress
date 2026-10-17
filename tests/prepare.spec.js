// Sammelordner („Paperless Prepare“): ablegen, sichten, als EIN Dokument
// übernehmen, nach der Übergabe an Paperless aufräumen.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { ready, bedScanJpeg, photoJpeg, fakeConfig } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const RAW = path.join('test-results', 'raw');

function clearRaw() {
  fs.mkdirSync(RAW, { recursive: true });
  for (const f of fs.readdirSync(RAW)) fs.rmSync(path.join(RAW, f), { force: true });
}

async function smallPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save());
}

test('Ablegen, Auswahl und Löschen mit Rückfrage', async ({ page }) => {
  clearRaw();
  await ready(page);
  await page.click('.nav-item[data-view="inbox"]');
  await expect(page.locator('#viewInbox')).toBeVisible();
  await expect(page.locator('.raw-empty')).toBeVisible();
  await page.setInputFiles('#rawUploadInput', [
    { name: 'a.pdf', mimeType: 'application/pdf', buffer: await smallPdf() },
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await photoJpeg(page, 600, 450) },
  ]);
  await expect(page.locator('.raw-item')).toHaveCount(2);
  await expect(page.locator('#navRawCount')).toHaveText('2');
  await expect(page.locator('.raw-item img')).toHaveCount(1);   // Bild-Miniatur

  await page.click('.raw-item[data-name="a.pdf"]');
  await expect(page.locator('#rawSelInfo')).toContainText('1 ausgewählt');
  await page.click('#rawDeleteBtn');
  await page.click('.dlg .btn-danger');
  await expect(page.locator('.raw-item')).toHaveCount(1);
  expect(fs.existsSync(path.join(RAW, 'a.pdf'))).toBe(false);
});

test('Rohscans (nur Bilder) öffnen im Studio mit festem A4-Ausschnitt, danach Aufräumen', async ({ page }) => {
  clearRaw();
  await ready(page);
  // Rohscans wie vom Scanner abgelegt: Auflösung steht im Namen
  fs.writeFileSync(path.join(RAW, 'Scan_S01_300dpi.jpg'), await bedScanJpeg(page, { label: 'EINS' }));
  fs.writeFileSync(path.join(RAW, 'Scan_S02_300dpi.jpg'), await bedScanJpeg(page, { label: 'ZWEI' }));
  await page.click('.nav-item[data-view="inbox"]');
  await expect(page.locator('.raw-item')).toHaveCount(2);
  await page.check('#rawSelectAll');
  await page.click('#rawOpenBtn');
  await expect(page.locator('#scannerRoot .sc-overlay')).toBeVisible();
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('.sc-pagelabel').first()).toContainText('Glasfläche');
  await page.click('#scDoneBtn');
  await expect(page.locator('.doc')).toHaveCount(1);
  const raw = await page.evaluate(() => window.__pdfpresser.state.docs[0].rawSources);
  expect(raw).toEqual(['Scan_S01_300dpi.jpg', 'Scan_S02_300dpi.jpg']);

  // Komprimieren, an Paperless – dann wird das Aufräumen angeboten
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].pages === 2);
  await page.locator('#inspOcr').evaluate((el) => { if (el.checked) el.click(); });
  await page.click('#inspector .insp-foot [data-act="compress"]');
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].status === 'done', null, { timeout: 120000 });
  await page.click('#inspector .insp-foot [data-act="paperless"]');
  await expect(page.locator('.dlg')).toContainText('Sammelordner aufräumen');
  await page.click('.dlg .btn-danger');
  await expect.poll(() => fs.readdirSync(RAW).length).toBe(0);
});

test('Gemischte Auswahl (PDF + Bild) wird direkt ein Dokument; Ablehnen lässt Dateien liegen', async ({ page }) => {
  clearRaw();
  await ready(page);
  fs.writeFileSync(path.join(RAW, 'brief.pdf'), await smallPdf());
  fs.writeFileSync(path.join(RAW, 'foto.jpg'), await photoJpeg(page, 600, 450));
  await page.click('.nav-item[data-view="inbox"]');
  await page.check('#rawSelectAll');
  await page.click('#rawOpenBtn');
  await expect(page.locator('.doc')).toHaveCount(1);
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].pages === 2);
  const sizes = await page.evaluate(async () => {
    const d = await window.PDFLib.PDFDocument.load(window.__pdfpresser.state.docs[0].bytes);
    return d.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  });
  expect(sizes[1]).toEqual([842, 595]);   // Querfoto auf A4 quer

  await page.click('.profile:has(input[value="verlustfrei"])');
  await page.click('#inspector .insp-foot [data-act="compress"]');
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0].status === 'done', null, { timeout: 60000 });
  await page.click('#inspector .insp-foot [data-act="paperless"]');
  await expect(page.locator('.dlg')).toBeVisible();
  await page.click('.dlg .btn:not(.btn-danger)');
  await page.waitForTimeout(300);
  expect(fs.readdirSync(RAW).sort()).toEqual(['brief.pdf', 'foto.jpg']);
});

test('Direkt in den Sammelordner scannen (Ziel im Scanner-Blatt)', async ({ page }) => {
  clearRaw();
  await fakeConfig(page);
  await ready(page, { scanPages: 2, scanDelay: 0 });
  const jpeg = await bedScanJpeg(page, { w: 1275, h: 1754 });
  await page.route('**/api/scanner/scan*', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'image/jpeg', 'X-Scan-Dpi': '150' }, body: jpeg }));
  await page.click('.nav-item[data-view="inbox"]');
  await page.click('#rawScanBtn');
  await expect(page.locator('#scanSheet')).toHaveClass(/open/);
  await expect(page.locator('#scanTargetSeg button[data-v="raw"]')).toHaveClass(/active/);
  await page.click('#scanStartBtn');
  await expect(page.locator('.raw-item')).toHaveCount(2, { timeout: 30000 });
  const names = fs.readdirSync(RAW).sort();
  expect(names[0]).toMatch(/^Scan_.*_S01_150dpi\.jpg$/);
  expect(names[1]).toMatch(/_S02_150dpi\.jpg$/);
  await page.evaluate(() => window.__pdfpresser.resetSettings());
  clearRaw();
});
