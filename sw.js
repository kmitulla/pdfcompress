// Service Worker: precached alle Assets, damit die App komplett offline läuft.
const CACHE = 'pdfpresser-v8';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/compressor.js',
  './js/ccitt-g4.js',
  './js/ocr.js',
  './js/editor.js',
  './js/scanner.js',
  './js/signature.js',
  './js/store.js',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/pdflib/pdf-lib.min.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/tesseract-core-lstm.wasm.js',
  './vendor/tessdata/deu.traineddata.gz',
  './vendor/tessdata/eng.traineddata.gz',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' umgeht den HTTP-Cache – verhindert, dass eine neue
  // SW-Version veraltete Dateien precached (Misch-Versionen!)
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(
      ASSETS.map((url) => fetch(new Request(url, { cache: 'reload' })).then((resp) => {
        if (!resp.ok) throw new Error(`Precache ${url}: HTTP ${resp.status}`);
        return cache.put(url, resp);
      })),
    )).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return resp;
        })
        .catch(() => {
          if (request.mode === 'navigate') return caches.match('./index.html');
          throw new Error('offline und nicht im Cache');
        });
    }),
  );
});
