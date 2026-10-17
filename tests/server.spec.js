// Backend: Konfiguration & Version, Service-Worker-Versionierung, gesperrte
// Pfade, Sammelordner-API, Ablage im consume-Ordner und Upload über die
// Paperless-API (gegen eine Test-Gegenstelle).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const BASE = 'http://localhost:8823';

test('Konfiguration, Version und Service Worker mit Versionskennung', async ({ request }) => {
  const cfg = await (await request.get(`${BASE}/api/config`)).json();
  expect(cfg).toMatchObject({ scanner: false, consume: true, paperless: 'folder', profile: true, raw: true });
  expect(cfg.version).toMatch(/^[0-9a-f]{6,}$/);
  const sw = await request.get(`${BASE}/sw.js`);
  const body = await sw.text();
  expect(body).toContain(`const VERSION = '${cfg.version}'`);
  expect(body).not.toContain('__APP_VERSION__');
  // Caching: immer nachfragen, per ETag meist nur 304
  expect(sw.headers()['cache-control']).toBe('no-cache');
  const etag = sw.headers().etag;
  const again = await request.get(`${BASE}/index.html`, { headers: { 'If-None-Match': etag } });
  expect([200, 304]).toContain(again.status());
  const idx = await request.get(`${BASE}/index.html`);
  const re = await request.get(`${BASE}/index.html`, { headers: { 'If-None-Match': idx.headers().etag } });
  expect(re.status()).toBe(304);
});

test('Interne Dateien (Server, Tests, Git) werden nicht ausgeliefert', async ({ request }) => {
  for (const p of ['/server/index.mjs', '/tests/helpers.js', '/.git/config', '/node_modules/pdf-lib/package.json']) {
    const r = await request.get(`${BASE}${p}`);
    expect(r.status(), p).toBe(403);
  }
  expect((await request.get(`${BASE}/js/app.js`)).status()).toBe(200);
  expect((await request.get(`${BASE}/gibtsnicht.js`)).status()).toBe(404);
});

test('Sammelordner: ablegen, auflisten, ausliefern, löschen – Namen bleiben im Ordner', async ({ request }) => {
  const name = `api_${Date.now()}.jpg`;
  const up = await request.post(`${BASE}/api/raw?name=${encodeURIComponent(name)}`, { data: Buffer.from('abc'), headers: { 'Content-Type': 'image/jpeg' } });
  expect((await up.json()).name).toBe(name);
  // Gleicher Name -> neuer Name, nichts wird überschrieben
  const up2 = await request.post(`${BASE}/api/raw?name=${encodeURIComponent(name)}`, { data: Buffer.from('xyz'), headers: { 'Content-Type': 'image/jpeg' } });
  const name2 = (await up2.json()).name;
  expect(name2).not.toBe(name);
  // Pfad-Ausbruch wird entschärft
  const evil = await request.post(`${BASE}/api/raw?name=${encodeURIComponent('../../etc/passwd.jpg')}`, { data: Buffer.from('x') });
  const evilName = (await evil.json()).name;
  expect(evilName).toBe('passwd.jpg');
  expect(fs.existsSync(path.join('test-results', 'raw', 'passwd.jpg'))).toBe(true);

  const list = await (await request.get(`${BASE}/api/raw`)).json();
  expect(list.files.map((f) => f.name)).toEqual(expect.arrayContaining([name, name2]));
  const file = await request.get(`${BASE}/api/raw/file?name=${encodeURIComponent(name)}`);
  expect(await file.text()).toBe('abc');
  expect(file.headers()['content-type']).toBe('image/jpeg');
  for (const n of [name, name2, evilName]) {
    expect((await request.delete(`${BASE}/api/raw?name=${encodeURIComponent(n)}`)).ok()).toBe(true);
  }
  const after = await (await request.get(`${BASE}/api/raw`)).json();
  expect(after.files.map((f) => f.name)).not.toContain(name);
});

test('An Paperless (Ordner): atomar abgelegt, gleiche Namen überschreiben nichts', async ({ request }) => {
  const name = `Ordner ${Date.now()}.pdf`;
  const pdf = Buffer.from('%PDF-1.7\n%test\n');
  const r1 = await (await request.post(`${BASE}/api/save?name=${encodeURIComponent(name)}`, { data: pdf })).json();
  const r2 = await (await request.post(`${BASE}/api/save?name=${encodeURIComponent(name)}`, { data: pdf })).json();
  expect(r1).toMatchObject({ ok: true, mode: 'folder', name });
  expect(r2.name).not.toBe(name);
  const dir = path.join('test-results', 'consume');
  expect(fs.existsSync(path.join(dir, r1.name))).toBe(true);
  expect(fs.existsSync(path.join(dir, r2.name))).toBe(true);
  expect(fs.readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false);
});

/** Zweiten Server mit eigener Umgebung starten */
async function startServer(env) {
  const proc = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server startet nicht')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('läuft auf')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error(`Server beendet (${c})`)));
  });
  return proc;
}

test('An Paperless (API): Upload mit Token und Titel, Rückfall in den Ordner', async () => {
  // Test-Gegenstelle für Paperless
  const seen = [];
  let fail = false;
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') });
      if (fail) { res.writeHead(500); res.end('kaputt'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify('2f0e8c1a-task'));
    });
  });
  await new Promise((r) => mock.listen(8853, r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const apiOnly = await startServer({ PORT: '8851', PAPERLESS_URL: 'http://127.0.0.1:8853/', PAPERLESS_TOKEN: 'geheim123', CONSUME_DIR: '', RAW_DIR: '', DATA_DIR: path.join(tmp, 'a') });
  const withFolder = await startServer({ PORT: '8852', PAPERLESS_URL: 'http://127.0.0.1:8853', PAPERLESS_TOKEN: 'geheim123', CONSUME_DIR: path.join(tmp, 'consume'), RAW_DIR: '', DATA_DIR: path.join(tmp, 'b') });
  try {
    const cfg = await (await fetch('http://127.0.0.1:8851/api/config')).json();
    expect(cfg.paperless).toBe('api');
    expect(cfg.consume).toBe(true);

    const pdf = Buffer.from('%PDF-1.7\nTESTINHALT\n');
    const r = await fetch('http://127.0.0.1:8851/api/save?name=Brief.pdf&title=Brief%20vom%20Amt', { method: 'POST', body: pdf });
    const data = await r.json();
    expect(data).toMatchObject({ ok: true, mode: 'api', task: '2f0e8c1a-task' });
    expect(seen[0].url).toBe('/api/documents/post_document/');
    expect(seen[0].auth).toBe('Token geheim123');
    expect(seen[0].type).toContain('multipart/form-data');
    expect(seen[0].body).toContain('name="document"; filename="Brief.pdf"');
    expect(seen[0].body).toContain('TESTINHALT');
    expect(seen[0].body).toContain('name="title"');
    expect(seen[0].body).toContain('Brief vom Amt');

    // Paperless streikt: ohne Ordner -> Fehler, mit Ordner -> Rückfall + Hinweis
    fail = true;
    const bad = await fetch('http://127.0.0.1:8851/api/save?name=X.pdf', { method: 'POST', body: pdf });
    expect(bad.status).toBe(502);
    const fb = await (await fetch('http://127.0.0.1:8852/api/save?name=Y.pdf', { method: 'POST', body: pdf })).json();
    expect(fb.mode).toBe('folder');
    expect(fb.warning).toContain('API nicht erreichbar');
    expect(fs.existsSync(path.join(tmp, 'consume', 'Y.pdf'))).toBe(true);
  } finally {
    apiOnly.kill();
    withFolder.kill();
    mock.close();
  }
});

test('Scanner-Endpunkte melden fehlende Konfiguration verständlich', async ({ request }) => {
  const st = await request.get(`${BASE}/api/scanner/status`);
  expect(st.status()).toBe(501);
  expect((await st.json()).error).toContain('SCANNER_HOST');
  const scan = await request.post(`${BASE}/api/scanner/scan`);
  expect(scan.status()).toBe(501);
});
