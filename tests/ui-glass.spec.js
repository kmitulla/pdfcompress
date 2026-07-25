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
  // Erst verzögerte Uploads vorheriger Tests einlaufen lassen – der Server ist
  // über alle Tests hinweg derselbe.
  await page.waitForTimeout(1500);

  // Unterschrift lokal ablegen -> wird gebündelt zum Server hochgeschoben
  await page.evaluate(async () => {
    const { kvSet } = await import('/js/store.js');
    await kvSet('signatures', [{ id: 'sigTest', created: 1, kind: 'draw' }]);
  });

  await expect.poll(
    async () => page.evaluate(async () => {
      const p = await (await fetch('/api/profile', { cache: 'no-store' })).json();
      return (p.signatures || []).map((s) => s.id);
    }),
    { timeout: 10000, message: 'Unterschrift erscheint im Serverprofil' },
  ).toContain('sigTest');

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

// Regression: Icon-Markup darf nie als Text in der Oberfläche landen
// (passiert, wenn SVG per textContent statt innerHTML gesetzt wird).
async function assertNoRawMarkup(page, scope) {
  const text = await page.locator(scope).innerText();
  for (const needle of ['<svg', 'viewBox', 'stroke-linecap', '<path']) {
    expect(text, `rohes Markup „${needle}“ sichtbar in ${scope}`).not.toContain(needle);
  }
}

test('Scanner-Seitenübersicht zeigt Icons, kein rohes SVG-Markup', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // Ein einfaches Bild in den Scanner geben
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 420;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 300, 420);
    ctx.fillStyle = '#f2efe6'; ctx.fillRect(30, 40, 240, 340);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    return Array.from(buf);
  });

  await page.click('#scanBtn');
  await expect(page.locator('#scannerRoot .sc-overlay')).toBeVisible();
  await page.setInputFiles('#scFileInput', {
    name: 'seite.png', mimeType: 'image/png', buffer: Buffer.from(png),
  });
  await expect(page.locator('#scCropView')).toBeVisible();
  await page.click('#scCropOkBtn');
  await expect(page.locator('#scPagesView')).toBeVisible();

  // Seitenleiste der Miniatur: Buttons müssen echte SVGs enthalten
  const barButtons = page.locator('.sc-pagecell-bar .btn');
  expect(await barButtons.count()).toBeGreaterThan(3);
  expect(await page.locator('.sc-pagecell-bar .btn svg').count()).toBeGreaterThan(3);

  // ... und nirgends darf Markup als Text zu sehen sein
  await assertNoRawMarkup(page, '#scannerRoot');
  await expect(page.locator('#scDoneBtn')).toContainText('Als PDF übernehmen (1 Seite)');
  expect(await page.locator('#scDoneBtn svg').count()).toBe(1);
});

test('Editor-Seitenverwaltung zeigt Icons, kein rohes SVG-Markup', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // Minimales PDF erzeugen und in die Liste legen
  const bytes = await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]);
    return Array.from(await doc.save());
  });
  await page.setInputFiles('#fileInput', {
    name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes),
  });
  await page.click('.btn-edit');
  await expect(page.locator('#editorRoot .ed-overlay')).toBeVisible();
  await page.click('#edPagesBtn');
  await expect(page.locator('.ed-pagegrid')).toBeVisible();

  expect(await page.locator('.ed-pagecell-bar .btn svg').count()).toBeGreaterThan(4);
  await assertNoRawMarkup(page, '#editorRoot');
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
