// Oberfläche: Icon-System (keine Emojis), Rückmeldungen, Backend-Funktionen.
import { test, expect } from '@playwright/test';

// Wartet, bis app.js initialisiert ist
async function ready(page) {
  await page.waitForFunction(() => !!window.__pdfpresser, null, { timeout: 15000 });
}

test('Oberfläche lädt, Icons ersetzt, keine Emojis, keine Skriptfehler', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await ready(page);
  await expect(page.locator('h1')).toHaveText(/PDF\s*Presser/);

  // Alle Icon-Platzhalter wurden durch echte SVGs ersetzt
  expect(await page.locator('[data-icon]:not([data-icon-done])').count()).toBe(0);
  expect(await page.locator('.icn').count()).toBeGreaterThan(10);

  // Kein Emoji mehr im sichtbaren Text
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

  expect(errors, `Skriptfehler: ${errors.join(' | ')}`).toEqual([]);
});

test('Liquid-Glass-Materialien sind aktiv', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const blur = await page.locator('.panel').first().evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(blur).toContain('blur');
});

test('Rückmeldung (Toast) erscheint und verschwindet wieder', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => window.__pdfpresser.toast('Testmeldung', 'ok', 700));
  await expect(page.locator('.toast')).toContainText('Testmeldung');
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 5000 });
});

test('Backend meldet Funktionen; Paperless-Bedienelemente erscheinen', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
  expect(cfg.consume).toBe(true);   // CONSUME_DIR ist im Test gesetzt
  expect(cfg.profile).toBe(true);   // DATA_DIR ist beschreibbar
  // Kein SCANNER_HOST im Test → Netzwerk-Kachel bleibt aus
  expect(cfg.scanner).toBe(false);
  await expect(page.locator('#autoPaperlessField')).toBeVisible();
  await expect(page.locator('#syncRow')).toBeVisible();
  await expect(page.locator('#netScanBtn')).toBeHidden();
});

test('Serverprofil: Unterschrift landet auf dem Server und kommt im neuen Browser an', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  // Unterschrift lokal ablegen -> wird zum Server hochgeschoben
  await page.evaluate(async () => {
    const { kvSet } = await import('/js/store.js');
    await kvSet('signatures', [{ id: 'sigTest', created: 1, kind: 'draw' }]);
  });
  await page.waitForTimeout(1600); // gebündeltes Hochladen abwarten

  const stored = await page.evaluate(async () => (await fetch('/api/profile')).json());
  expect(stored.signatures?.[0]?.id).toBe('sigTest');

  // Frischer Browser-Kontext (leere IndexedDB) muss den Serverstand bekommen
  const ctx = await page.context().browser().newContext();
  const p2 = await ctx.newPage();
  await p2.goto('/');
  await p2.waitForFunction(() => !!window.__pdfpresser);
  await p2.waitForTimeout(1200);
  const sigs = await p2.evaluate(async () => {
    const { listSignatures } = await import('/js/store.js');
    return listSignatures();
  });
  expect(sigs.map((s) => s.id)).toContain('sigTest');
  await ctx.close();
});

test('An Paperless senden legt die Datei im überwachten Ordner ab', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const send = (name) => page.evaluate(async (n) => {
    const body = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const r = await fetch(`/api/save?name=${encodeURIComponent(n)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body,
    });
    return { status: r.status, data: await r.json() };
  }, name);

  // Normaler Name bleibt lesbar (Leerzeichen erlaubt)
  const ok = await send('Rechnung Stadtwerke.pdf');
  expect(ok.status).toBe(200);
  expect(ok.data.name).toBe('Rechnung Stadtwerke.pdf');

  // Pfad-Ausbrüche werden entschärft: nur der Dateiname bleibt übrig
  const evil = await send('../../etc/passwd.pdf');
  expect(evil.status).toBe(200);
  expect(evil.data.name).toBe('passwd.pdf');
  expect(evil.data.name).not.toContain('/');

  // Endung wird immer erzwungen
  const noExt = await send('ohne-endung');
  expect(noExt.data.name).toBe('ohne-endung.pdf');
});
