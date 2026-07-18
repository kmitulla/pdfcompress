// OCR mit tesseract.js – läuft komplett lokal (WASM + gebündelte Sprachdaten).

const base = (p) => new URL(p, import.meta.url).href;

let worker = null;
let workerLangs = null;
let progressCb = null;

async function getWorker(langs) {
  if (worker && workerLangs === langs) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  const { createWorker } = window.Tesseract;
  worker = await createWorker(langs.split('+'), 1, {
    workerPath: base('../vendor/tesseract/worker.min.js'),
    corePath: base('../vendor/tesseract/tesseract-core-simd-lstm.wasm.js'),
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
