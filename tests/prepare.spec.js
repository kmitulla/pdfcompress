// „Paperless Prepare“: Sammelordner, Übernehmen/Zusammenführen, Standardstufe,
// Übergabe an Paperless und anschließendes Aufräumen.
import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
  await page.waitForTimeout(900);   // Serverprofil abwarten
}

/** Sammelordner leeren, damit jeder Test von vorn anfängt */
async function clearRaw(page) {
  await page.evaluate(async () => {
    const r = await fetch('/api/raw', { cache: 'no-store' });
    const { files = [] } = await r.json();
    for (const f of files) {
      await fetch(`/api/raw?name=${encodeURIComponent(f.name)}`, { method: 'DELETE' });
    }
  });
}

/** Ein PDF mit n Seiten in den Sammelordner legen */
async function putPdf(page, name, pages = 1) {
  return page.evaluate(async ({ name, pages }) => {
    const { PDFDocument, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) {
      const p = doc.addPage([595.28, 841.89]);
      p.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(1, 1, 1) });
      p.drawRectangle({ x: 60, y: 700 - i * 30, width: 300, height: 18, color: rgb(0.1, 0.1, 0.1) });
    }
    const bytes = await doc.save();
    const res = await fetch(`/api/raw?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes,
    });
    return (await res.json()).name;
  }, { name, pages });
}

/** Ein Bild in den Sammelordner legen */
async function putImage(page, name) {
  return page.evaluate(async (name) => {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 800;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 800);
    x.fillStyle = '#2266aa'; x.fillRect(60, 90, 480, 620);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const res = await fetch(`/api/raw?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await blob.arrayBuffer(),
    });
    return (await res.json()).name;
  }, name);
}

test('Sammelordner: ablegen, auflisten, löschen', async ({ page }) => {
  await ready(page);
  await clearRaw(page);

  await putPdf(page, 'brief.pdf');
  await putImage(page, 'foto.png');
  await page.evaluate(() => window.__pdfprepare.refresh());

  await expect(page.locator('#prepSection')).toBeVisible();
  await expect.poll(() => page.locator('.prep-item').count()).toBe(2);
  await expect(page.locator('#prepList')).toContainText('brief.pdf');
  await expect(page.locator('#prepList')).toContainText('foto.png');

  // Löschen wirkt
  const n = await page.evaluate(() => window.__pdfprepare.deleteSelection(['foto.png'], false));
  expect(n).toBe(1);
  await expect.poll(() => page.locator('.prep-item').count()).toBe(1);
});

test('Namen kollidieren nicht und Pfad-Ausbrüche werden entschärft', async ({ page }) => {
  await ready(page);
  await clearRaw(page);

  const a = await putPdf(page, 'gleich.pdf');
  const b = await putPdf(page, 'gleich.pdf');
  expect(a).toBe('gleich.pdf');
  expect(b).not.toBe('gleich.pdf');     // zweite Datei bekommt einen freien Namen
  expect(b).toContain('gleich');

  const evil = await putPdf(page, '../../etc/passwd.pdf');
  expect(evil).toBe('passwd.pdf');
  expect(evil).not.toContain('/');

  await expect.poll(async () => {
    await page.evaluate(() => window.__pdfprepare.refresh());
    return page.locator('.prep-item').count();
  }).toBe(3);
});

test('Mehrere Dateien werden beim Übernehmen zu einer PDF zusammengeführt', async ({ page }) => {
  await ready(page);
  await clearRaw(page);
  await putPdf(page, 'teil1.pdf', 2);
  await putPdf(page, 'teil2.pdf', 1);
  await putImage(page, 'anhang.png');
  await page.evaluate(() => window.__pdfprepare.refresh());
  await expect.poll(() => page.locator('.prep-item').count()).toBe(3);

  await page.click('#prepSelectAll');
  await expect(page.locator('#prepSelInfo')).toContainText('zusammengeführt');
  await page.click('#prepOpenBtn');

  // Eine Datei in der Arbeitsliste mit 2 + 1 + 1 = 4 Seiten
  await expect(page.locator('.file-item')).toHaveCount(1, { timeout: 30000 });
  const info = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const item = window.__pdfpresser.items[0];
    const doc = await PDFDocument.load(await item.file.arrayBuffer());
    return { pages: doc.getPageCount(), sources: item.file.rawSources, name: item.file.name };
  });
  expect(info.pages).toBe(4);
  expect(info.sources.length).toBe(3);
  expect(info.name).toContain('Sammlung');
});

test('Standardstufe wird beim Übernehmen angewendet', async ({ page }) => {
  await ready(page);
  await clearRaw(page);
  await putPdf(page, 'einzeln.pdf');
  await page.evaluate(() => window.__pdfprepare.refresh());
  await expect.poll(() => page.locator('.prep-item').count()).toBe(1);

  // Standard auf „Extrem S/W“ + OCR stellen, davor bewusst etwas anderes wählen
  await page.locator('input[name="preset"][value="mittel"]').check();
  await page.selectOption('#prepPreset', 'extrem-sw');
  await page.uncheck('#prepOcr');

  await page.click('.prep-item input');
  await page.click('#prepOpenBtn');
  await expect(page.locator('.file-item')).toHaveCount(1, { timeout: 30000 });

  expect(await page.locator('input[name="preset"][value="extrem-sw"]').isChecked()).toBe(true);
  expect(await page.locator('#ocrEnabled').isChecked()).toBe(false);
});

test('Nach der Übergabe an Paperless wird das Aufräumen angeboten', async ({ page }) => {
  await ready(page);
  await clearRaw(page);
  await putPdf(page, 'fertig.pdf');
  await page.evaluate(() => window.__pdfprepare.refresh());
  await expect.poll(() => page.locator('.prep-item').count()).toBe(1);

  await page.click('.prep-item input');
  await page.click('#prepOpenBtn');
  await expect(page.locator('.file-item')).toHaveCount(1, { timeout: 30000 });

  // Ohne Kompression direkt übergeben: Ergebnis setzen und senden
  await page.evaluate(async () => {
    const it = window.__pdfpresser.items[0];
    it.result = new Uint8Array(await it.file.arrayBuffer());
  });

  // Rückfrage bejahen
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => window.__pdfpresser.saveItemToPaperless(window.__pdfpresser.items[0], { quiet: true }));

  // Datei liegt bei Paperless und ist aus dem Sammelordner verschwunden
  await expect.poll(async () => {
    const r = await page.evaluate(async () => (await (await fetch('/api/raw', { cache: 'no-store' })).json()).files.length);
    return r;
  }, { timeout: 20000 }).toBe(0);
});

test('Aufräumen wird übersprungen, wenn man ablehnt', async ({ page }) => {
  await ready(page);
  await clearRaw(page);
  await putPdf(page, 'behalten.pdf');
  await page.evaluate(() => window.__pdfprepare.refresh());
  await expect.poll(() => page.locator('.prep-item').count()).toBe(1);

  await page.click('.prep-item input');
  await page.click('#prepOpenBtn');
  await expect(page.locator('.file-item')).toHaveCount(1, { timeout: 30000 });
  await page.evaluate(async () => {
    const it = window.__pdfpresser.items[0];
    it.result = new Uint8Array(await it.file.arrayBuffer());
  });

  page.once('dialog', (d) => d.dismiss());
  await page.evaluate(() => window.__pdfpresser.saveItemToPaperless(window.__pdfpresser.items[0], { quiet: true }));
  await page.waitForTimeout(600);

  const n = await page.evaluate(async () => (await (await fetch('/api/raw', { cache: 'no-store' })).json()).files.length);
  expect(n, 'Datei bleibt im Sammelordner').toBe(1);
});

test('Ohne RAW-Ordner bleibt der Bereich unsichtbar', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser);
  // /api/config so beantworten, als wäre kein RAW-Ordner konfiguriert
  await page.route('**/api/config', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ scanner: false, consume: true, profile: false, raw: false, version: 3 }),
    });
  });
  await page.reload();
  await page.waitForFunction(() => window.__pdfpresser);
  await page.waitForTimeout(700);
  await expect(page.locator('#prepSection')).toBeHidden();
});
