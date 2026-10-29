// OCR mit tesseract.js – läuft komplett lokal (WASM + gebündelte Sprachdaten).
//
// Tempo-Maßnahmen gegenüber der ersten Fassung:
//   * Die Worker bleiben zwischen zwei Dokumenten warm (erst nach einer Weile
//     Leerlauf wird aufgeräumt) – das Laden von WASM und Sprachmodell entfällt.
//   * Auf leistungsfähigen Rechnern arbeiten zwei Worker parallel an
//     verschiedenen Seiten; am Handy bleibt es aus Speichergründen bei einem.
//   * Die Seite wird als JPEG übergeben statt als Canvas – tesseract.js würde
//     sonst jede Seite als PNG kodieren und wieder dekodieren.
//   * Tesseract versucht nicht mehr jede unsichere Zeile zusätzlich invertiert
//     zu lesen (tessedit_do_invert) – bei Dokumenten fast immer überflüssig.

const base = (p) => new URL(p, import.meta.url).href;

const IDLE_MS = 120000;   // so lange bleiben die Worker nach dem letzten Auftrag geladen

// Texterkennung auf dem eigenen Server (nativer Tesseract) – am Handy um ein
// Vielfaches schneller als WebAssembly. Die App schaltet das ein, wenn der
// Server es anbietet; fällt er aus, wird lokal weitergerechnet.
let server = null;   // { langs: [] } oder null
export function setServerOcr(info) { server = info && info.langs?.length ? info : null; }
const serverCan = (langs) => !!server && langs.split('+').every((l) => server.langs.includes(l));
export const usesServerOcr = (langs = 'deu') => serverCan(langs);

let pool = null;          // { langs, scheduler, size, ready: Promise }
let idleTimer = null;

// WASM-SIMD-Erkennung (Testmodul aus wasm-feature-detect) – ältere
// iPhones/Browser ohne SIMD bekommen den kompatiblen Core.
function hasWasmSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
      10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

/**
 * Wie viele Worker lohnen sich auf diesem Gerät? Gemessen auf 4 Kernen:
 * zwei Worker halbieren die OCR-Zeit fast. Am Handy entscheidet der Speicher –
 * dort nur mit nachweislich viel RAM (Safari verrät ihn nicht -> ein Worker).
 */
export const isMobileDevice = () => /iPhone|iPad|Android/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;

export function ocrWorkerCount() {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  const mobile = isMobileDevice();
  if (mobile) return cores >= 6 && mem >= 6 ? 2 : 1;
  if (cores >= 12 && mem >= 8) return 3;
  return cores >= 4 ? 2 : 1;
}

async function createPool(langs) {
  const { createWorker, createScheduler } = window.Tesseract;
  const core = hasWasmSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  const size = ocrWorkerCount();
  const scheduler = createScheduler();
  const make = async () => {
    const w = await createWorker(langs.split('+'), 1, {
      workerPath: base('../vendor/tesseract/worker.min.js'),
      corePath: base(`../vendor/tesseract/${core}`),
      langPath: base('../vendor/tessdata'),
      gzip: true,
    });
    try {
      await w.setParameters({ tessedit_do_invert: '0' });
    } catch { /* ältere Kerne kennen den Parameter nicht – kein Problem */ }
    scheduler.addWorker(w);
  };
  // Der erste Worker reicht zum Loslegen; weitere kommen im Hintergrund dazu.
  await make();
  for (let i = 1; i < size; i++) make().catch(() => { /* einer genügt */ });
  return { langs, scheduler, size };
}

function getPool(langs) {
  clearTimeout(idleTimer);
  if (pool && pool.langs === langs) return pool.ready;
  const old = pool;
  pool = { langs, ready: null };
  const mine = pool;
  mine.ready = (async () => {
    if (old) await old.ready.then((p) => p.scheduler.terminate()).catch(() => {});
    const p = await createPool(langs);
    Object.assign(mine, p);
    return p;
  })();
  mine.ready.catch(() => { if (pool === mine) pool = null; });
  return mine.ready;
}

/**
 * Wie viele Seiten gleichzeitig erkannt werden: der Server arbeitet mehrere
 * Seiten parallel ab, im Browser entscheidet die Zahl der Worker.
 */
export function ocrParallel(langs = 'deu') {
  return serverCan(langs) ? 3 : ocrWorkerCount();
}

/** Worker schon einmal hochfahren, während z. B. die erste Seite gerendert wird. */
export function warmOcr(langs = 'deu') {
  if (serverCan(langs)) return;
  getPool(langs).catch(() => { /* Fehler zeigt sich beim echten Auftrag */ });
}

/** Nach getaner Arbeit: Worker nach einer Leerlaufzeit freigeben. */
export function releaseOcrSoon() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { disposeOcr(); }, IDLE_MS);
}

/**
 * Erkennt eine Seite. `image` ist ein Blob (JPEG/PNG) oder Canvas.
 * Liefert eine flache Wortliste [{text, confidence, bbox:{x0,y0,x1,y1}}].
 */
export async function recognizePage(image, langs = 'deu', { dpi = 300 } = {}) {
  langs = langs || 'deu';
  if (serverCan(langs) && image instanceof Blob) {
    try {
      const res = await fetch(`/api/ocr?lang=${encodeURIComponent(langs)}&dpi=${Math.round(dpi)}`, {
        method: 'POST',
        headers: { 'Content-Type': image.type || 'image/jpeg' },
        body: image,
      });
      if (res.ok) {
        const { words } = await res.json();
        return words.filter((w) => (w.confidence ?? 0) >= 25 && w.bbox);
      }
      if (res.status === 501) server = null;   // Server kann es (nicht mehr) – lokal weiter
    } catch {
      // Netz weg (z. B. offline unterwegs): lokal weiterrechnen
    }
  }
  const p = await getPool(langs);
  const { data } = await p.scheduler.addJob('recognize', image, {}, { blocks: true, text: false });
  const words = [];
  for (const block of data.blocks || []) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        for (const word of line.words || []) {
          if ((word.confidence ?? 0) >= 25 && word.bbox) words.push(word);
        }
      }
    }
  }
  return words;
}

export async function disposeOcr() {
  clearTimeout(idleTimer);
  const p = pool;
  pool = null;
  if (p) {
    try { await (await p.ready).scheduler.terminate(); } catch { /* schon weg */ }
  }
}
