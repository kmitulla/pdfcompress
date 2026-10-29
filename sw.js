// Service Worker: hält alle Dateien offline bereit.
//
// Die Versionskennung setzt der Server beim Ausliefern ein (bzw. der
// GitHub-Pages-Workflow beim Bauen). Jede neue App-Version bekommt damit
// automatisch einen neuen Cache – kein Handpflegen einer Nummer mehr, und ein
// Update kommt nach dem Deployment ohne Zutun auf jedem Gerät an.
const VERSION = '__APP_VERSION__';
const CACHE = `pdfpresser-${VERSION}`;

const APP = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/compressor.js',
  './js/ccitt-g4.js',
  './js/ocr.js',
  './js/editor.js',
  './js/scanner.js',
  './js/signature.js',
  './js/store.js',
  './js/icons.js',
  './js/prepare.js',
  './js/pdfkit.js',
  './js/calibrate.js',
  './icons/icon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const VENDOR = [
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
  // Version veraltete Dateien einlagert (Misch-Versionen!)
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(
      [...APP, ...VENDOR].map((url) => fetch(new Request(url, { cache: 'reload' })).then((resp) => {
        if (!resp.ok) throw new Error(`Precache ${url}: HTTP ${resp.status}`);
        return cache.put(url, resp);
      })),
    )).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pdfpresser-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});

// App-Code: erst das Netz (mit kurzer Geduld), sonst der Cache – so ist man
// online immer aktuell und offline trotzdem arbeitsfähig.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500)),
    ]);
    if (resp.ok && request.method === 'GET') cache.put(request, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

// Große, unveränderliche Bibliotheken: direkt aus dem Cache.
async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp.ok) {
    const copy = resp.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return resp;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Backend-API nie cachen – Scanner-/Speicher-Status muss immer live sein.
  if (url.pathname.includes('/api/')) return;
  const isVendor = /\/(vendor|icons)\//.test(url.pathname);
  event.respondWith(isVendor ? cacheFirst(request) : networkFirst(request));
});
