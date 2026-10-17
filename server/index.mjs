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

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCapabilities, scanPage } from './escl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // Repo-Wurzel = statische Web-App
const port = parseInt(process.env.PORT, 10) || 8823;
const env = (k) => (process.env[k] || '').trim();
const SCANNER_HOST = env('SCANNER_HOST');
const CONSUME_DIR = env('CONSUME_DIR');
const PAPERLESS_URL = env('PAPERLESS_URL').replace(/\/+$/, '');
const PAPERLESS_TOKEN = env('PAPERLESS_TOKEN');
const MAX_UPLOAD = 200 * 1024 * 1024; // 200 MB Obergrenze fürs Speichern

// Serverseitiger Speicher für Einstellungen & Unterschriften. Nur in der
// selbst gehosteten Variante aktiv – die öffentliche GitHub-Pages-Version hat
// kein Backend und bleibt damit automatisch rein lokal.
const DATA_DIR = env('DATA_DIR') || '/data/app';
const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
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
  ['index.html', 'sw.js', 'manifest.webmanifest', 'css', 'js'].forEach(walk);
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

const paperlessMode = PAPERLESS_URL && PAPERLESS_TOKEN ? 'api' : (CONSUME_DIR ? 'folder' : null);

/** PDF über die REST-API an Paperless übergeben. Liefert die Task-ID. */
async function uploadToPaperless(data, name, title) {
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

// -------------------------------------------------------------------- API

async function handleApi(req, res, url) {
  // Funktions-Status für die Web-App: welche Backend-Features sind aktiv?
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      scanner: !!SCANNER_HOST,
      consume: !!paperlessMode,
      paperless: paperlessMode,
      profile: profileEnabled,
      raw: !!RAW_DIR,
      version: VERSION,
    });
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

  // Scanner erreichbar? Modell zurückgeben.
  if (url.pathname === '/api/scanner/status' && req.method === 'GET') {
    if (!SCANNER_HOST) return sendJson(res, 501, { ok: false, error: 'Kein Scanner konfiguriert (SCANNER_HOST fehlt).' });
    try {
      const caps = await getCapabilities(SCANNER_HOST);
      return sendJson(res, 200, { ok: true, model: caps.model, host: SCANNER_HOST });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message, host: SCANNER_HOST });
    }
  }

  // Eine Seite scannen → Bild (JPEG) direkt zurückliefern.
  if (url.pathname === '/api/scanner/scan' && req.method === 'POST') {
    if (!SCANNER_HOST) return sendJson(res, 501, { error: 'Kein Scanner konfiguriert (SCANNER_HOST fehlt).' });
    const colorMode = url.searchParams.get('color') || 'color';
    const resolution = url.searchParams.get('dpi') || '300';
    const source = url.searchParams.get('source') || 'platen';
    try {
      const { buffer, contentType } = await scanPage(SCANNER_HOST, { colorMode, resolution, source });
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        // Auflösung mitgeben: damit kann die App aus der Pixelgröße die echten
        // Millimeter der Glasfläche berechnen und den A4-Ausschnitt exakt setzen.
        'X-Scan-Dpi': String(parseInt(resolution, 10) || 300),
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

server.listen(port, () => {
  console.log(`PDF Presser ${VERSION} läuft auf http://0.0.0.0:${port}`);
  console.log(`  Scanner:        ${SCANNER_HOST || '— (nicht konfiguriert)'}`);
  console.log(`  Paperless:      ${paperlessMode === 'api' ? `API ${PAPERLESS_URL}` : paperlessMode === 'folder' ? `Ordner ${CONSUME_DIR}` : '— (nicht konfiguriert)'}`);
  if (paperlessMode === 'api' && CONSUME_DIR) console.log(`                  Rückfall-Ordner: ${CONSUME_DIR}`);
  console.log(`  Profilspeicher: ${profileEnabled ? DATA_DIR : '— (nicht beschreibbar)'}`);
  console.log(`  Sammelordner:   ${RAW_DIR || '— (nicht konfiguriert)'}`);
});

// Sauber beenden (docker stop), damit laufende Schreibvorgänge fertig werden
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
