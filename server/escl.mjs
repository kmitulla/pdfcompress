// Minimaler eSCL-/AirScan-Client für Netzwerk-Scanner (z. B. Epson ET-2720).
//
// eSCL ist ein HTTP-basiertes Scan-Protokoll (dasselbe, das macOS/iOS als
// „AirScan" und Linux als „sane-airscan" nutzt). Der Epson ET-2720 unterstützt
// es out of the box, sobald er im WLAN/LAN hängt. Wir sprechen es direkt über
// Node an – kein Treiber, keine SANE-Installation nötig.
//
// Ablauf:
//   1. GET  {base}/ScannerCapabilities   → prüfen, ob erreichbar (XML)
//   2. POST {base}/ScanJobs              → Scan starten, Location-Header zeigt auf den Job
//   3. GET  {Location}/NextDocument      → Bilddaten der Seite abholen (404 = keine weitere Seite)

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const NS = {
  scan: 'http://schemas.hp.com/imaging/escl/2011/05/03',
  pwg: 'http://www.pwg.org/schemas/2010/12/sm',
};

// ColorMode-Werte laut eSCL-Spezifikation.
const COLOR_MODES = {
  color: 'RGB24',
  gray: 'Grayscale8',
  bw: 'BlackAndWhite1',
};

/** Basis-URL des Scanners normalisieren, inkl. eSCL-Pfad. */
export function scannerBase(host) {
  let raw = (host || '').trim();
  if (!raw) throw new Error('Keine Scanner-Adresse (SCANNER_HOST) gesetzt.');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const u = new URL(raw);
  // Pfad auf .../eSCL normalisieren (ohne doppelte Slashes / Trailing-Slash)
  let path = u.pathname.replace(/\/+$/, '');
  if (!/\/escl$/i.test(path)) path = `${path}/eSCL`;
  u.pathname = path;
  return u.toString();
}

/** Ein einzelner HTTP-Request, gibt {status, headers, body:Buffer} zurück. */
function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 60000 } = {}) {
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    headers,
    timeout,
    // Scanner haben nur ein selbstsigniertes Zertifikat – im LAN ok.
    rejectUnauthorized: false,
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Scanner')));
    if (body) req.write(body);
    req.end();
  });
}

/** Erreichbarkeit/Fähigkeiten prüfen. Wirft bei Nichterreichbarkeit. */
export async function getCapabilities(host) {
  const base = scannerBase(host);
  const res = await request(`${base}/ScannerCapabilities`, { timeout: 8000 });
  if (res.status !== 200) {
    throw new Error(`Scanner antwortet mit HTTP ${res.status} auf ScannerCapabilities`);
  }
  const xml = res.body.toString('utf8');
  const model = (xml.match(/<pwg:MakeAndModel>([^<]+)</i) || [])[1] || 'Unbekannt';
  return { base, model, raw: xml };
}

function buildScanSettings({ colorMode, resolution, source }) {
  const cm = COLOR_MODES[colorMode] || COLOR_MODES.color;
  const res = parseInt(resolution, 10) || 300;
  const input = source === 'adf' ? 'Feeder' : 'Platen';
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="${NS.scan}" xmlns:pwg="${NS.pwg}">
  <pwg:Version>2.6</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:InputSource>${input}</pwg:InputSource>
  <scan:ColorMode>${cm}</scan:ColorMode>
  <scan:XResolution>${res}</scan:XResolution>
  <scan:YResolution>${res}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>`;
}

/**
 * Eine Seite von der Auflagefläche (oder Blatt aus dem Einzug) scannen.
 * @returns {Promise<{buffer:Buffer, contentType:string}>}
 */
export async function scanPage(host, { colorMode = 'color', resolution = 300, source = 'platen' } = {}) {
  const base = scannerBase(host);
  const settings = buildScanSettings({ colorMode, resolution, source });

  const start = await request(`${base}/ScanJobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(settings),
    },
    body: settings,
    timeout: 15000,
  });

  if (start.status !== 201) {
    const hint = start.status === 409
      ? ' (Scanner ist gerade beschäftigt – Deckel zu? Anderer Scan aktiv?)'
      : start.status === 503
        ? ' (Scanner belegt oder im Energiesparmodus – kurz warten und neu versuchen)'
        : '';
    throw new Error(`Scan-Auftrag abgelehnt: HTTP ${start.status}${hint}`);
  }

  let location = start.headers.location;
  if (!location) throw new Error('Scanner lieferte keinen Job-Verweis (Location-Header fehlt).');
  // Manche Geräte liefern nur einen relativen Pfad.
  if (!/^https?:\/\//i.test(location)) {
    const u = new URL(base);
    location = `${u.protocol}//${u.host}${location.startsWith('/') ? '' : '/'}${location}`;
  }

  // Bilddaten abholen (bei ADF käme hier ggf. mehr als eine Seite – wir holen die erste).
  const doc = await request(`${location.replace(/\/$/, '')}/NextDocument`, { timeout: 120000 });
  if (doc.status === 404) {
    throw new Error('Scanner lieferte keine Seite (Auflagefläche leer oder Auftrag abgebrochen).');
  }
  if (doc.status !== 200) {
    throw new Error(`Seite konnte nicht abgeholt werden: HTTP ${doc.status}`);
  }
  const contentType = doc.headers['content-type'] || 'image/jpeg';
  return { buffer: doc.body, contentType };
}
