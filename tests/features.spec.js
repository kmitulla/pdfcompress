// Neue Funktionen 2.4: Paperless-Angaben beim Senden, Namensvorschlag,
// Entfernen mit Rückgängig, Aufteilen (auch an leeren Seiten), leere Seiten im
// Studio, Suche & Filter.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ready } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** PDF mit Text im Browser bauen und als Dokument anlegen */
async function addTextPdf(page, name, lines, { pages = 1, blankPages = [] } = {}) {
  return page.evaluate(async ({ name, lines, pages, blankPages }) => {
    const { PDFDocument, StandardFonts } = window.PDFLib;
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let p = 1; p <= pages; p++) {
      const pg = d.addPage([595.28, 841.89]);
      if (blankPages.includes(p)) continue;
      lines.forEach((l, i) => pg.drawText(`${l}${pages > 1 ? ` (Seite ${p})` : ''}`, { x: 60, y: 760 - i * 24, size: 16, font: f }));
    }
    const doc = await window.__pdfpresser.addPdfDoc(new Uint8Array(await d.save()), name, { kind: 'scan' });
    return doc.id;
  }, { name, lines, pages, blankPages });
}

test('Vorschläge: Datum und Name aus dem Text', async ({ page }) => {
  await ready(page);
  const r = await page.evaluate(async () => {
    const s = await import('./js/suggest.js');
    return {
      dates: s.findDates('Datum: 03.10.2026, fällig am 1. November 2026, Bestellung 2026-09-30, Unsinn 31.02.2026'),
      t1: s.suggestTitle('Stadtwerke Musterstadt\nRECHNUNG\nRechnungsnummer: 2026-114\nRechnungsdatum 03.10.2026\nBetrag 42,00 EUR'),
      t2: s.suggestTitle('Sehr geehrte Damen und Herren,\nhiermit kündige ich meinen Vertrag zum 31.12.2026 – Kündigung'),
      t3: s.suggestTitle('Lorem ipsum dolor sit amet, ohne erkennbare Art'),
      generic: [s.isGenericName('Scan 2026-11-11 09-41'), s.isGenericName('Scan_2026'), s.isGenericName('Mietvertrag')],
    };
  });
  expect(r.dates).toEqual(['2026-10-03', '2026-11-01', '2026-09-30']);   // 31.02. gibt es nicht
  expect(r.t1).toBe('Rechnung 2026-114 – 2026-10-03');
  expect(r.t2).toMatch(/^(Kündigung|Vertrag)/);
  expect(r.t3).toBeNull();
  expect(r.generic).toEqual([true, true, false]);
});

test('Namensvorschlag im Inspektor übernehmen', async ({ page }) => {
  await ready(page);
  await addTextPdf(page, 'Scan 2026-11-11 09-41', ['RECHNUNG', 'Rechnungsnummer: 2026-114', 'Datum: 03.10.2026', 'Stadtwerke Musterstadt']);
  await expect(page.locator('#inspector .name-suggest')).toContainText('Rechnung 2026-114 – 2026-10-03');
  await page.click('#inspector [data-act="applyName"]');
  await expect(page.locator('#inspName')).toHaveValue('Rechnung 2026-114 – 2026-10-03');
  await expect(page.locator('#inspector .name-suggest')).toHaveCount(0);
  // Bereits benannte Dokumente bekommen keinen Vorschlag
  await addTextPdf(page, 'Mein Brief', ['RECHNUNG Nr. 99', '01.01.2026']);
  await page.waitForTimeout(600);
  await expect(page.locator('#inspector .name-suggest')).toHaveCount(0);
});

test('Entfernen ohne Rückfrage, mit „Rückgängig“', async ({ page }) => {
  await ready(page);
  await addTextPdf(page, 'Wichtig', ['Bitte nicht verlieren']);
  await page.click('#inspector [data-act="remove"]');
  await expect(page.locator('.dlg')).toHaveCount(0);
  await expect(page.locator('.doc')).toHaveCount(0);
  await page.click('.toast .toast-action');
  await expect(page.locator('.doc')).toHaveCount(1);
  await expect(page.locator('.doc .doc-title')).toHaveText('Wichtig.pdf');
});

test('Aufteilen: an leeren Trennblättern, Teile übernehmen Einstellungen, Rückgängig', async ({ page }) => {
  await ready(page);
  await addTextPdf(page, 'Stapel', ['Brief', 'Sehr geehrte Damen und Herren,', 'anbei die Unterlagen.', 'Mit freundlichen Grüßen'], { pages: 5, blankPages: [3] });
  await page.click('#inspector .profile:has(input[value="verlustfrei"])');
  await page.click('#inspector [data-act="split"]');
  await expect(page.locator('#splitSheet')).toHaveClass(/open/);
  await expect(page.locator('.split-page')).toHaveCount(5);
  await expect(page.locator('.split-page.blank')).toHaveCount(1, { timeout: 20000 });
  await expect(page.locator('.split-page.blank')).toHaveAttribute('data-page', '3');
  await page.click('#splitBlank');
  await expect(page.locator('#splitInfo')).toContainText('2 Dokumente');
  await expect(page.locator('#splitInfo')).toContainText('1 weggelassen');
  await page.click('#splitGo');
  await expect(page.locator('.toast', { hasText: 'aufgeteilt' })).toHaveCount(2);
  await expect(page.locator('.doc')).toHaveCount(2);
  const parts = await page.evaluate(() => window.__pdfpresser.state.docs.map((d) => ({ name: d.name, pages: d.pages, profile: d.profile })));
  expect(parts).toEqual([
    { name: 'Stapel – Teil 1', pages: 2, profile: 'verlustfrei' },
    { name: 'Stapel – Teil 2', pages: 2, profile: 'verlustfrei' },
  ]);
  // Rückgängig: wieder das ursprüngliche Dokument
  await page.locator('.toast', { hasText: 'aufgeteilt' }).locator('.toast-action').click();
  await expect(page.locator('.doc')).toHaveCount(1);
  expect(await page.evaluate(() => window.__pdfpresser.state.docs[0].pages)).toBe(5);

  // Manuell: zwischen Seite 1 und 2 trennen, Seite 5 weglassen
  await page.click('#inspector [data-act="split"]');
  await page.click('.split-cut[data-cut="1"]');
  await page.click('.split-page[data-page="5"]');
  await expect(page.locator('#splitInfo')).toContainText('2 Dokumente');
  await page.click('#splitGo');
  await page.waitForFunction(() => window.__pdfpresser.state.docs.length === 2 && !window.__pdfpresser.state.docs.some((d) => d.name === 'Stapel'));
  expect(await page.evaluate(() => window.__pdfpresser.state.docs.map((d) => d.pages))).toEqual([1, 3]);
});

test('Studio: leere Seite wird erkannt und mit einem Tipp entfernt', async ({ page }) => {
  await ready(page);
  const img = async (blank) => Buffer.from(await page.evaluate(async (blank) => {
    const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;
    const x = c.getContext('2d'); x.fillStyle = '#fbfaf7'; x.fillRect(0, 0, 1240, 1754);
    if (!blank) { x.fillStyle = '#222'; for (let i = 0; i < 25; i++) x.fillRect(120, 160 + i * 52, 900, 12); }
    else { x.fillStyle = 'rgba(0,0,0,0.05)'; x.fillRect(0, 0, 30, 1754); }   // leichter Schatten am Rand
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, blank));
  const files = [
    { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await img(false) },
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await img(true) },
    { name: 'c.jpg', mimeType: 'image/jpeg', buffer: await img(false) },
  ];
  await page.setInputFiles('#fileInput', files);
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(3, { timeout: 20000 });
  await expect(page.locator('.sc-blank-banner')).toContainText('Eine Seite scheint leer zu sein', { timeout: 20000 });
  await expect(page.locator('.sc-pagecell.is-blank')).toHaveCount(1);
  await page.click('#scBlankRemove');
  await expect(page.locator('.sc-pagecell .sc-thumb')).toHaveCount(2);
  await expect(page.locator('.sc-blank-banner')).toHaveCount(0);
  await page.click('#scDoneBtn');
  await page.waitForFunction(() => window.__pdfpresser.state.docs[0]?.pages === 2);
});

test('Suche & Filter in der Dokumentliste', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#docFilter')).toBeHidden();
  for (const n of ['Stromrechnung', 'Mietvertrag', 'Kfz-Versicherung', 'Arztbrief']) await addTextPdf(page, n, [`Inhalt ${n}`, n === 'Arztbrief' ? 'Diagnose Schnupfen' : 'nichts']);
  await expect(page.locator('#docFilter')).toBeVisible();
  await page.fill('#docSearch', 'miet');
  await expect(page.locator('.doc:not(.hidden)')).toHaveCount(1);
  await expect(page.locator('.doc:not(.hidden) .doc-title')).toHaveText('Mietvertrag.pdf');
  // Volltext: findet auch Inhalte
  await page.fill('#docSearch', 'schnupfen');
  await expect(page.locator('.doc:not(.hidden) .doc-title')).toHaveText('Arztbrief.pdf', { timeout: 15000 });
  await page.fill('#docSearch', 'gibtsnicht');
  await expect(page.locator('#docNoHit')).toBeVisible();
  await page.fill('#docSearch', '');
  await page.click('#docFilterSeg button[data-v="done"]');
  await expect(page.locator('.doc:not(.hidden)')).toHaveCount(0);
  await page.click('#docFilterSeg button[data-v="open"]');
  await expect(page.locator('.doc:not(.hidden)')).toHaveCount(4);
});

// ---------------------------------------------------------------- Paperless mit Angaben

function startServer(env) {
  const proc = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server startet nicht')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('läuft auf')) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', (c) => reject(new Error(`Server beendet (${c})`)));
  });
}

test('An Paperless mit Titel, Datum, Korrespondent, Dokumenttyp und Tags – „Wie zuletzt“', async ({ page }) => {
  const posts = [];
  const lists = {
    correspondents: [{ id: 3, name: 'Stadtwerke' }, { id: 7, name: 'Vermieter' }],
    document_types: [{ id: 2, name: 'Rechnung' }, { id: 5, name: 'Vertrag' }],
    tags: [{ id: 11, name: 'Haus', color: '#15803d' }, { id: 12, name: 'Steuer', color: '#c00000' }, { id: 13, name: 'Wichtig', color: '#1d4ed8' }],
  };
  const mock = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Token geheim') { res.writeHead(401); res.end('{}'); return; }
    const u = new URL(req.url, 'http://x');
    const m = /^\/api\/(correspondents|document_types|tags)\/$/.exec(u.pathname);
    if (m) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ count: lists[m[1]].length, next: null, results: lists[m[1]] })); return; }
    if (u.pathname === '/api/documents/post_document/') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        const field = (n) => [...body.matchAll(new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`, 'g'))].map((x) => Buffer.from(x[1], 'latin1').toString('utf8'));
        posts.push({ title: field('title')[0], created: field('created')[0], correspondent: field('correspondent')[0], type: field('document_type')[0], tags: field('tags') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify('task-1'));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => mock.listen(8863, r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const srv = await startServer({ PORT: '8864', PAPERLESS_URL: 'http://127.0.0.1:8863', PAPERLESS_TOKEN: 'geheim', CONSUME_DIR: '', RAW_DIR: '', SCANNER_HOST: '', DATA_DIR: tmp });
  try {
    await page.goto('http://127.0.0.1:8864/');
    await page.waitForFunction(() => window.__pdfpresser && window.PDFLib);
    await page.evaluate(() => window.__pdfpresser.booted);
    await addTextPdf(page, 'Scan 2026-11-11 10-00', ['Stadtwerke Musterstadt', 'RECHNUNG', 'Rechnungsnummer: 2026-114', 'Datum: 03.10.2026']);
    await page.click('#inspector .profile:has(input[value="verlustfrei"])');
    await page.click('#inspector .insp-foot [data-act="compress"]');
    await page.waitForFunction(() => window.__pdfpresser.state.docs[0].status === 'done', null, { timeout: 30000 });
    await page.click('#inspector .insp-foot [data-act="paperless"]');
    await expect(page.locator('#sendSheet')).toHaveClass(/open/);
    await expect(page.locator('#sendSheetState')).toContainText('3 Tags');
    await expect(page.locator('#sendCorr option')).toHaveCount(3);
    // Vorschläge aus dem Text
    await expect(page.locator('#sendDateChips [data-date="2026-10-03"]')).toHaveText('03.10.2026');
    await page.click('#sendDateChips [data-date="2026-10-03"]');
    await page.click('#sendTitleSuggest [data-title]');
    await expect(page.locator('#sendTitle')).toHaveValue('Rechnung 2026-114 – 2026-10-03');
    await page.selectOption('#sendCorr', '3');
    await page.selectOption('#sendType', '2');
    await page.click('.tag-chip[data-tag="11"]');
    await page.click('.tag-chip[data-tag="12"]');
    await expect(page.locator('#sendTagCount')).toHaveText('2 gewählt');
    await page.click('#sendGo');
    await expect(page.locator('.toast').last()).toContainText('ist bei Paperless', { timeout: 15000 });
    expect(posts[0]).toEqual({ title: 'Rechnung 2026-114 – 2026-10-03', created: '2026-10-03', correspondent: '3', type: '2', tags: ['11', '12'] });
    // Der Name in der App folgt dem Titel
    await expect(page.locator('.doc .doc-title')).toHaveText('Rechnung 2026-114 – 2026-10-03.pdf');

    // Zweites Dokument: „Wie zuletzt“ übernimmt Korrespondent, Typ und Tags
    await addTextPdf(page, 'Noch eine', ['Abschlag Strom']);
    await page.click('#inspector .profile:has(input[value="verlustfrei"])');
    await page.click('#inspector .insp-foot [data-act="compress"]');
    await page.waitForFunction(() => window.__pdfpresser.state.docs[1].status === 'done', null, { timeout: 30000 });
    await page.click('#inspector .insp-foot [data-act="paperless"]');
    await expect(page.locator('#sendSheetState')).toContainText('3 Tags');
    await page.click('#sendLast [data-last]');
    await expect(page.locator('#sendCorr')).toHaveValue('3');
    await expect(page.locator('.tag-chip.on')).toHaveCount(2);
    // Ohne Rückfrage künftig: Schalter im Blatt
    await page.uncheck('#sendAsk');
    await page.click('#sendGo');
    await expect.poll(() => posts.length, { timeout: 15000 }).toBe(2);
    expect(posts[1]).toMatchObject({ title: 'Noch eine', correspondent: '3', type: '2', tags: ['11', '12'] });
    expect(await page.evaluate(() => window.__pdfpresser.settings.paperlessAsk)).toBe(false);
  } finally {
    srv.kill();
    mock.close();
  }
});
