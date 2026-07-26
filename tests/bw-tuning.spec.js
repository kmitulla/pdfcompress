// S/W-Feinsteuerung: dunkle Flächen, Kontrast – und die Scannerauflösung.
import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
}

// Baut ein PDF mit einer dunklen, ungleichmäßig ausgeleuchteten Aufnahme:
// heller Textbereich in der Mitte, dunkler verrauschter Rand ringsum – genau
// die Situation, in der bisher der ganze Rand schwarz zulief.
const MAKE_DIM_PHOTO = `
async function makeDimPhoto() {
  const W = 900, H = 1200;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  // Grundton wie bei der echten Aufnahme gemessen: Textbereich um 145,
  // Ränder um 96 – also eine insgesamt dunkle Aufnahme mit Vignette.
  const g = x.createRadialGradient(W/2, H/2, 40, W/2, H/2, W*0.62);
  g.addColorStop(0, '#96969a');     // ~150
  g.addColorStop(0.6, '#8a8a8e');   // ~139
  g.addColorStop(1, '#4e4e52');     // ~79
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // Bildrauschen wie bei einer Handyaufnahme
  const img = x.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 46;
    img.data[i] += n; img.data[i+1] += n; img.data[i+2] += n;
  }
  x.putImageData(img, 0, 0);
  // Text in der Mitte
  x.fillStyle = '#141414';
  for (let i = 0; i < 14; i++) x.fillRect(220, 260 + i * 48, 460, 13);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { PDFDocument } = window.PDFLib;
  const doc = await PDFDocument.create();
  const jpg = await doc.embedJpg(bytes);
  doc.addPage([595.28, 841.89]).drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return await doc.save();
}
// Schwarzanteil in einem Bereich des Ergebnisses messen
async function darkFractions(bytes) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
  const d = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const p = await d.getPage(1);
  const vp = p.getViewport({ scale: 1 });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: cx, viewport: vp }).promise;
  const px = cx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const frac = (x0, y0, x1, y1) => {
    let n = 0, t = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { t++; if (px[(y*W+x)*4] < 128) n++; }
    return n / t;
  };
  const r = {
    randLinks: frac(0, 0, Math.round(W*0.06), H),
    randUnten: frac(0, Math.round(H*0.94), W, H),
    text: frac(Math.round(W*0.2), Math.round(H*0.18), Math.round(W*0.82), Math.round(H*0.86)),
  };
  await d.destroy();
  return r;
}
`;

test('Dunkle Aufnahme: Rand läuft nicht mehr schwarz zu, Text bleibt', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async (src) => {
    // eslint-disable-next-line no-eval
    eval(src);
    const pdf = await makeDimPhoto();
    const { compressPdf } = window.__pdfpresser;
    const run = async (o) => darkFractions(
      await compressPdf(pdf.buffer.slice(0), { mode: 'raster', colorMode: 'bw', dpi: 200, ...o }),
    );
    return {
      auto: await run({ darkAreas: 'auto' }),
      invert: await run({ darkAreas: 'invert' }),
      ignore: await run({ darkAreas: 'ignore' }),
    };
  }, MAKE_DIM_PHOTO);

  // Automatik erkennt die dunkle Aufnahme: Rand bleibt weitgehend weiß
  expect(res.auto.randLinks, 'linker Rand läuft nicht zu').toBeLessThan(0.3);
  expect(res.auto.randUnten, 'unterer Rand läuft nicht zu').toBeLessThan(0.3);
  // Der Text ist trotzdem da
  expect(res.auto.text, 'Text bleibt erhalten').toBeGreaterThan(0.01);

  // Erzwungene Inversion zeigt das alte Verhalten – der Regler wirkt also
  expect(res.invert.randLinks).toBeGreaterThan(res.auto.randLinks + 0.2);

  // „Ignorieren“ entspricht hier der Automatik
  expect(res.ignore.randLinks).toBeLessThan(0.3);
});

test('Kontrastregler steuert, wie viel als Text gewertet wird', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async (src) => {
    // eslint-disable-next-line no-eval
    eval(src);
    const pdf = await makeDimPhoto();
    const { compressPdf } = window.__pdfpresser;
    const run = async (contrast) => darkFractions(
      await compressPdf(pdf.buffer.slice(0), { mode: 'raster', colorMode: 'bw', dpi: 200, contrast }),
    );
    return { minus: await run(-40), null: await run(0), plus: await run(40) };
  }, MAKE_DIM_PHOTO);

  // Mehr Kontrast = mehr Tinte, weniger Kontrast = weniger
  expect(res.plus.text).toBeGreaterThan(res.null.text);
  expect(res.minus.text).toBeLessThan(res.null.text);
  // Und der Rand bleibt bei negativem Kontrast am saubersten
  expect(res.minus.randLinks).toBeLessThanOrEqual(res.plus.randLinks);
});

test('Scanner-Auflösung und Farbmodus werden an den Scanner übergeben', async ({ page }) => {
  await ready(page);

  // Anfragen abfangen, damit kein echter Scanner nötig ist
  const calls = [];
  await page.route('**/api/scanner/scan*', async (route) => {
    calls.push(route.request().url());
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Testlauf"}' });
  });

  await page.evaluate(() => {
    // Bedienelemente einblenden, als wäre ein Scanner konfiguriert
    document.querySelector('#netScanSettings').classList.remove('hidden');
    document.querySelector('#scanDpi').value = '600';
    document.querySelector('#scanColor').value = 'gray';
  });

  await page.evaluate(() => window.__pdfpresser.fetchScannedPage().catch(() => {}));
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  expect(calls[0]).toContain('dpi=600');
  expect(calls[0]).toContain('color=gray');
});

test('Neue S/W-Einstellungen erscheinen nur im Schwarz-Weiß-Modus', async ({ page }) => {
  await ready(page);
  // Mittel (Farbe): keine S/W-Feineinstellungen
  await page.locator('input[name="preset"][value="mittel"]').check();
  await expect(page.locator('#contrastField')).toBeHidden();
  await expect(page.locator('#darkAreasField')).toBeHidden();

  // Extrem S/W: Helligkeit, Kontrast und dunkle Flächen sind da
  await page.locator('input[name="preset"][value="extrem-sw"]').check();
  await expect(page.locator('#biasField')).toBeVisible();
  await expect(page.locator('#contrastField')).toBeVisible();
  await expect(page.locator('#darkAreasField')).toBeVisible();

  // Extrem Farbe: Helligkeit ja, S/W-Feinsteuerung nein
  await page.locator('input[name="preset"][value="extrem-farbe"]').check();
  await expect(page.locator('#biasField')).toBeVisible();
  await expect(page.locator('#contrastField')).toBeHidden();
});
