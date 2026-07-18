// OCR mit tesseract.js – läuft komplett lokal (WASM + gebündelte Sprachdaten).

const base = (p) => new URL(p, import.meta.url).href;

let worker = null;
let workerLangs = null;
let progressCb = null;

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

async function getWorker(langs) {
  if (worker && workerLangs === langs) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  const { createWorker } = window.Tesseract;
  const core = hasWasmSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  worker = await createWorker(langs.split('+'), 1, {
    workerPath: base('../vendor/tesseract/worker.min.js'),
    corePath: base(`../vendor/tesseract/${core}`),
    langPath: base('../vendor/tessdata'),
    gzip: true,
    logger: (m) => {
      if (m.status === 'recognizing text' && progressCb) progressCb(m.progress);
    },
  });
  workerLangs = langs;
  return worker;
}

// Liefert eine flache Wortliste [{text, confidence, bbox:{x0,y0,x1,y1}}]
export async function recognizePage(canvas, langs, onProgress) {
  progressCb = onProgress || null;
  const w = await getWorker(langs || 'deu');
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
  progressCb = null;
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
  if (worker) {
    await worker.terminate();
    worker = null;
    workerLangs = null;
  }
}
