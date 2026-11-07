// Zoomen in Dokumenten: nur das Dokument wird größer, nie die ganze Seite.
// Vorschau (Rechner & Handy) und große Seitenvorschau im Scan-Studio.
import { test, expect, devices } from '@playwright/test';
import { ready, addTestPdf, photoJpeg } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const zs = (page) => page.evaluate(() => ({ ...window.__pdfpresser.viewerZoom }));
const naturalW = (page) => page.evaluate(() => document.querySelector('#viewerImg').naturalWidth);

async function openViewer(page) {
  await addTestPdf(page, { pages: 3 });
  if ((page.viewportSize()?.width || 1200) < 1180) {
    await page.click('.doc');
    await expect(page.locator('#inspector')).toHaveClass(/open/);
    await page.waitForTimeout(350);
  }
  await page.click('#inspector [data-act="preview"]');
  await expect(page.locator('#viewer')).toBeVisible();
  await expect.poll(() => naturalW(page), { timeout: 30000 }).toBeGreaterThan(100);
  await page.waitForTimeout(200);
}

/** Zwei echte Touch-Finger (Pinch) über das Chrome-Protokoll */
async function pinch(page, cx, cy, from, to, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (d) => [{ x: cx - d / 2, y: cy, id: 0 }, { x: cx + d / 2, y: cy, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / steps) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('Vorschau am Rechner: Strg+Mausrad (Trackpad-Pinch) zoomt zum Zeiger, Ziehen verschiebt, scharf nachgerendert', async ({ page }) => {
  await ready(page);
  await openViewer(page);
  // Original-Ansicht: wird beim Zoomen schärfer nachgerendert
  await page.click('#viewerMode button[data-v="original"]');
  await page.waitForTimeout(400);
  const w0 = await naturalW(page);
  await expect(page.locator('#viewerZoomLabel')).toHaveText('100 %');
  await expect(page.locator('#viewerZoomOut')).toBeDisabled();
  const box = await page.locator('#viewerStage').boundingBox();
  // links oben in die Seite zoomen
  const px = box.x + box.width * 0.35;
  const py = box.y + box.height * 0.25;
  await page.mouse.move(px, py);
  await page.keyboard.down('Control');
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -60);
  await page.keyboard.up('Control');
  let z = await zs(page);
  expect(z.zoom).toBeGreaterThan(2);
  // Der Punkt unter dem Zeiger bleibt (ungefähr) stehen
  const docX = (px - box.x - z.tx) / z.zoom;
  expect(docX).toBeGreaterThan(0);
  expect(docX).toBeLessThan(z.fitW);
  // Nur das Dokument ist gezoomt, nicht die Seite
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
  await expect(page.locator('#viewerZoomLabel')).not.toHaveText('100 %');
  // schärfer nachgerendert
  await expect.poll(() => naturalW(page), { timeout: 30000 }).toBeGreaterThan(w0 * 1.5);

  // Ziehen verschiebt
  const before = await zs(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  z = await zs(page);
  expect(z.tx).not.toBeCloseTo(before.tx, 0);

  // Mausrad ohne Strg verschiebt nur
  const zz = z.zoom;
  await page.mouse.wheel(0, 120);
  expect((await zs(page)).zoom).toBeCloseTo(zz, 5);

  // Klick auf die Prozentanzeige: ganze Seite
  await page.click('#viewerZoomLabel');
  expect((await zs(page)).zoom).toBe(1);
  await expect(page.locator('#viewerZoomLabel')).toHaveText('100 %');
});

test('Vorschau: Knöpfe, Tasten +/−/0, Doppelklick; ungezoomt blättert Wischen/Scrollen', async ({ page }) => {
  await ready(page);
  await openViewer(page);
  await page.click('#viewerZoomIn');
  expect((await zs(page)).zoom).toBeCloseTo(1.5, 5);
  await page.keyboard.press('+');
  expect((await zs(page)).zoom).toBeCloseTo(2.25, 5);
  await page.keyboard.press('0');
  expect((await zs(page)).zoom).toBe(1);
  const box = await page.locator('#viewerStage').boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  expect((await zs(page)).zoom).toBeCloseTo(2.5, 5);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  expect((await zs(page)).zoom).toBe(1);
  // Wischen blättert (nur ungezoomt)
  await expect(page.locator('#viewerPage')).toHaveText('1 / 3');
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#viewerPage')).toHaveText('2 / 3');
  await page.mouse.wheel(0, 200);
  await expect(page.locator('#viewerPage')).toHaveText('3 / 3');
  // Neue Seite beginnt wieder ungezoomt
  expect((await zs(page)).zoom).toBe(1);
});

test('Handy: zwei Finger zoomen nur das Dokument, ein Finger verschiebt, Doppeltipp zurück', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await ready(page);
  await openViewer(page);
  const box = await page.locator('#viewerStage').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await pinch(page, cx, cy, 80, 260);
  let z = await zs(page);
  expect(z.zoom).toBeGreaterThan(2.5);
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);   // Seite selbst nicht gezoomt
  // ein Finger verschiebt
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 0 }] });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + i * 12, y: cy + i * 10, id: 0 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const z2 = await zs(page);
  expect(z2.tx).toBeGreaterThan(z.tx + 20);
  expect(z2.zoom).toBeCloseTo(z.zoom, 5);
  // Doppeltipp → ganze Seite
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(60);
  await page.touchscreen.tap(cx, cy);
  expect((await zs(page)).zoom).toBe(1);
  // Pinch zum Verkleinern geht nie unter „ganze Seite“
  await pinch(page, cx, cy, 260, 60);
  expect((await zs(page)).zoom).toBe(1);
  await cdp.detach();
  await ctx.close();
});

test('Scan-Studio: große Seitenvorschau lässt sich zoomen', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await ready(page);
  const jpeg = await photoJpeg(page, 1200, 900);
  await page.evaluate(async (arr) => {
    const f = new File([new Uint8Array(arr)], 'foto.jpg', { type: 'image/jpeg' });
    await window.__pdfpresser.openStudio({ files: [f] });
  }, Array.from(jpeg));
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(1, { timeout: 20000 });
  await page.click('.sc-thumb');
  await expect(page.locator('#scPreviewStage canvas')).toHaveCount(1);
  const box = await page.locator('#scPreviewStage').boundingBox();
  const tf = () => page.evaluate(() => document.querySelector('#scPreviewStage canvas').style.transform);
  expect(await tf()).toContain('scale(1)');
  await pinch(page, box.x + box.width / 2, box.y + box.height / 2, 80, 240);
  const m = /scale\(([\d.]+)\)/.exec(await tf());
  expect(parseFloat(m[1])).toBeGreaterThan(2);
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
  await ctx.close();
});
