// PDF-Presser-Server: liefert die statische Web-App aus UND stellt die API
// für Netzwerk-Scanner (Epson eSCL) und das Ablegen in den Paperless-/NAS-Ordner
// bereit. Beides läuft same-origin, damit es aus dem Browser (auch am Handy)
// ohne CORS-Probleme funktioniert.
//
// Konfiguration über Umgebungsvariablen (siehe docker-compose.yml):
//   PORT          Port des Servers            (Standard 8823)
//   SCANNER_HOST  IP/Hostname des Scanners    (z. B. 192.168.1.50) – leer = Scanner-Funktion aus
//   CONSUME_DIR   Zielordner für fertige PDFs (z. B. /data/consume, ins NAS gemountet)

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

// -------------------------------------------------------------------- API

async function handleApi(req, res, url) {
  // Funktions-Status für die Web-App: welche Backend-Features sind aktiv?
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      scanner: !!SCANNER_HOST,
      consume: !!CONSUME_DIR,
      version: 1,
    });
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
      });
      return res.end(buffer);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
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
  console.log(`  Scanner:     ${SCANNER_HOST ? SCANNER_HOST : '— (nicht konfiguriert)'}`);
  console.log(`  Zielordner:  ${CONSUME_DIR ? CONSUME_DIR : '— (nicht konfiguriert)'}`);
  if (CONSUME_DIR && !fs.existsSync(CONSUME_DIR)) {
    console.log('  ⚠️  Zielordner existiert noch nicht – wird beim ersten Speichern angelegt.');
  }
});
