// PDF-Presser-Server: liefert die statische Web-App aus UND stellt die API
// für Netzwerk-Scanner (Epson eSCL) und das Ablegen in den Paperless-/NAS-Ordner
// bereit. Beides läuft same-origin, damit es aus dem Browser (auch am Handy)
// ohne CORS-Probleme funktioniert.
//
// Konfiguration über Umgebungsvariablen (siehe docker-compose.yml):
//   PORT          Port des Servers            (Standard 8823)
//   SCANNER_HOST  IP/Hostname des Scanners    (z. B. 192.168.1.50) – leer = Scanner-Funktion aus
//   CONSUME_DIR   Zielordner für fertige PDFs (z. B. /data/consume, ins NAS gemountet)
//   RAW_DIR       Sammelordner „Scanner_RAW“ für die Vorstufe (z. B. /data/raw)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCapabilities, scanPage } from './escl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // Repo-Wurzel = statische Web-App
const port = parseInt(process.env.PORT, 10) || 8823;
const SCANNER_HOST = (process.env.SCANNER_HOST || '').trim();
const CONSUME_DIR = (process.env.CONSUME_DIR || '').trim();
const MAX_UPLOAD = 200 * 1024 * 1024; // 200 MB Obergrenze fürs Speichern

// Serverseitiger Speicher für Einstellungen & Unterschriften. Nur in der
// selbst gehosteten Variante aktiv – die öffentliche GitHub-Pages-Version hat
// kein Backend und bleibt damit automatisch rein lokal.
const DATA_DIR = (process.env.DATA_DIR || '/data/app').trim();
const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
const MAX_PROFILE = 8 * 1024 * 1024; // Unterschriften sind Bilder – etwas Luft

// Sammelordner der Vorstufe („Paperless Prepare“): Hier landen Rohscans und
// Fotos, bis sie gesichtet, bearbeitet und an Paperless übergeben werden.
const RAW_DIR = (process.env.RAW_DIR || '').trim();
const RAW_EXT = /\.(pdf|jpe?g|png|webp|heic|heif|tiff?|bmp)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
  '.traineddata': 'application/octet-stream',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
  let base = path.basename(String(name || '').trim()).replace(/[^\w.\-() ]+/g, '_');
  if (!base || base === '.pdf') base = `scan_${Date.now()}.pdf`;
  if (!/\.pdf$/i.test(base)) base += '.pdf';
  return base;
}

// Dateiname im RAW-Ordner: nur der Name selbst, erlaubte Endung, kein Ausbruch
function safeRawName(name, fallbackExt = '.pdf') {
  let base = path.basename(String(name || '').trim()).replace(/[^\w.\-() ]+/g, '_');
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
async function freeRawName(name) {
  const safe = safeRawName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = safe;
  for (let i = 2; i < 500; i++) {
    try {
      await fsp.access(path.join(RAW_DIR, candidate));
      candidate = `${stem}_${i}${ext}`;
    } catch {
      return candidate;   // existiert nicht -> frei
    }
  }
  return `${stem}_${Date.now()}${ext}`;
}

// -------------------------------------------------------------------- API

async function handleApi(req, res, url) {
  // Funktions-Status für die Web-App: welche Backend-Features sind aktiv?
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      scanner: !!SCANNER_HOST,
      consume: !!CONSUME_DIR,
      profile: profileEnabled,
      raw: !!RAW_DIR,
      version: 3,
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

  // ---- Vorstufe „Paperless Prepare“: Sammelordner Scanner_RAW ----

  // Inhalt auflisten (nur Dateien, keine Unterordner)
  if (url.pathname === '/api/raw' && req.method === 'GET') {
    if (!RAW_DIR) return sendJson(res, 501, { error: 'Kein RAW-Ordner konfiguriert (RAW_DIR fehlt).' });
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
      files.sort((a, b) => a.modified - b.modified);   // älteste zuerst
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
    if (!RAW_DIR) return sendJson(res, 501, { error: 'Kein RAW-Ordner konfiguriert (RAW_DIR fehlt).' });
    try {
      const data = await readBody(req);
      if (!data.length) return sendJson(res, 400, { error: 'Leere Datei.' });
      await fsp.mkdir(RAW_DIR, { recursive: true });
      const name = await freeRawName(url.searchParams.get('name') || req.headers['x-filename']);
      // Erst .part schreiben, dann umbenennen – so sieht niemand halbe Dateien
      const finalPath = path.join(RAW_DIR, name);
      const tmpPath = path.join(RAW_DIR, `.${name}.part`);
      await fsp.writeFile(tmpPath, data);
      await fsp.rename(tmpPath, finalPath);
      return sendJson(res, 200, { ok: true, name, bytes: data.length });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Datei aus dem RAW-Ordner entfernen (nach der Übergabe an Paperless)
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

  // Fertiges PDF in den Paperless-/NAS-Ordner ablegen.
  if (url.pathname === '/api/save' && req.method === 'POST') {
    if (!CONSUME_DIR) return sendJson(res, 501, { error: 'Kein Zielordner konfiguriert (CONSUME_DIR fehlt).' });
    const name = safePdfName(url.searchParams.get('name') || req.headers['x-filename']);
    try {
      const data = await readBody(req);
      if (!data.length) return sendJson(res, 400, { error: 'Leere Datei.' });
      await fsp.mkdir(CONSUME_DIR, { recursive: true });
      // Atomar schreiben: erst .part, dann umbenennen – Paperless sieht nur fertige Dateien.
      const finalPath = path.join(CONSUME_DIR, name);
      const tmpPath = path.join(CONSUME_DIR, `.${name}.part`);
      await fsp.writeFile(tmpPath, data);
      await fsp.rename(tmpPath, finalPath);
      return sendJson(res, 200, { ok: true, name, bytes: data.length });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: 'Unbekannter API-Endpunkt' });
}

// -------------------------------------------------------------------- Statisch

async function serveStatic(req, res, url) {
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(root, urlPath);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
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
    } else {
      await serveStatic(req, res, url);
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
    else res.end();
  }
});

server.listen(port, () => {
  console.log(`PDF Presser läuft auf http://0.0.0.0:${port}`);
  console.log(`  Scanner:      ${SCANNER_HOST ? SCANNER_HOST : '— (nicht konfiguriert)'}`);
  console.log(`  Zielordner:   ${CONSUME_DIR ? CONSUME_DIR : '— (nicht konfiguriert)'}`);
  console.log(`  Profilspeicher: ${profileEnabled ? DATA_DIR : '— (nicht beschreibbar)'}`);
  console.log(`  RAW-Ordner:   ${RAW_DIR ? RAW_DIR : '— (nicht konfiguriert)'}`);
  if (CONSUME_DIR && !fs.existsSync(CONSUME_DIR)) {
    console.log('  ⚠️  Zielordner existiert noch nicht – wird beim ersten Speichern angelegt.');
  }
});
