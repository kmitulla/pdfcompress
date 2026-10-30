// PDF-Presser-Server: liefert die statische Web-App aus UND stellt die API
// für Netzwerk-Scanner (eSCL/AirScan), Paperless und den Sammelordner bereit.
// Alles läuft same-origin, damit es aus dem Browser (auch am Handy) ohne
// CORS-Probleme funktioniert. Keine externen Abhängigkeiten.
//
// Konfiguration über Umgebungsvariablen (siehe docker-compose.yml):
//   PORT            Port des Servers                 (Standard 8823)
//   SCANNER_HOST    IP/Hostname des Scanners         (leer = Scanner aus)
//   CONSUME_DIR     Paperless-„consume“-Ordner       (leer = kein Ordner)
//   PAPERLESS_URL   Paperless-Adresse für den API-Upload (z. B. http://paperless:8000)
//   PAPERLESS_TOKEN API-Token aus Paperless (Profil → API-Token)
//   RAW_DIR         Sammelordner für „Paperless Prepare“ (leer = aus)
//   DATA_DIR        Profilspeicher (Einstellungen, Unterschriften)
//   APP_VERSION     Versionskennung (sonst aus dem Inhalt der App berechnet)
//
// Scanner-Adresse, consume-Ordner und Paperless-API lassen sich zusätzlich in
// der App unter Einstellungen ändern (gespeichert in DATA_DIR/config.json,
// hat Vorrang vor den Variablen).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCapabilities, scanPage } from './escl.mjs';
import * as cfg from './config.mjs';
import * as scanJobs from './jobs.mjs';
import { discover, subnets } from './discover.mjs';
import { detectOcr, ocrInfo, recognize } from './ocr.mjs';
import * as docStore from './docs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // Repo-Wurzel = statische Web-App
const port = parseInt(process.env.PORT, 10) || 8823;
const env = (k) => (process.env[k] || '').trim();
const MAX_UPLOAD = 200 * 1024 * 1024; // 200 MB Obergrenze fürs Speichern

// Serverseitiger Speicher für Einstellungen & Unterschriften. Nur in der
// selbst gehosteten Variante aktiv – die öffentliche GitHub-Pages-Version hat
// kein Backend und bleibt damit automatisch rein lokal.
const DATA_DIR = env('DATA_DIR') || '/data/app';
const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
cfg.loadConfig(DATA_DIR);
const scannerHost = () => cfg.get('scannerHost');
const MAX_PROFILE = 8 * 1024 * 1024; // Unterschriften sind Bilder – etwas Luft

// Sammelordner der Vorstufe („Paperless Prepare“)
const RAW_DIR = env('RAW_DIR');
const RAW_EXT = /\.(pdf|jpe?g|png|webp|heic|heif|tiff?|bmp)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
};

// -------------------------------------------------------------------- Version

// Ändert sich mit jedem Inhalt der App. Darüber erkennt der Service Worker im
// Browser ein Update – ohne dass beim Deployment jemand eine Nummer pflegt.
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return '0'; }
})();

function computeVersion() {
  if (env('APP_VERSION')) return env('APP_VERSION').slice(0, 12);
  const h = crypto.createHash('sha1');
  const walk = (rel) => {
    const full = path.join(root, rel);
    let st;
    try { st = fs.statSync(full); } catch { return; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) walk(path.join(rel, name));
    } else {
      h.update(rel);
      h.update(fs.readFileSync(full));
    }
  };
  ['index.html', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'icons'].forEach(walk);
  return h.digest('hex').slice(0, 10);
}
const VERSION = computeVersion();

// -------------------------------------------------------------------- Helfer

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Datei zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Dateiname säubern: keine Pfad-Traversal, immer .pdf.
function safePdfName(name) {
  let base = path.basename(String(name || '').trim()).replace(/[^\w.\-() äöüÄÖÜß]+/g, '_');
  if (!base || base === '.pdf' || base.startsWith('.')) base = `scan_${Date.now()}.pdf`;
  if (!/\.pdf$/i.test(base)) base += '.pdf';
  return base;
}

// Dateiname im RAW-Ordner: nur der Name selbst, erlaubte Endung, kein Ausbruch
function safeRawName(name, fallbackExt = '.pdf') {
  let base = path.basename(String(name || '').trim()).replace(/[^\w.\-() äöüÄÖÜß]+/g, '_');
  if (!base || base.startsWith('.')) base = `datei_${Date.now()}${fallbackExt}`;
  if (!RAW_EXT.test(base)) base += fallbackExt;
  return base;
}

/** Vollständiger Pfad im RAW-Ordner – oder null, wenn der Name nicht taugt. */
function rawPath(name) {
  if (!RAW_DIR) return null;
  const safe = safeRawName(name);
  const full = path.join(RAW_DIR, safe);
  // Doppelt absichern: der Pfad muss wirklich im RAW-Ordner liegen
  if (path.dirname(path.resolve(full)) !== path.resolve(RAW_DIR)) return null;
  return full;
}

/** Freien Namen finden, damit nichts überschrieben wird. */
async function freeName(dir, safe) {
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = safe;
  for (let i = 2; i < 500; i++) {
    try {
      await fsp.access(path.join(dir, candidate));
      candidate = `${stem}_${i}${ext}`;
    } catch {
      return candidate;   // existiert nicht -> frei
    }
  }
  return `${stem}_${Date.now()}${ext}`;
}

/** Erst .part schreiben, dann umbenennen – so sieht niemand halbe Dateien. */
async function writeAtomic(dir, name, data) {
  await fsp.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, name);
  const tmpPath = path.join(dir, `.${name}.part`);
  await fsp.writeFile(tmpPath, data);
  await fsp.rename(tmpPath, finalPath);
}

// -------------------------------------------------------------------- Paperless

/** PDF über die REST-API an Paperless übergeben. Liefert die Task-ID. */
async function uploadToPaperless(data, name, title) {
  const PAPERLESS_URL = cfg.get('paperlessUrl');
  const PAPERLESS_TOKEN = cfg.get('paperlessToken');
  const form = new FormData();
  form.append('document', new Blob([data], { type: 'application/pdf' }), name);
  if (title) form.append('title', title);
  const res = await fetch(`${PAPERLESS_URL}/api/documents/post_document/`, {
    method: 'POST',
    headers: { Authorization: `Token ${PAPERLESS_TOKEN}`, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (API-Token prüfen)' : '';
    throw new Error(`Paperless antwortet mit HTTP ${res.status}${hint}: ${text.slice(0, 160)}`);
  }
  try { return JSON.parse(text); } catch { return text.trim(); }
}

/** Verbindung zu Paperless prüfen (für den Knopf „Testen“ in der App). */
async function testPaperless(url, token) {
  if (!url) throw new Error('Keine Paperless-Adresse angegeben.');
  if (!token) throw new Error('Kein API-Token angegeben.');
  let res;
  try {
    res = await fetch(`${url}/api/documents/?page_size=1&fields=id`, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error(`Paperless nicht erreichbar (${e.cause?.code || e.message}). Adresse aus Sicht des Servers prüfen.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('Paperless lehnt den API-Token ab.');
  if (!res.ok) throw new Error(`Paperless antwortet mit HTTP ${res.status}.`);
  let count = null;
  try { count = (await res.json()).count; } catch { /* egal */ }
  return { ok: true, version: res.headers.get('x-version') || null, documents: count };
}

// Seiten-Scan mit der aktuell eingestellten Scanner-Adresse
const scanWithCurrent = (opts) => scanPage(scannerHost(), opts);

async function writeRaw(name, data) {
  await fsp.mkdir(RAW_DIR, { recursive: true });
  const finalName = await freeName(RAW_DIR, safeRawName(name, '.jpg'));
  await writeAtomic(RAW_DIR, finalName, data);
  return finalName;
}

function readJson(req, limit = 64 * 1024) {
  return readBody(req, limit).then((b) => (b.length ? JSON.parse(b.toString('utf8')) : {}));
}

// -------------------------------------------------------------------- API

async function handleApi(req, res, url) {
  // Funktions-Status für die Web-App: welche Backend-Features sind aktiv?
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const mode = cfg.paperlessMode();
    return sendJson(res, 200, {
      scanner: !!scannerHost(),
      consume: !!mode,
      paperless: mode,
      profile: profileEnabled,
      raw: !!RAW_DIR,
      jobs: profileEnabled,
      settings: profileEnabled,
      docs: profileEnabled,
      ocr: ocrInfo() ? { langs: ocrInfo().langs, version: ocrInfo().version } : false,
      version: VERSION,
      appVersion: PKG_VERSION,
    });
  }

  // ---- Dokumente (geräteübergreifend) ----
  if (url.pathname === '/api/docs' && req.method === 'GET') {
    if (!profileEnabled) return sendJson(res, 501, { error: 'Server-Speicher nicht verfügbar (DATA_DIR).' });
    return sendJson(res, 200, { docs: await docStore.listDocs(), now: Date.now() });
  }
  const dm = /^\/api\/docs\/([\w-]{1,64})(?:\/(original|result))?$/.exec(url.pathname);
  if (dm) {
    if (!profileEnabled) return sendJson(res, 501, { error: 'Server-Speicher nicht verfügbar (DATA_DIR).' });
    const [, id, kind] = dm;
    try {
      if (!kind && req.method === 'PUT') {
        const meta = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
        await docStore.putMeta(id, meta);
        return sendJson(res, 200, { ok: true });
      }
      if (!kind && req.method === 'DELETE') {
        await docStore.deleteDoc(id);
        return sendJson(res, 200, { ok: true });
      }
      if (kind && req.method === 'PUT') {
        const data = await readBody(req);
        if (!data.length) return sendJson(res, 400, { error: 'Leere Datei.' });
        await docStore.putFile(id, kind, data);
        return sendJson(res, 200, { ok: true, bytes: data.length });
      }
      if (kind && req.method === 'GET') {
        const data = await docStore.getFile(id, kind);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
        return res.end(data);
      }
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 404, { error: 'Nicht gefunden.' });
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }

  // ---- Texterkennung auf dem Server ----
  if (url.pathname === '/api/ocr' && req.method === 'POST') {
    if (!ocrInfo()) return sendJson(res, 501, { error: 'Tesseract ist auf dem Server nicht installiert.' });
    try {
      const data = await readBody(req, 40 * 1024 * 1024);
      if (!data.length) return sendJson(res, 400, { error: 'Leeres Bild.' });
      const t0 = Date.now();
      const words = await recognize(data, {
        lang: url.searchParams.get('lang') || 'deu',
        dpi: parseFloat(url.searchParams.get('dpi')) || 300,
      });
      return sendJson(res, 200, { words, ms: Date.now() - t0 });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // ---- Server-Einstellungen (Scanner, Paperless) ----

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, { ...cfg.publicView(), mounts: cfg.mountedFolders(), rawDir: RAW_DIR || null });
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    if (!profileEnabled) return sendJson(res, 501, { error: 'Server-Speicher nicht verfügbar (DATA_DIR).' });
    try {
      const patch = await readJson(req);
      const view = await cfg.update(patch);
      return sendJson(res, 200, { ...view, mounts: cfg.mountedFolders(), rawDir: RAW_DIR || null });
    } catch (e) {
      return sendJson(res, 400, { error: e.code === 'EACCES' ? 'Ordner ist nicht beschreibbar.' : e.message });
    }
  }

  // Paperless-Verbindung testen – mit den übergebenen oder gespeicherten Daten
  if (url.pathname === '/api/paperless/test' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      let u = String(body.url ?? cfg.get('paperlessUrl') ?? '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
      if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
      // Gespeicherter Token nur für die gespeicherte Adresse – nie an eine andere
      const t = String(body.token || (u === cfg.get('paperlessUrl') ? cfg.get('paperlessToken') : '') || '').trim();
      const r = await testPaperless(u, t);
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  // Profil (Einstellungen + Unterschriften + Stempel) vom Server lesen.
  if (url.pathname === '/api/profile' && req.method === 'GET') {
    if (!profileEnabled) return sendJson(res, 501, { error: 'Server-Speicher nicht verfügbar.' });
    try {
      const raw = await fsp.readFile(PROFILE_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(raw);
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 200, {}); // noch nichts gespeichert
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Profil auf dem Server ablegen (ersetzt den bisherigen Stand).
  if (url.pathname === '/api/profile' && req.method === 'PUT') {
    if (!profileEnabled) return sendJson(res, 501, { error: 'Server-Speicher nicht verfügbar.' });
    try {
      const data = await readBody(req, MAX_PROFILE);
      JSON.parse(data.toString('utf8')); // nur gültiges JSON annehmen
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${PROFILE_FILE}.tmp`;
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, PROFILE_FILE);
      return sendJson(res, 200, { ok: true, bytes: data.length });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Scanner erreichbar? Modell und unterstützte Einstellungen zurückgeben.
  if (url.pathname === '/api/scanner/status' && req.method === 'GET') {
    const host = scannerHost();
    if (!host) return sendJson(res, 501, { ok: false, error: 'Kein Scanner konfiguriert (SCANNER_HOST fehlt).' });
    try {
      const caps = await getCapabilities(host, { fresh: url.searchParams.has('fresh') });
      const mm = (v) => (v ? Math.round((v / 300) * 25.4 * 10) / 10 : null);
      return sendJson(res, 200, {
        ok: true, model: caps.model, host,
        resolutions: caps.resolutions,
        colorModes: caps.colorModes,
        // Grau/S-W gehen, wenn das Gerät Graustufen liefert; sonst wird in der
        // App aus dem Farbscan umgerechnet.
        gray: caps.colorModes.includes('Grayscale8'),
        bed: { w: mm(caps.maxWidth), h: mm(caps.maxHeight) },
        busy: !!scanJobs.activeJob(),
      });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message, host });
    }
  }

  // Scanner im Netzwerk suchen
  if (url.pathname === '/api/scanner/discover' && req.method === 'GET') {
    const nets = subnets([url.searchParams.get('near'), scannerHost(), ...(url.searchParams.getAll('subnet'))]);
    if (!nets.length) return sendJson(res, 200, { nets, found: [], hint: 'Kein lokales Netz erkennbar – Adresse von Hand eintragen.' });
    try {
      const found = await discover(nets);
      return sendJson(res, 200, { nets, found });
    } catch (e) {
      return sendJson(res, 500, { error: e.message, nets });
    }
  }

  // ---- Scan-Aufträge (laufen auf dem Server weiter, auch ohne App) ----

  if (url.pathname === '/api/scan-jobs' && req.method === 'GET') {
    return sendJson(res, 200, { jobs: scanJobs.listJobs(), active: scanJobs.activeJob()?.id || null });
  }

  if (url.pathname === '/api/scan-jobs' && req.method === 'POST') {
    if (!scannerHost()) return sendJson(res, 501, { error: 'Kein Scanner konfiguriert (SCANNER_HOST fehlt).' });
    if (!profileEnabled) return sendJson(res, 501, { error: 'Server-Speicher nicht verfügbar (DATA_DIR).' });
    try {
      const body = await readJson(req);
      if (body.target === 'raw' && !RAW_DIR) return sendJson(res, 400, { error: 'Kein Sammelordner konfiguriert (RAW_DIR fehlt).' });
      return sendJson(res, 201, await scanJobs.createJob(body));
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message, job: e.job });
    }
  }

  const jm = /^\/api\/scan-jobs\/([\w-]+)(?:\/(cancel|next|resume|pages\/(\d+)))?$/.exec(url.pathname);
  if (jm) {
    const [, id, action, pageNo] = jm;
    if (!action && req.method === 'GET') {
      const job = scanJobs.getJob(id);
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'Auftrag nicht gefunden.' });
    }
    if (!action && req.method === 'DELETE') {
      await scanJobs.deleteJob(id);
      return sendJson(res, 200, { ok: true });
    }
    if (pageNo && req.method === 'GET') {
      const f = await scanJobs.pageFile(id, parseInt(pageNo, 10));
      if (!f) return sendJson(res, 404, { error: 'Seite nicht gefunden.' });
      res.writeHead(200, {
        'Content-Type': f.page.type || 'image/jpeg',
        'Content-Length': f.data.length,
        'Cache-Control': 'no-store',
        'X-Scan-Dpi': String(f.page.dpi),
        'X-Scan-Color': f.page.colorMode,
        'X-Scan-Wanted': f.page.wanted,
      });
      return res.end(f.data);
    }
    if (action === 'cancel' && req.method === 'POST') {
      const job = await scanJobs.cancelJob(id);
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'Auftrag nicht gefunden.' });
    }
    if (action === 'next' && req.method === 'POST') {
      return sendJson(res, 200, { ok: scanJobs.skipWait(id) });
    }
    if (action === 'resume' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const job = await scanJobs.resumeJob(id, { more: parseInt(body.more, 10) || 0 });
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'Auftrag nicht gefunden.' });
      } catch (e) {
        return sendJson(res, e.status || 400, { error: e.message });
      }
    }
  }

  // Eine Seite scannen → Bild (JPEG) direkt zurückliefern.
  if (url.pathname === '/api/scanner/scan' && req.method === 'POST') {
    if (!scannerHost()) return sendJson(res, 501, { error: 'Kein Scanner konfiguriert (SCANNER_HOST fehlt).' });
    if (scanJobs.activeJob()) return sendJson(res, 409, { error: 'Es läuft bereits ein Scan-Auftrag.' });
    const colorMode = url.searchParams.get('color') || 'color';
    const resolution = url.searchParams.get('dpi') || '300';
    const source = url.searchParams.get('source') || 'platen';
    try {
      const { buffer, contentType, dpi, colorMode: got, wanted } = await scanPage(scannerHost(), { colorMode, resolution, source });
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        // Auflösung mitgeben: damit kann die App aus der Pixelgröße die echten
        // Millimeter der Glasfläche berechnen und den A4-Ausschnitt exakt setzen.
        'X-Scan-Dpi': String(dpi),
        'X-Scan-Color': got,
        'X-Scan-Wanted': wanted,
      });
      return res.end(buffer);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // ---- Vorstufe „Paperless Prepare“: Sammelordner ----

  // Inhalt auflisten (nur Dateien, keine Unterordner)
  if (url.pathname === '/api/raw' && req.method === 'GET') {
    if (!RAW_DIR) return sendJson(res, 501, { error: 'Kein Sammelordner konfiguriert (RAW_DIR fehlt).' });
    try {
      await fsp.mkdir(RAW_DIR, { recursive: true });
      const entries = await fsp.readdir(RAW_DIR, { withFileTypes: true });
      const files = [];
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.') || !RAW_EXT.test(e.name)) continue;
        const st = await fsp.stat(path.join(RAW_DIR, e.name));
        files.push({
          name: e.name,
          size: st.size,
          modified: st.mtimeMs,
          kind: /\.pdf$/i.test(e.name) ? 'pdf' : 'image',
        });
      }
      files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));   // älteste zuerst
      return sendJson(res, 200, { files });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Einzelne Datei ausliefern
  if (url.pathname === '/api/raw/file' && req.method === 'GET') {
    const full = rawPath(url.searchParams.get('name'));
    if (!full) return sendJson(res, 400, { error: 'Ungültiger Name.' });
    try {
      const data = await fsp.readFile(full);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      return res.end(data);
    } catch {
      return sendJson(res, 404, { error: 'Datei nicht gefunden.' });
    }
  }

  // Datei ablegen (Scan oder Foto vom Handy)
  if (url.pathname === '/api/raw' && req.method === 'POST') {
    if (!RAW_DIR) return sendJson(res, 501, { error: 'Kein Sammelordner konfiguriert (RAW_DIR fehlt).' });
    try {
      const data = await readBody(req);
      if (!data.length) return sendJson(res, 400, { error: 'Leere Datei.' });
      await fsp.mkdir(RAW_DIR, { recursive: true });
      const name = await freeName(RAW_DIR, safeRawName(url.searchParams.get('name') || req.headers['x-filename']));
      await writeAtomic(RAW_DIR, name, data);
      return sendJson(res, 200, { ok: true, name, bytes: data.length });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Datei aus dem Sammelordner entfernen (nach der Übergabe an Paperless)
  if (url.pathname === '/api/raw' && req.method === 'DELETE') {
    const full = rawPath(url.searchParams.get('name'));
    if (!full) return sendJson(res, 400, { error: 'Ungültiger Name.' });
    try {
      await fsp.unlink(full);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 200, { ok: true });   // schon weg
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Fertiges PDF an Paperless übergeben – per API oder über den consume-Ordner.
  if (url.pathname === '/api/save' && req.method === 'POST') {
    const paperlessMode = cfg.paperlessMode();
    const CONSUME_DIR = cfg.get('consumeDir');
    if (!paperlessMode) return sendJson(res, 501, { error: 'Paperless ist nicht eingerichtet (CONSUME_DIR oder PAPERLESS_URL/PAPERLESS_TOKEN fehlen).' });
    const name = safePdfName(url.searchParams.get('name') || req.headers['x-filename']);
    const title = (url.searchParams.get('title') || '').trim().slice(0, 200);
    let data;
    try {
      data = await readBody(req);
      if (!data.length) return sendJson(res, 400, { error: 'Leere Datei.' });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let apiError = null;
    if (paperlessMode === 'api') {
      try {
        const task = await uploadToPaperless(data, name, title);
        return sendJson(res, 200, { ok: true, mode: 'api', name, task, bytes: data.length });
      } catch (e) {
        apiError = e;
        if (!CONSUME_DIR) return sendJson(res, 502, { error: e.message });
      }
    }
    try {
      // Atomar schreiben: Paperless sieht nur fertige Dateien. Gleichnamige
      // Dateien werden nicht überschrieben, falls Paperless noch nicht fertig ist.
      const finalName = await freeName(CONSUME_DIR, name);
      await writeAtomic(CONSUME_DIR, finalName, data);
      return sendJson(res, 200, {
        ok: true, mode: 'folder', name: finalName, bytes: data.length,
        ...(apiError ? { warning: `API nicht erreichbar (${apiError.message}) – stattdessen in den Ordner gelegt.` } : {}),
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: 'Unbekannter API-Endpunkt' });
}

// -------------------------------------------------------------------- Statisch

const NO_CACHE = 'no-cache';   // immer nachfragen; per ETag meist nur 304

async function serveStatic(req, res, url) {
  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(root, urlPath);
  if (!file.startsWith(root + path.sep) || /[\\/]\.(git|github)[\\/]?/.test(urlPath) || /[\\/](server|tests|node_modules)[\\/]/.test(urlPath)) {
    res.writeHead(403).end();
    return;
  }
  let st;
  try {
    st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('kein File');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const etag = `"${VERSION}-${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': NO_CACHE,
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  let data = await fsp.readFile(file);
  // Der Service Worker bekommt die aktuelle Versionskennung eingesetzt – neue
  // Version = neuer Cache, alte Dateien werden sauber ersetzt.
  if (urlPath === '/sw.js') {
    data = Buffer.from(data.toString('utf8').replaceAll('__APP_VERSION__', VERSION));
    headers['Service-Worker-Allowed'] = '/';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

// -------------------------------------------------------------------- Server

// Server-Speicher nur anbieten, wenn das Datenverzeichnis wirklich beschreibbar
// ist – sonst würde die App eine Funktion zeigen, die beim Speichern scheitert.
let profileEnabled = false;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  profileEnabled = true;
} catch {
  profileEnabled = false;
}
if (profileEnabled) docStore.initDocs(DATA_DIR);
if (profileEnabled) scanJobs.initJobs({ dataDir: DATA_DIR, scan: scanWithCurrent, writeRaw: RAW_DIR ? writeRaw : null });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url);
    } else {
      res.writeHead(405).end();
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
    else res.end();
  }
});

await detectOcr();

server.listen(port, () => {
  const mode = cfg.paperlessMode();
  const c = cfg.current();
  console.log(`PDF Presser ${PKG_VERSION} (${VERSION}) läuft auf http://0.0.0.0:${port}`);
  console.log(`  Scanner:        ${c.scannerHost || '— (nicht konfiguriert)'}`);
  console.log(`  Paperless:      ${mode === 'api' ? `API ${c.paperlessUrl}` : mode === 'folder' ? `Ordner ${c.consumeDir}` : '— (nicht konfiguriert)'}`);
  if (mode === 'api' && c.consumeDir) console.log(`                  Rückfall-Ordner: ${c.consumeDir}`);
  console.log(`  Profilspeicher: ${profileEnabled ? DATA_DIR : '— (nicht beschreibbar)'}`);
  console.log(`  Sammelordner:   ${RAW_DIR || '— (nicht konfiguriert)'}`);
  const o = ocrInfo();
  console.log(`  Texterkennung:  ${o ? `Tesseract ${o.version} (${o.langs.join(', ')}), ${o.parallel} parallel` : '— (im Browser)'}`);
});

// Sauber beenden (docker stop), damit laufende Schreibvorgänge fertig werden
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await scanJobs.shutdownJobs();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
