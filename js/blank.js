// Leere Seiten erkennen (Rückseiten, Trennblätter, versehentliche Leerscans).
//
// Gemessen wird auf einer kleinen Miniatur: Anteil deutlich dunklerer Pixel
// als der Papierton, ohne einen Randstreifen (Schatten der Glasfläche,
// Lochungen am Rand). Unter etwa 0,1 % „Tinte“ gilt die Seite als leer.

const BORDER = 0.06;      // Rand, der nicht zählt (je Seite)
const LIMIT = 0.001;      // Tintenanteil, ab dem eine Seite nicht mehr leer ist

/** Tintenanteil 0..1 einer Zeichenfläche (Canvas oder Bild). */
export function inkFraction(source) {
  const w = Math.max(1, Math.min(240, source.width || source.naturalWidth || 1));
  const h = Math.max(1, Math.round(w * ((source.height || source.naturalHeight || 1) / (source.width || source.naturalWidth || 1))));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const x0 = Math.floor(w * BORDER);
  const y0 = Math.floor(h * BORDER);
  const d = ctx.getImageData(x0, y0, Math.max(1, w - 2 * x0), Math.max(1, h - 2 * y0)).data;
  // Papierton: helles Perzentil (robust gegen graues Recyclingpapier)
  const hist = new Uint32Array(256);
  const lum = new Uint8Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    lum[j] = y;
    hist[y]++;
  }
  let acc = 0;
  let paper = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= lum.length * 0.5) { paper = v; break; }
  }
  const thr = paper - Math.max(45, paper * 0.25);
  let ink = 0;
  for (let j = 0; j < lum.length; j++) if (lum[j] < thr) ink++;
  return ink / Math.max(1, lum.length);
}

export const isBlank = (source) => inkFraction(source) < LIMIT;

/** Bild-URL laden und prüfen. */
export async function isBlankUrl(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return isBlank(img);
}
