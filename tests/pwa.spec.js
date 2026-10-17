// PWA: Manifest, Icons, Service Worker, Offline-Betrieb inklusive Kompression.
import { test, expect } from '@playwright/test';
import { ready } from './helpers.js';

test('Manifest, Icons und Offline-Betrieb mit Kompression', async ({ page, context }) => {
  await ready(page);
  const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const ok = await page.evaluate(async (src) => (await fetch(src)).ok, icon.src);
    expect(ok, icon.src).toBe(true);
  }
  // Service Worker aktiv und Cache mit Versionskennung angelegt
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', null, { timeout: 60000 });
  const caches = await page.evaluate(async () => (await window.caches.keys()));
  const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
  expect(caches).toContain(`pdfpresser-${cfg.version}`);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.locator('#statusOffline')).toBeVisible();

  // Offline: App lädt aus dem Cache und komprimiert weiterhin
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
  const size = await page.evaluate(async () => {
    const { PDFDocument, StandardFonts } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText('offline', { x: 50, y: 700, size: 30, font });
    const out = await window.__pdfpresser.compressPdf(await doc.save(), window.__pdfpresser.PRESETS['extrem-sw']);
    return out.length;
  });
  expect(size).toBeGreaterThan(300);
  await context.setOffline(false);
});
