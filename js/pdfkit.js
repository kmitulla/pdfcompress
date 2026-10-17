// Gemeinsame PDF-Bausteine (pdf-lib): Bilder auf DIN A4 setzen, PDFs
// zusammenführen. Vorher stand derselbe Code an drei Stellen leicht anders.

export const A4_PT = [595.28, 841.89];

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
