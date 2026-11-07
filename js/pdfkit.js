// Gemeinsame PDF-Bausteine (pdf-lib): Bilder auf DIN A4 setzen, PDFs
// zusammenführen. Vorher stand derselbe Code an drei Stellen leicht anders.

export const A4_PT = [595.28, 841.89];

/**
 * Lage einer Seite auf DIN A4 (hoch oder quer wie die Vorlage, in Punkt).
 * Fast-A4 (< 2,5 % Abweichung, z. B. Letter oder Glasfläche) wird exakt
 * aufgezogen, alles andere unverzerrt eingepasst und mittig gesetzt.
 */
export function a4Layout(srcW, srcH) {
  const landscape = srcW > srcH;
  const [tw, th] = landscape ? [A4_PT[1], A4_PT[0]] : A4_PT;
  const sx = tw / srcW;
  const sy = th / srcH;
  if (Math.abs(sx / sy - 1) < 0.025) return { wPt: tw, hPt: th, sx, sy, ox: 0, oy: 0 };
  const s = Math.min(sx, sy);
  return { wPt: tw, hPt: th, sx: s, sy: s, ox: (tw - srcW * s) / 2, oy: (th - srcH * s) / 2 };
}

/**
 * Inhalt einer Seite auf ein Rechteck begrenzen. Nach dem Einpassen liegt um
 * den früheren Zuschnitt weißer Rand – ohne Begrenzung tauchte dort wieder auf,
 * was weggeschnitten war.
 */
function clipContent(page, x, y, w, h) {
  const L = window.PDFLib;
  if (typeof page.createContentStream !== 'function' || typeof page.node?.wrapContentStreams !== 'function') return;
  const start = page.createContentStream(L.pushGraphicsState(), L.rectangle(x, y, w, h), L.clip(), L.endPath());
  const end = page.createContentStream(L.popGraphicsState());
  page.node.wrapContentStreams(page.doc.context.register(start), page.doc.context.register(end));
}

/**
 * Eine pdf-lib-Seite ohne Rastern auf A4 bringen. Maßgeblich ist, was man
 * sieht: der Zuschnitt (CropBox) und die Drehung (/Rotate) – sonst bliebe eine
 * zugeschnittene Seite unverändert oder eine gedrehte bekäme die falsche Lage.
 * @returns true, wenn die Seite geändert wurde
 */
export function normalizePageA4(page) {
  const box = page.getCropBox();
  const media = page.getMediaBox();
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const turned = rot === 90 || rot === 270;
  const viewW = turned ? box.height : box.width;
  const viewH = turned ? box.width : box.height;
  if (!(viewW > 0 && viewH > 0)) return false;
  const L = a4Layout(viewW, viewH);
  // Zielmaße und Faktoren in ungedrehten Seitenkoordinaten
  const TW = turned ? L.hPt : L.wPt;
  const TH = turned ? L.wPt : L.hPt;
  const sx = turned ? L.sy : L.sx;
  const sy = turned ? L.sx : L.sy;
  const same = (a, b) => Math.abs(a - b) < 0.75;
  if (same(box.width, TW) && same(box.height, TH) && same(box.x, 0) && same(box.y, 0)
    && same(media.width, TW) && same(media.height, TH) && same(media.x, 0) && same(media.y, 0)) return false;
  const ox = (TW - box.width * sx) / 2;
  const oy = (TH - box.height * sy) / 2;
  page.scaleContent(sx, sy);
  page.scaleAnnotations?.(sx, sy);
  page.translateContent(ox - box.x * sx, oy - box.y * sy);
  clipContent(page, ox, oy, box.width * sx, box.height * sy);
  page.setMediaBox(0, 0, TW, TH);
  page.setCropBox(0, 0, TW, TH);
  page.setTrimBox?.(0, 0, TW, TH);
  page.setBleedBox?.(0, 0, TW, TH);
  page.setArtBox?.(0, 0, TW, TH);
  return true;
}

const PDFLib = () => window.PDFLib;

/**
 * Bild als neue A4-Seite anfügen (hoch oder quer nach Seitenverhältnis).
 * stretch = true füllt das Blatt exakt (für bereits auf A4 zugeschnittene
 * Scans), sonst wird unverzerrt eingepasst und mittig gesetzt.
 */
export async function addImagePageA4(doc, bytes, kind, { stretch = false, orientation = null } = {}) {
  const img = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const landscape = orientation ? orientation === 'landscape' : img.width > img.height;
  const [pw, ph] = landscape ? [A4_PT[1], A4_PT[0]] : A4_PT;
  const page = doc.addPage([pw, ph]);
  // Weißer Seitenhintergrund, damit Ränder auch nach der Kompression weiß bleiben
  page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: PDFLib().rgb(1, 1, 1) });
  if (stretch) {
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  } else {
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s;
    const h = img.height * s;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return page;
}

/** Bilddatei (Blob/File) in JPEG- bzw. PNG-Bytes für pdf-lib wandeln. */
export async function imageBytesFor(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type === 'image/jpeg' || /\.jpe?g$/.test(name)) return { bytes: new Uint8Array(await file.arrayBuffer()), kind: 'jpg' };
  if (type === 'image/png' || /\.png$/.test(name)) return { bytes: new Uint8Array(await file.arrayBuffer()), kind: 'png' };
  // HEIC/WebP/… über den Browser nach JPEG umkodieren
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error(`Bild „${file.name}“ konnte nicht gelesen werden`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: 'jpg' };
}

/** Mehrere PDFs (Uint8Array) zu einem zusammenführen. */
export async function mergePdfs(list, producer = 'PDF Presser (lokal im Browser)') {
  const { PDFDocument } = PDFLib();
  const merged = await PDFDocument.create();
  merged.setProducer(producer);
  for (const bytes of list) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  return merged.save({ useObjectStreams: true });
}

/** Neues, leeres pdf-lib-Dokument mit unserem Producer. */
export async function newPdf(producer = 'PDF Presser (lokal im Browser)') {
  const doc = await PDFLib().PDFDocument.create();
  doc.setProducer(producer);
  return doc;
}

/**
 * Auflösung aus dem JPEG-Kopf lesen (JFIF-Dichte oder EXIF X-Resolution).
 * Flachbettscanner schreiben dort ihre echte Auflösung hinein – damit lässt
 * sich auch bei Dateien aus dem Sammelordner die reale Größe in mm bestimmen.
 * Liefert null, wenn nichts Brauchbares drinsteht.
 */
export function readJpegDpi(bytes) {
  const b = bytes;
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe0 && b[i + 4] === 0x4a && b[i + 5] === 0x46 && b[i + 6] === 0x49 && b[i + 7] === 0x46) {
      // JFIF: units (0 = Verhältnis, 1 = dpi, 2 = dpcm), Xdensity
      const units = b[i + 11];
      const x = (b[i + 12] << 8) | b[i + 13];
      if (units === 1 && x > 1) return x;
      if (units === 2 && x > 1) return Math.round(x * 2.54);
    }
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const dpi = exifDpi(b, i + 10, len - 8);
      if (dpi) return dpi;
    }
    if (marker === 0xda) return null;   // Bilddaten beginnen – kein Kopf mehr
    i += 2 + len;
  }
  return null;
}

function exifDpi(b, start, len) {
  try {
    const le = b[start] === 0x49;
    const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
    const u32 = (o) => (le
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
    const ifd = start + u32(start + 4);
    const n = u16(ifd);
    let xres = null;
    let unit = 2;
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > start + len) break;
      const tag = u16(e);
      if (tag === 0x011a) {
        const off = start + u32(e + 8);
        const num = u32(off);
        const den = u32(off + 4) || 1;
        xres = num / den;
      } else if (tag === 0x0128) {
        unit = u16(e + 8);
      }
    }
    if (!xres || xres <= 1) return null;
    return Math.round(unit === 3 ? xres * 2.54 : xres);
  } catch {
    return null;
  }
}
