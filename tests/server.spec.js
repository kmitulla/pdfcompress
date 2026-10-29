// Backend: Konfiguration & Version, Service-Worker-Versionierung, gesperrte
// Pfade, Sammelordner-API, Ablage im consume-Ordner und Upload über die
// Paperless-API (gegen eine Test-Gegenstelle).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mockScanner, mockState } from './helpers.js';

const BASE = 'http://localhost:8823';

test('Konfiguration, Version und Service Worker mit Versionskennung', async ({ request }) => {
  const cfg = await (await request.get(`${BASE}/api/config`)).json();
  expect(cfg).toMatchObject({ scanner: true, consume: true, paperless: 'folder', profile: true, raw: true, jobs: true, settings: true });
  expect(cfg.version).toMatch(/^[0-9a-f]{6,}$/);
  expect(cfg.appVersion).toBe(JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
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

test('Ohne Scanner: Endpunkte melden fehlende Konfiguration verständlich', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const srv = await startServer({ PORT: '8854', SCANNER_HOST: '', DATA_DIR: tmp, RAW_DIR: '', CONSUME_DIR: '' });
  try {
    const st = await fetch('http://127.0.0.1:8854/api/scanner/status');
    expect(st.status).toBe(501);
    expect((await st.json()).error).toContain('SCANNER_HOST');
    expect((await fetch('http://127.0.0.1:8854/api/scanner/scan', { method: 'POST' })).status).toBe(501);
    expect((await fetch('http://127.0.0.1:8854/api/scan-jobs', { method: 'POST', body: '{}' })).status).toBe(501);
    expect((await (await fetch('http://127.0.0.1:8854/api/config')).json()).scanner).toBe(false);
  } finally {
    srv.kill();
  }
});

test('Scanner: Fähigkeiten, Auflösung/Farbe passend zum Gerät, Wiederholung bei „belegt“', async ({ request }) => {
  const st = await (await request.get(`${BASE}/api/scanner/status?fresh=1`)).json();
  expect(st).toMatchObject({ ok: true, model: 'EPSON ET-2720 Series', resolutions: [100, 200, 300, 600], gray: true });
  expect(st.bed.w).toBeCloseTo(215.9, 1);
  const img = Buffer.from('JPEGDATEN');
  await mockScanner({ image: img, config: { rejectFirst: 2, hangingJob: true } });
  // 150 dpi gibt es nicht → 200; S/W als Graustufen; 2× 503 + hängender Auftrag werden überstanden
  const r = await request.post(`${BASE}/api/scanner/scan?dpi=150&color=bw`);
  expect(r.status()).toBe(200);
  expect(r.headers()['x-scan-dpi']).toBe('200');
  expect(r.headers()['x-scan-color']).toBe('Grayscale8');
  expect(r.headers()['x-scan-wanted']).toBe('bw');
  expect(Buffer.from(await r.body()).toString()).toBe('JPEGDATEN');
  const state = await mockState();
  expect(state.jobs).not.toContain('stale');
  expect(state.posts.every((p) => p.color === 'Grayscale8' && p.dpi === 200)).toBe(true);
  await mockScanner();
});

test('Scan-Aufträge: laufen im Hintergrund, Seiten abholbar, Stopp, Neustart = unterbrochen', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const env = { PORT: '8855', SCANNER_HOST: 'http://127.0.0.1:8861', DATA_DIR: tmp, RAW_DIR: path.join(tmp, 'raw'), CONSUME_DIR: '' };
  await mockScanner({ image: Buffer.from('SEITE'), dpi: 300 });
  let srv = await startServer(env);
  const B = 'http://127.0.0.1:8855';
  const get = async (u) => (await fetch(B + u)).json();
  try {
    const job = await (await fetch(`${B}/api/scan-jobs`, { method: 'POST', body: JSON.stringify({ pages: 3, delay: 20, dpi: '300', color: 'color' }) })).json();
    expect(job).toMatchObject({ total: 3, target: 'doc' });
    expect(['queued', 'running']).toContain(job.status);
    // Zweiter Auftrag während der erste läuft: abgelehnt
    expect((await fetch(`${B}/api/scan-jobs`, { method: 'POST', body: '{}' })).status).toBe(409);
    await expect.poll(async () => (await get(`/api/scan-jobs/${job.id}`)).status, { timeout: 15000 }).toBe('waiting');
    let j = await get(`/api/scan-jobs/${job.id}`);
    expect(j.pages).toHaveLength(1);
    expect(j.nextAt).toBeGreaterThan(Date.now());
    const page1 = await fetch(`${B}/api/scan-jobs/${job.id}/pages/1`);
    expect(page1.headers.get('x-scan-dpi')).toBe('300');
    expect(await page1.text()).toBe('SEITE');
    // Pause überspringen → Seite 2 sofort
    await fetch(`${B}/api/scan-jobs/${job.id}/next`, { method: 'POST' });
    await expect.poll(async () => (await get(`/api/scan-jobs/${job.id}`)).pages.length, { timeout: 15000 }).toBe(2);
    // Server „stirbt“ während der Pause → nach dem Neustart: unterbrochen, Seiten erhalten
    srv.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    srv = await startServer(env);
    j = await get(`/api/scan-jobs/${job.id}`);
    expect(j.status).toBe('interrupted');
    expect(j.pages).toHaveLength(2);
    expect(await (await fetch(`${B}/api/scan-jobs/${job.id}/pages/2`)).text()).toBe('SEITE');
    // Fortsetzen → nächste Seite sofort (ohne Pause), dann stoppen
    await fetch(`${B}/api/scan-jobs/${job.id}/resume`, { method: 'POST', body: '{}' });
    await expect.poll(async () => (await get(`/api/scan-jobs/${job.id}`)).pages.length, { timeout: 15000 }).toBe(3);
    await expect.poll(async () => (await get(`/api/scan-jobs/${job.id}`)).status).toBe('done');
    // Löschen räumt alles weg
    await fetch(`${B}/api/scan-jobs/${job.id}`, { method: 'DELETE' });
    expect((await get('/api/scan-jobs')).jobs).toHaveLength(0);
    expect(fs.readdirSync(path.join(tmp, 'jobs'))).toHaveLength(0);

    // Ziel Sammelordner: Dateien landen direkt im RAW-Ordner
    const rj = await (await fetch(`${B}/api/scan-jobs`, { method: 'POST', body: JSON.stringify({ pages: 2, delay: 0, dpi: '300', target: 'raw' }) })).json();
    await expect.poll(async () => (await get(`/api/scan-jobs/${rj.id}`)).status, { timeout: 15000 }).toBe('done');
    const raw = fs.readdirSync(path.join(tmp, 'raw')).sort();
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatch(/^Scan_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_S01_300dpi\.jpg$/);
  } finally {
    srv.kill();
    await mockScanner();
  }
});

test('Einstellungen in der App: Paperless-API, Token geheim, Ordner, Scanner-Adresse', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const seen = [];
  const mock = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Token richtig') { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Version': '2.15.3' });
    res.end(JSON.stringify({ count: 42, results: [] }));
  });
  await new Promise((r) => mock.listen(8856, r));
  const srv = await startServer({ PORT: '8857', SCANNER_HOST: '', DATA_DIR: path.join(tmp, 'data'), RAW_DIR: '', CONSUME_DIR: path.join(tmp, 'consume'), PAPERLESS_URL: '', PAPERLESS_TOKEN: '' });
  const B = 'http://127.0.0.1:8857';
  const put = async (body) => fetch(`${B}/api/settings`, { method: 'PUT', body: JSON.stringify(body) });
  try {
    let s = await (await fetch(`${B}/api/settings`)).json();
    expect(s).toMatchObject({ paperless: 'folder', tokenSet: false, scannerHost: '' });
    expect(Array.isArray(s.mounts)).toBe(true);
    // Verbindungstest mit falschem und richtigem Token
    const bad = await (await fetch(`${B}/api/paperless/test`, { method: 'POST', body: JSON.stringify({ url: '127.0.0.1:8856/', token: 'falsch' }) })).json();
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toContain('Token');
    const ok = await (await fetch(`${B}/api/paperless/test`, { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:8856/api', token: 'richtig' }) })).json();
    expect(ok).toMatchObject({ ok: true, version: '2.15.3', documents: 42 });
    // Speichern: Token wird nie zurückgegeben
    s = await (await put({ paperlessUrl: '127.0.0.1:8856/', paperlessToken: 'richtig' })).json();
    expect(s).toMatchObject({ paperless: 'api', paperlessUrl: 'http://127.0.0.1:8856', tokenSet: true, tokenFrom: 'app' });
    expect(JSON.stringify(s)).not.toContain('richtig');
    expect((await (await fetch(`${B}/api/config`)).json()).paperless).toBe('api');
    // Ohne neuen Token testen → gespeicherter Token wird benutzt
    expect((await (await fetch(`${B}/api/paperless/test`, { method: 'POST', body: '{}' })).json()).ok).toBe(true);
    // Der gespeicherte Token geht nie an eine andere Adresse
    const n = seen.length;
    const other = await (await fetch(`${B}/api/paperless/test`, { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:8856/anders' }) })).json();
    expect(other.ok).toBe(false);
    expect(seen.slice(n).every((x) => x.auth !== 'Token richtig')).toBe(true);
    s = await (await put({ paperlessUrl: 'http://127.0.0.1:9' })).json();
    expect(s.tokenSet).toBe(false);   // neue Adresse ohne neuen Token → Token verworfen
    s = await (await put({ paperlessUrl: '127.0.0.1:8856', paperlessToken: 'richtig' })).json();
    expect(s.tokenSet).toBe(true);
    // consume-Ordner: relativ = Fehler, absolut = angelegt
    expect((await put({ consumeDir: 'relativ/ordner' })).status).toBe(400);
    const sub = path.join(tmp, 'consume', 'unterordner');
    s = await (await put({ consumeDir: sub })).json();
    expect(s.consumeDir).toBe(sub);
    expect(fs.existsSync(sub)).toBe(true);
    // Scanner-Adresse setzen → Scanner aktiv
    s = await (await put({ scannerHost: 'http://127.0.0.1:8861' })).json();
    expect((await (await fetch(`${B}/api/config`)).json()).scanner).toBe(true);
    // Token entfernen → zurück zum Ordner
    s = await (await put({ paperlessToken: null })).json();
    expect(s).toMatchObject({ tokenSet: false, paperless: 'folder' });
    // Bleibt über einen Neustart erhalten
    srv.kill();
    const again = await startServer({ PORT: '8857', SCANNER_HOST: '', DATA_DIR: path.join(tmp, 'data'), RAW_DIR: '', CONSUME_DIR: path.join(tmp, 'consume') });
    try {
      s = await (await fetch(`${B}/api/settings`)).json();
      expect(s).toMatchObject({ consumeDir: sub, scannerHost: 'http://127.0.0.1:8861', paperlessUrl: 'http://127.0.0.1:8856' });
    } finally {
      again.kill();
    }
  } finally {
    srv.kill();
    mock.close();
  }
});
