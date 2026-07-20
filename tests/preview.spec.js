// Tests für die Vorschau: durch Seiten blättern und einzelnen Seiten eigene
// Kompressionsstufen (inkl. S/W-Abgleich) zuweisen.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
}

// Buntes 2-Seiten-PDF (JPEG-Hintergrund + Text) im Browser erzeugen
const MAKE_TEST_PDF = `
async function makeTestPdf(numPages, imgW, imgH) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const canvas = document.createElement('canvas');
  canvas.width = imgW; canvas.height = imgH;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, imgW, imgH);
  grad.addColorStop(0, '#ff8844'); grad.addColorStop(0.5, '#4488ff'); grad.addColorStop(1, '#22cc66');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, imgW, imgH);
  const jpegBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await doc.embedJpg(jpegBytes);
  for (let p = 0; p < numPages; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    page.drawRectangle({ x: 40, y: 700, width: 515, height: 100, color: rgb(1, 1, 1) });
    page.drawText('Seite ' + (p + 1), { x: 60, y: 740, size: 40, font, color: rgb(0, 0, 0) });
  }
  return await doc.save();
}
`;

test('Vorschau: Seiten blättern & Seiten-individuelle Kompression', async ({ page }) => {
  await ready(page);

  const b64 = await page.evaluate(async (src) => {
    // eslint-disable-next-line no-eval
    eval(src);
    const bytes = await makeTestPdf(2, 700, 990);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(s);
  }, MAKE_TEST_PDF);
  await page.setInputFiles('#fileInput', {
    name: 'zweiseiten.pdf', mimeType: 'application/pdf', buffer: Buffer.from(b64, 'base64'),
  });

  // Blättern: 1/2 -> 2/2, Grenzen deaktivieren die Buttons
  await page.click('#previewBtn');
  await expect(page.locator('#previewPageInfo')).toHaveText('1/2');
  await expect(page.locator('#prevPageBtn')).toBeDisabled();
  await page.click('#nextPageBtn');
  await expect(page.locator('#previewPageInfo')).toHaveText('2/2');
  await expect(page.locator('#previewInfo')).toContainText('Seite 2/2', { timeout: 30000 });
  await expect(page.locator('#nextPageBtn')).toBeDisabled();

  // Seite 2 bekommt „Extrem S/W“ samt Helligkeitsregler
  await page.selectOption('#pageOverrideSel', 'extrem-sw');
  await expect(page.locator('#pageBiasWrap')).toBeVisible();
  await expect(page.locator('#overrideSummary')).toContainText('1 Seite');
  await expect(page.locator('#previewInfo')).toContainText('eigene Seiten-Einstellung', { timeout: 30000 });

  // Zurück auf Seite 1: dort gilt weiter die globale Einstellung
  await page.click('#prevPageBtn');
  await expect(page.locator('#previewPageInfo')).toHaveText('1/2');
  expect(await page.locator('#pageOverrideSel').inputValue()).toBe('');

  // Komprimieren (global „Mittel“): Seite 1 bleibt bunt, Seite 2 wird S/W
  await page.click('#startBtn');
  await expect(page.locator('.file-item .file-status')).toContainText('Fertig', { timeout: 120000 });
  const colorFracs = await page.evaluate(async () => {
    const item = window.__pdfpresser.items[0];
    const bytes = new Uint8Array(item.result);
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const numPages = doc.numPages;
    const fracs = [];
    for (let n = 1; n <= numPages; n++) {
      const p = await doc.getPage(n);
      const vp = p.getViewport({ scale: 0.4 });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let colored = 0;
      const total = c.width * c.height;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx - mn > 40) colored++;
      }
      fracs.push(colored / total);
    }
    await doc.destroy();
    return { pages: numPages, fracs };
  });
  expect(colorFracs.pages).toBe(2);
  expect(colorFracs.fracs[0]).toBeGreaterThan(0.2);  // global Mittel: bunt
  expect(colorFracs.fracs[1]).toBeLessThan(0.01);    // Override Extrem S/W: unbunt
});
