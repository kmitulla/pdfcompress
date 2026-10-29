// eSCL-/AirScan-Client für Netzwerk-Scanner (z. B. Epson ET-2720).
//
// eSCL ist das HTTP-Scanprotokoll, das macOS/iOS („AirScan“) und Linux
// („sane-airscan“) nutzen. Wir sprechen es direkt an – kein Treiber nötig.
//
// Ablauf:
//   1. GET  {base}/ScannerCapabilities  → was kann das Gerät (dpi, Farbmodi, Glasfläche)
//   2. GET  {base}/ScannerStatus        → ist es frei? hängt noch ein alter Auftrag?
//   3. POST {base}/ScanJobs             → Scan starten (Location zeigt auf den Auftrag)
//   4. GET  {Location}/NextDocument     → Bilddaten abholen
//
// Wichtig für die Zuverlässigkeit: Viele Geräte lehnen Einstellungen, die sie
// nicht kennen, mit „409 Conflict“ ab – z. B. 150 dpi, wenn nur 100/200/300/600
// angeboten werden, oder Schwarz-Weiß zusammen mit JPEG (1-Bit-JPEG gibt es
// nicht). Deshalb werden die Wünsche immer auf das abgebildet, was das Gerät
// laut seinen Fähigkeiten wirklich unterstützt.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const NS = {
  scan: 'http://schemas.hp.com/imaging/escl/2011/05/03',
  pwg: 'http://www.pwg.org/schemas/2010/12/sm',
};

/** Basis-URL des Scanners normalisieren, inkl. eSCL-Pfad. */
export function scannerBase(host) {
  let raw = (host || '').trim();
  if (!raw) throw new Error('Keine Scanner-Adresse gesetzt.');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const u = new URL(raw);
  let p = u.pathname.replace(/\/+$/, '');
  if (!/\/escl$/i.test(p)) p = `${p}/eSCL`;
  u.pathname = p;
  return u.toString().replace(/\/$/, '');
}

/** Ein einzelner HTTP-Request, gibt {status, headers, body:Buffer} zurück. */
export function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 60000 } = {}) {
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    headers,
    timeout,
    rejectUnauthorized: false,   // Scanner haben nur ein selbstsigniertes Zertifikat
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Scanner')));
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tagAll = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'gi'))].map((m) => m[1].trim());
const tagOne = (xml, tag) => tagAll(xml, tag)[0];
const section = (xml, tag) => {
  const m = new RegExp(`<(?:\\w+:)?${tag}[\\s>][\\s\\S]*?</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return m ? m[0] : '';
};

/** Fähigkeiten aus dem XML lesen (Glasfläche). */
export function parseCapabilities(xml) {
  const platen = section(xml, 'Platen') || xml;
  const resolutions = new Set();
  for (const block of platen.match(/<(?:\w+:)?DiscreteResolution>[\s\S]*?<\/(?:\w+:)?DiscreteResolution>/gi) || []) {
    const x = parseInt(tagOne(block, 'XResolution'), 10);
    const y = parseInt(tagOne(block, 'YResolution'), 10);
    if (x && (!y || y === x)) resolutions.add(x);
  }
  const range = section(platen, 'XResolutionRange');
  if (range) {
    const min = parseInt(tagOne(range, 'Min'), 10);
    const max = parseInt(tagOne(range, 'Max'), 10);
    const step = parseInt(tagOne(range, 'Step'), 10) || 1;
    for (const d of [75, 100, 150, 200, 300, 400, 600, 1200]) {
      if (d >= min && d <= max && (d - min) % step === 0) resolutions.add(d);
    }
  }
  const colorModes = [...new Set(tagAll(platen, 'ColorMode'))];
  const formats = [...new Set([...tagAll(platen, 'DocumentFormat'), ...tagAll(platen, 'DocumentFormatExt')])];
  return {
    model: tagOne(xml, 'MakeAndModel') || 'Scanner',
    version: tagOne(xml, 'Version') || '2.0',
    resolutions: [...resolutions].sort((a, b) => a - b),
    colorModes,
    formats,
    // Glasfläche in 1/300 Zoll
    maxWidth: parseInt(tagOne(platen, 'MaxWidth'), 10) || null,
    maxHeight: parseInt(tagOne(platen, 'MaxHeight'), 10) || null,
  };
}

const capsCache = new Map();   // host -> {at, caps}

/** Erreichbarkeit/Fähigkeiten prüfen (5 Minuten zwischengespeichert). */
export async function getCapabilities(host, { fresh = false } = {}) {
  const hit = capsCache.get(host);
  if (!fresh && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.caps;
  const base = scannerBase(host);
  const res = await request(`${base}/ScannerCapabilities`, { timeout: 8000 });
  if (res.status !== 200) throw new Error(`Scanner antwortet mit HTTP ${res.status} auf ScannerCapabilities`);
  const xml = res.body.toString('utf8');
  const caps = { base, ...parseCapabilities(xml), raw: xml };
  capsCache.set(host, { at: Date.now(), caps });
  return caps;
}

/**
 * Gewünschte Einstellungen auf das abbilden, was das Gerät kann.
 * Liefert {dpi, colorMode, wantedColor} – colorMode ist der eSCL-Wert.
 */
export function chooseSettings(caps, { resolution = 300, colorMode = 'color' } = {}) {
  const want = parseInt(resolution, 10) || 300;
  const list = caps?.resolutions?.length ? caps.resolutions : [want];
  // nächstgelegene Auflösung, bei Gleichstand die höhere
  const dpi = list.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want)
    || (Math.abs(d - want) === Math.abs(best - want) && d > best) ? d : best), list[0]);
  const modes = caps?.colorModes?.length ? caps.colorModes : ['RGB24'];
  const has = (m) => modes.includes(m);
  // 1-Bit gibt es als JPEG nicht – Schwarz-Weiß wird als Graustufen gescannt
  // und erst in der App zu sauberem 1-Bit (die Kompression macht das ohnehin).
  let mode = 'RGB24';
  if ((colorMode === 'gray' || colorMode === 'bw') && has('Grayscale8')) mode = 'Grayscale8';
  if (!has(mode)) mode = modes.find((m) => /RGB/i.test(m)) || modes[0];
  return { dpi, colorMode: mode, wanted: colorMode };
}

function buildScanSettings(caps, { dpi, colorMode, source = 'platen' }) {
  const input = source === 'adf' ? 'Feeder' : 'Platen';
  // Volle Glasfläche als Region – manche Geräte (Epson) erwarten sie ausdrücklich.
  const region = caps?.maxWidth && caps?.maxHeight ? `
  <pwg:ScanRegions pwg:MustHonor="false">
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${caps.maxWidth}</pwg:Width>
      <pwg:Height>${caps.maxHeight}</pwg:Height>
    </pwg:ScanRegion>
  </pwg:ScanRegions>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="${NS.scan}" xmlns:pwg="${NS.pwg}" xmlns:escl="${NS.scan}">
  <pwg:Version>${caps?.version || '2.0'}</pwg:Version>
  <scan:Intent>Document</scan:Intent>${region}
  <pwg:InputSource>${input}</pwg:InputSource>
  <scan:ColorMode>${colorMode}</scan:ColorMode>
  <scan:XResolution>${dpi}</scan:XResolution>
  <scan:YResolution>${dpi}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>`;
}

/** Status lesen: {state, jobs:[{uri, state}]} */
export async function getStatus(base) {
  const res = await request(`${base}/ScannerStatus`, { timeout: 8000 });
  if (res.status !== 200) return { state: 'Unknown', jobs: [] };
  const xml = res.body.toString('utf8');
  const jobs = [];
  for (const block of xml.match(/<(?:\w+:)?JobInfo>[\s\S]*?<\/(?:\w+:)?JobInfo>/gi) || []) {
    jobs.push({ uri: tagOne(block, 'JobUri'), state: tagOne(block, 'JobState') });
  }
  const state = tagOne(section(xml, 'ScannerStatus') || xml, 'State') || 'Unknown';
  return { state, jobs };
}

function absJobUrl(base, location) {
  if (/^https?:\/\//i.test(location)) return location.replace(/\/$/, '');
  const u = new URL(base);
  return `${u.protocol}//${u.host}${location.startsWith('/') ? '' : '/'}${location}`.replace(/\/$/, '');
}

/** Hängende Aufträge abräumen und warten, bis das Gerät frei ist. */
export async function ensureIdle(base, maxWaitMs = 25000) {
  const until = Date.now() + maxWaitMs;
  let cleaned = false;
  for (;;) {
    let st;
    try { st = await getStatus(base); } catch { return; }   // Status unbekannt: einfach versuchen
    if (/idle/i.test(st.state)) return;
    if (!cleaned) {
      cleaned = true;
      for (const j of st.jobs.filter((x) => x.uri && /Processing|Pending/i.test(x.state || ''))) {
        try { await finishJob(absJobUrl(base, j.uri)); } catch { /* weiter */ }
      }
    }
    if (Date.now() > until) return;
    await sleep(1200);
  }
}

// Auftrag sauber abschließen, sonst bleibt der Scanner „belegt“ und der nächste
// Auftrag scheitert mit 409/503.
// Ein weiteres NextDocument mit 404 heißt „Auftrag fertig“; bleibt der
// Auftrag offen, wird er gelöscht.
async function finishJob(jobUrl) {
  let done = false;
  try {
    const r = await request(`${jobUrl}/NextDocument`, { timeout: 15000 });
    done = r.status === 404;
  } catch { /* egal */ }
  if (!done) {
    try { await request(jobUrl, { method: 'DELETE', timeout: 8000 }); } catch { /* egal */ }
  }
}

async function startJob(base, xml) {
  return request(`${base}/ScanJobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) },
    body: xml,
    timeout: 20000,
  });
}

/**
 * Eine Seite scannen.
 * @returns {Promise<{buffer, contentType, dpi, colorMode, wanted}>}
 */
export async function scanPage(host, { colorMode = 'color', resolution = 300, source = 'platen', signal } = {}) {
  const caps = await getCapabilities(host).catch(() => null);
  const base = caps?.base || scannerBase(host);
  let chosen = chooseSettings(caps, { resolution, colorMode });

  await ensureIdle(base);
  let start = null;
  let lastStatus = 0;
  // Bis zu vier Versuche: bei „belegt“ abräumen und warten; bei abgelehnter
  // Einstellung auf die sichere Kombination (Farbe) zurückfallen.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new Error('abgebrochen');
    start = await startJob(base, buildScanSettings(caps, { ...chosen, source }));
    if (start.status === 201) break;
    lastStatus = start.status;
    if (start.status === 409 || start.status === 503) {
      // 503 = beschäftigt → warten. 409 bei freiem Gerät heißt dagegen meist:
      // diese Kombination mag es nicht → auf die sichere Farbe ausweichen.
      if (start.status === 409 && attempt >= 1 && chosen.colorMode !== 'RGB24') {
        const st = await getStatus(base).catch(() => null);
        if (/idle/i.test(st?.state || '')) chosen = { ...chosen, colorMode: 'RGB24' };
      }
      await ensureIdle(base, 15000);
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (start.status === 400 && chosen.colorMode !== 'RGB24') {
      chosen = { ...chosen, colorMode: 'RGB24' };
      continue;
    }
    break;
  }
  if (!start || start.status !== 201) {
    const hint = lastStatus === 409 || start?.status === 409
      ? ' (Scanner belegt – Deckel zu? Läuft am Gerät noch etwas? Notfalls kurz aus- und einschalten.)'
      : '';
    throw new Error(`Scan-Auftrag abgelehnt: HTTP ${start?.status || lastStatus}${hint}`);
  }
  const location = start.headers.location;
  if (!location) throw new Error('Scanner lieferte keinen Auftrags-Verweis (Location-Header fehlt).');
  const jobUrl = absJobUrl(base, location);

  let doc;
  try {
    // Manche Geräte melden kurz 503, solange die Seite noch eingezogen wird
    for (let i = 0; i < 20; i++) {
      doc = await request(`${jobUrl}/NextDocument`, { timeout: 120000 });
      if (doc.status !== 503) break;
      await sleep(1000);
    }
  } catch (e) {
    await finishJob(jobUrl);
    throw e;
  }
  if (doc.status !== 200) {
    await finishJob(jobUrl);
    if (doc.status === 404) throw new Error('Scanner lieferte keine Seite (Auftrag abgebrochen?).');
    throw new Error(`Seite konnte nicht abgeholt werden: HTTP ${doc.status}`);
  }
  await finishJob(jobUrl);
  return {
    buffer: doc.body,
    contentType: doc.headers['content-type'] || 'image/jpeg',
    dpi: chosen.dpi,
    colorMode: chosen.colorMode,
    wanted: chosen.wanted,
  };
}
