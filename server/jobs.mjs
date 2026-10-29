// Scan-Aufträge, die auf dem Server laufen – unabhängig davon, ob die App
// offen ist. Jede Seite wird sofort auf die Platte geschrieben
// (DATA_DIR/jobs/<id>/), der Auftrag als job.json daneben. Die App holt die
// Seiten ab, sobald sie (wieder) offen ist, und löscht den Auftrag erst, wenn
// daraus ein Dokument geworden ist. So geht kein angefangener Scan verloren.
//
// Es läuft immer nur ein Auftrag; der Scanner kann ohnehin nur eine Seite
// gleichzeitig. Wird der Server neu gestartet, bleiben bereits gescannte
// Seiten erhalten, der Auftrag gilt als „unterbrochen“.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const KEEP_DAYS = 7;
const MAX_PAGES = 50;

let dir = null;
let scanFn = null;            // (opts, signal) => {buffer, contentType, dpi, colorMode, wanted}
let rawWriter = null;          // (name, buffer) => finalName
const jobs = new Map();        // id -> job
let active = null;             // {job, abort:AbortController, wake:fn}

const jobDir = (id) => path.join(dir, id);
const p2 = (v) => String(v).padStart(2, '0');
function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}

async function persist(job) {
  const d = jobDir(job.id);
  await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(d, 'job.json.tmp'), JSON.stringify(job));
  await fsp.rename(path.join(d, 'job.json.tmp'), path.join(d, 'job.json'));
}

/** Beim Start: gespeicherte Aufträge laden, abgebrochene markieren, Altes löschen. */
export function initJobs({ dataDir, scan, writeRaw }) {
  dir = path.join(dataDir, 'jobs');
  scanFn = scan;
  rawWriter = writeRaw;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
  for (const id of fs.readdirSync(dir)) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, id, 'job.json'), 'utf8'));
      if (Date.now() - job.created > KEEP_DAYS * 864e5) {
        fs.rmSync(path.join(dir, id), { recursive: true, force: true });
        continue;
      }
      if (job.status === 'running' || job.status === 'waiting' || job.status === 'queued') {
        job.status = 'interrupted';
        job.message = 'Server wurde neu gestartet – bereits gescannte Seiten sind gesichert.';
        job.nextAt = null;
        fs.writeFileSync(path.join(dir, id, 'job.json'), JSON.stringify(job));
      }
      jobs.set(id, job);
    } catch {
      fs.rmSync(path.join(dir, id), { recursive: true, force: true });
    }
  }
}

const isLive = (job) => job.status === 'running' || job.status === 'waiting' || job.status === 'queued';

export function listJobs() {
  return [...jobs.values()].sort((a, b) => a.created - b.created).map(view);
}

export function getJob(id) {
  const j = jobs.get(id);
  return j ? view(j) : null;
}

function view(job) {
  return { ...job, live: isLive(job), now: Date.now() };
}

export function activeJob() {
  return active ? view(active.job) : null;
}

export async function pageFile(id, n) {
  const job = jobs.get(id);
  const page = job?.pages.find((p) => p.n === n);
  if (!page || !page.file) return null;
  return { data: await fsp.readFile(path.join(jobDir(id), page.file)), page };
}

/** Neuen Auftrag anlegen und im Hintergrund abarbeiten. */
export async function createJob(opts) {
  if (active) {
    const err = new Error('Es läuft bereits ein Scan.');
    err.status = 409;
    err.job = view(active.job);
    throw err;
  }
  const pages = Math.max(1, Math.min(MAX_PAGES, parseInt(opts.pages, 10) || 1));
  const delay = Math.max(0, Math.min(120, parseInt(opts.delay, 10) || 0));
  const job = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    created: Date.now(),
    total: pages,
    delay,
    dpi: String(opts.dpi || '300'),
    color: ['color', 'gray', 'bw'].includes(opts.color) ? opts.color : 'color',
    target: opts.target === 'raw' ? 'raw' : 'doc',
    label: String(opts.label || '').slice(0, 80),
    status: 'queued',
    message: '',
    error: null,
    nextAt: null,
    pages: [],
  };
  jobs.set(job.id, job);
  await persist(job);
  run(job);
  return view(job);
}

/** Unterbrochenen/gestoppten Auftrag fortsetzen (ab der nächsten Seite). */
export async function resumeJob(id, { more = 0 } = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  if (active) {
    const err = new Error('Es läuft bereits ein Scan.');
    err.status = 409;
    throw err;
  }
  if (more > 0) job.total = Math.min(MAX_PAGES, Math.max(job.total, job.pages.length) + more);
  if (job.pages.length >= job.total) job.total = Math.min(MAX_PAGES, job.pages.length + 1);
  job.status = 'queued';
  job.error = null;
  job.message = '';
  // Nach einer Unterbrechung nicht erst die Pause abwarten
  job.resumed = job.pages.length;
  await persist(job);
  run(job);
  return view(job);
}

/** Pause überspringen: nächste Seite sofort scannen. */
export function skipWait(id) {
  if (!active || active.job.id !== id) return false;
  active.wake?.();
  return true;
}

/** Auftrag beenden – fertige Seiten bleiben. */
export async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (active && active.job.id === id) {
    active.cancelled = true;
    active.abort.abort();
    active.wake?.();
  }
  if (isLive(job)) {
    job.status = 'cancelled';
    job.nextAt = null;
    job.message = job.pages.length ? 'Gestoppt – eingelesene Seiten bleiben.' : 'Gestoppt.';
    await persist(job);
  }
  return view(job);
}

/** Auftrag samt Seiten entfernen (wenn die App daraus ein Dokument gemacht hat). */
export async function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (active && active.job.id === id) await cancelJob(id);
  jobs.delete(id);
  await fsp.rm(jobDir(id), { recursive: true, force: true });
  return true;
}

async function run(job) {
  const ctl = { job, abort: new AbortController(), wake: null, cancelled: false };
  active = ctl;
  try {
    for (let i = job.pages.length; i < job.total; i++) {
      if (ctl.cancelled) break;
      if (i > 0 && job.delay > 0 && i !== job.resumed) {
        job.status = 'waiting';
        job.nextAt = Date.now() + job.delay * 1000;
        job.message = `Nächste Seite in ${job.delay} s – Vorlage wechseln`;
        await persist(job);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, job.delay * 1000);
          ctl.wake = () => { clearTimeout(t); resolve(); };
        });
        ctl.wake = null;
        if (ctl.cancelled) break;
      }
      job.status = 'running';
      job.nextAt = null;
      job.message = `Seite ${i + 1} von ${job.total} wird gescannt …`;
      await persist(job);
      let res;
      try {
        res = await scanFn({ resolution: job.dpi, colorMode: job.color, signal: ctl.abort.signal });
      } catch (e) {
        if (ctl.cancelled) break;
        throw e;
      }
      if (ctl.cancelled) break;   // Seite kam nach dem Stopp – verwerfen
      const n = i + 1;
      const page = { n, dpi: res.dpi, colorMode: res.colorMode, wanted: res.wanted, bytes: res.buffer.length, type: res.contentType, at: Date.now() };
      if (job.target === 'raw' && rawWriter) {
        // Ein Auftrag = ein Zeitstempel; Seitennummer und Auflösung im Namen
        page.raw = await rawWriter(`Scan_${stampOf(job.created)}_S${String(n).padStart(2, '0')}_${res.dpi}dpi.jpg`, res.buffer);
      } else {
        page.file = `page-${String(n).padStart(3, '0')}.jpg`;
        await fsp.writeFile(path.join(jobDir(job.id), page.file), res.buffer);
      }
      job.pages.push(page);
      await persist(job);
    }
    if (!ctl.cancelled) {
      job.status = 'done';
      job.nextAt = null;
      job.message = `${job.pages.length} ${job.pages.length === 1 ? 'Seite' : 'Seiten'} eingelesen`;
      await persist(job);
    }
  } catch (e) {
    job.status = 'error';
    job.nextAt = null;
    job.error = String(e?.message || e);
    job.message = job.pages.length ? `Fehler nach ${job.pages.length} Seite(n) – diese bleiben erhalten.` : 'Scan fehlgeschlagen.';
    await persist(job).catch(() => {});
  } finally {
    if (active === ctl) active = null;
    // Sammelordner-Aufträge brauchen keinen Abholer – die Dateien liegen schon
    // im Ordner. Nach einer Weile aufräumen.
    if (job.target === 'raw') setTimeout(() => { if (jobs.has(job.id)) deleteJob(job.id); }, 15 * 60 * 1000).unref();
  }
}

/** Für den sauberen Shutdown: laufenden Auftrag merken lassen. */
export async function shutdownJobs() {
  if (!active) return;
  const job = active.job;
  active.cancelled = true;
  active.abort.abort();
  active.wake?.();
  job.status = 'interrupted';
  job.message = 'Server wurde beendet – bereits gescannte Seiten sind gesichert.';
  job.nextAt = null;
  await persist(job).catch(() => {});
}
