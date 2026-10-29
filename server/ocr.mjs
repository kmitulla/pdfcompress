// Texterkennung auf dem Server mit dem nativen Tesseract.
//
// Am Handy ist Tesseract als WebAssembly sehr langsam (und kämpft mit dem
// Speicher); der Server erledigt dieselbe Seite in wenigen Sekunden. Die App
// schickt die Seite als JPEG, der Server liefert die Wörter mit Position –
// den unsichtbaren Textlayer baut weiterhin die App ins PDF.
// Ist kein Tesseract installiert, meldet /api/config „ocr: false“ und die App
// rechnet wie bisher selbst.

import { spawn, execFile } from 'node:child_process';
import os from 'node:os';

const BIN = process.env.TESSERACT_BIN || 'tesseract';
// Mehrere Seiten gleichzeitig – aber einen Kern für Server & Scanner frei lassen
const MAX_PARALLEL = Math.max(1, Math.min(4, (os.availableParallelism?.() || os.cpus().length) - 1));
const TIMEOUT_MS = 180000;

let info = null;   // { version, langs: [] } oder null
let running = 0;
const waiting = [];

/** Prüfen, ob Tesseract da ist und welche Sprachen es kennt. */
export function detectOcr() {
  return new Promise((resolve) => {
    execFile(BIN, ['--list-langs'], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) { info = null; resolve(null); return; }
      const langs = `${stdout}\n${stderr}`.split('\n').map((s) => s.trim()).filter((s) => /^[a-z_]{3,}$/i.test(s) && s !== 'osd');
      execFile(BIN, ['--version'], { timeout: 8000 }, (e2, out2, err2) => {
        const m = /tesseract\s+v?([\d.]+)/i.exec(`${out2}\n${err2}`);
        info = { version: m ? m[1] : '?', langs, parallel: MAX_PARALLEL };
        resolve(info);
      });
    });
  });
}

export const ocrInfo = () => info;

function acquire() {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve(); }
  return new Promise((r) => waiting.push(r));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

/** TSV von Tesseract → Wortliste wie bei tesseract.js. */
export function parseTsv(tsv) {
  const words = [];
  for (const line of tsv.split('\n')) {
    const c = line.split('\t');
    // level page block par line word left top width height conf text
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    const conf = parseFloat(c[10]);
    if (!text || !(conf >= 0)) continue;
    const x0 = +c[6];
    const y0 = +c[7];
    words.push({ text, confidence: conf, bbox: { x0, y0, x1: x0 + +c[8], y1: y0 + +c[9] } });
  }
  return words;
}

/**
 * Eine Seite erkennen.
 * @param {Buffer} image JPEG/PNG
 * @param {{lang?: string, dpi?: number}} opts
 */
export async function recognize(image, { lang = 'deu', dpi = 300 } = {}) {
  if (!info) throw new Error('Tesseract ist auf dem Server nicht installiert.');
  const langs = String(lang).split('+').filter((l) => info.langs.includes(l));
  if (!langs.length) throw new Error(`Sprache „${lang}“ fehlt auf dem Server.`);
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      const args = ['stdin', 'stdout', '-l', langs.join('+'), '--oem', '1', '--psm', '3',
        '--dpi', String(Math.round(dpi) || 300), '-c', 'tessedit_do_invert=0', 'tsv'];
      // Ein Thread je Prozess – parallel laufen lieber mehrere Seiten
      const proc = spawn(BIN, args, { env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
      const out = [];
      let err = '';
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Texterkennung dauerte zu lange')); }, TIMEOUT_MS);
      proc.stdout.on('data', (d) => out.push(d));
      proc.stderr.on('data', (d) => { err += d; });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`Tesseract-Fehler (${code}): ${err.slice(0, 200)}`)); return; }
        resolve(parseTsv(Buffer.concat(out).toString('utf8')));
      });
      proc.stdin.on('error', () => { /* Prozess schon beendet */ });
      proc.stdin.end(image);
    });
  } finally {
    release();
  }
}
