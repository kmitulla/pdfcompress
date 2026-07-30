// Seitenverwaltung im Editor: Seiten nachträglich hinzufügen (Scan/Kamera/
// Fotos), entfernen, umsortieren und auf A4 skalieren. Plus Wachhalten beim
// Stapel-Scan.
import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
  await page.waitForTimeout(900);   // Serverprofil abwarten
}

/** Zweiseitiges PDF in die Liste legen und den Editor öffnen */
async function openEditorWith(page, pages = 2) {
  const bytes = await page.evaluate(async (n) => {
    const { PDFDocument, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    for (let i = 0; i < n; i++) {
      const p = doc.addPage([595.28, 841.89]);
      p.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(1, 1, 1) });
      p.drawRectangle({ x: 60, y: 700 - i * 40, width: 300, height: 20, color: rgb(0.1, 0.1, 0.1) });
    }
    return Array.from(await doc.save());
  }, pages);
  await page.setInputFiles('#fileInput', { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.click('.btn-edit');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();
  await page.click('#edPagesBtn');
  await expect(page.locator('.ed-pagegrid')).toBeVisible();
  // Die Miniaturen werden asynchron gezeichnet – erst abwarten.
  await expect(page.locator('.ed-pagecell').first()).toBeVisible();
  await expect.poll(() => page.locator('.ed-pagecell').count()).toBe(pages);
}

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

test('Seiten lassen sich nachträglich aus Fotos/Dateien hinzufügen', async ({ page }) => {
  await ready(page);
  await openEditorWith(page, 2);
  expect(await page.locator('.ed-pagecell').count()).toBe(2);

  await page.setInputFiles('#edPagePhotoInput', [
    { name: 'a.png', mimeType: 'image/png', buffer: await imageBuffer(page, '#3366aa') },
    { name: 'b.png', mimeType: 'image/png', buffer: await imageBuffer(page, '#aa3333') },
  ]);
  await expect.poll(() => page.locator('.ed-pagecell').count(), { timeout: 20000 }).toBe(4);
  await expect(page.locator('.ed-pagecell').nth(2)).toContainText('(Bild)');

  // Übernehmen: das Ergebnis hat vier Seiten, die neuen sind A4
  await page.click('#edPagesClose');
  await page.click('#edApply');
  await expect(page.locator('.file-status')).toContainText('Bearbeitet', { timeout: 40000 });
  const sizes = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.load(window.__pdfpresser.items[0].editedBytes.slice());
    return doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return [Math.round(width), Math.round(height)];
    });
  });
  expect(sizes.length).toBe(4);
  expect(sizes[2]).toEqual([595, 842]);
  expect(sizes[3]).toEqual([595, 842]);

  // Und die neuen Seiten zeigen das Bild wirklich (nicht nur leeres A4)
  const farbig = await page.evaluate(async () => {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    const doc = await pdfjs.getDocument({ data: window.__pdfpresser.items[0].editedBytes.slice() }).promise;
    const p = await doc.getPage(3);
    const vp = p.getViewport({ scale: 0.5 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: cx, viewport: vp }).promise;
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let bunt = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 30) bunt++;
    }
    await doc.destroy();
    return bunt / (c.width * c.height);
  });
  expect(farbig, 'Bild ist auf der neuen Seite sichtbar').toBeGreaterThan(0.2);
});

test('Kamera-Aufnahme ist als Seitenquelle vorgesehen', async ({ page }) => {
  await ready(page);
  await openEditorWith(page, 1);
  // Das Eingabefeld fordert ausdrücklich die Kamera an
  await expect(page.locator('#edAddCam')).toBeVisible();
  expect(await page.locator('#edPageCamInput').getAttribute('capture')).toBe('environment');
  expect(await page.locator('#edPageCamInput').getAttribute('accept')).toContain('image/');

  await page.setInputFiles('#edPageCamInput', {
    name: 'foto.png', mimeType: 'image/png', buffer: await imageBuffer(page),
  });
  await expect.poll(() => page.locator('.ed-pagecell').count(), { timeout: 20000 }).toBe(2);
});

test('Seiten entfernen und umsortieren wirkt sich auf das Ergebnis aus', async ({ page }) => {
  await ready(page);
  await openEditorWith(page, 3);
  expect(await page.locator('.ed-pagecell').count()).toBe(3);

  // Erste Seite nach hinten schieben
  await page.locator('.ed-pagecell').nth(0).locator('.btn[aria-label="Nach hinten schieben"]').click();
  // Danach die (jetzt) erste Seite löschen
  await page.locator('.ed-pagecell').nth(0).locator('.btn[aria-label="Seite löschen"]').click();
  await expect.poll(() => page.locator('.ed-pagecell').count()).toBe(2);

  await page.click('#edPagesClose');
  await page.click('#edApply');
  await expect(page.locator('.file-status')).toContainText('Bearbeitet', { timeout: 40000 });
  const n = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.load(window.__pdfpresser.items[0].editedBytes.slice());
    return doc.getPageCount();
  });
  expect(n).toBe(2);
});

test('„Alle auf A4 skalieren“ bringt abweichende Seiten auf A4', async ({ page }) => {
  await ready(page);
  // Ein PDF mit zwei ungewöhnlichen Seitengrößen
  const bytes = await page.evaluate(async () => {
    const { PDFDocument, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.addPage([400, 900]).drawRectangle({ x: 20, y: 20, width: 100, height: 60, color: rgb(0, 0, 0) });
    doc.addPage([700, 500]).drawRectangle({ x: 20, y: 20, width: 100, height: 60, color: rgb(0, 0, 0) });
    return Array.from(await doc.save());
  });
  await page.setInputFiles('#fileInput', { name: 'krumm.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.click('.btn-edit');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();
  await page.click('#edPagesBtn');
  await expect(page.locator('.ed-pagecell').first()).toBeVisible();
  await page.click('#edAllA4');
  await expect(page.locator('.ed-pagecell').first()).toContainText('A4');

  await page.click('#edPagesClose');
  await page.click('#edApply');
  await expect(page.locator('.file-status')).toContainText('Bearbeitet', { timeout: 40000 });
  const sizes = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.load(window.__pdfpresser.items[0].editedBytes.slice());
    return doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return [Math.round(width), Math.round(height)];
    });
  });
  for (const s of sizes) expect(s).toEqual([595, 842]);
});

test('Stapel-Scan hält das Gerät wach und übersteht eine Unterbrechung', async ({ page }) => {
  await ready(page);

  // Wake-Lock-Anfragen mitzählen (im Testbrowser über http nicht vorhanden –
  // deshalb hier nachbilden, um die Verwendung zu prüfen)
  await page.evaluate(() => {
    window.__wakeCalls = 0;
    // Ueber http gibt es die Schnittstelle nicht – fuer den Test nachbilden.
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => { window.__wakeCalls++; return { release() {}, addEventListener() {} }; },
      },
    });
  });

  let calls = 0;
  const imgBytes = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 560;
    const x = c.getContext('2d');
    x.fillStyle = '#8a8a8a'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff'; x.fillRect(0, 0, 388, 546);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  const body = Buffer.from(imgBytes);
  // Erster Scan gelingt, der zweite scheitert einmal (wie nach dem Aufwachen),
  // danach geht es weiter – der Stapel darf deswegen nicht abbrechen.
  await page.route('**/api/scanner/scan*', async (route) => {
    calls++;
    if (calls === 2) {
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"kurz weg"}' });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'image/png', 'X-Scan-Dpi': '100' }, body });
  });

  await page.evaluate(() => {
    document.querySelector('#netScanSettings').classList.remove('hidden');
    document.querySelector('#netScanBtn').classList.remove('hidden');
    document.querySelector('#scanPages').value = '3';
    document.querySelector('#scanDelay').value = '1';
  });
  await page.click('#netScanBtn');

  // Trotz des Fehlversuchs kommen drei Seiten zustande (ein Versuch mehr)
  await expect(page.locator('#scPagesView')).toBeVisible({ timeout: 40000 });
  await expect.poll(() => page.locator('.sc-pagecell').count(), { timeout: 40000 }).toBe(3);
  expect(calls, 'der Fehlversuch wurde wiederholt').toBe(4);

  // Wachhalten wurde angefordert
  expect(await page.evaluate(() => window.__wakeCalls)).toBeGreaterThan(0);
});
