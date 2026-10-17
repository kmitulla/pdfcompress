// Rechenkern: Kompressionsstufen, G4-Encoder, Farbpalette, S/W-Feinsteuerung,
// DIN-A4-Normierung, Simulation und Texterkennung – mit unabhängiger
// Gegenprobe (pdf.js-Rendering und PDFium).
import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { ready, MAKE_TEST_PDF, RENDER_HELPER, pdfiumStats } from './helpers.js';

test.describe.configure({ mode: 'serial' });

// Binäres Raster einer Seite (für den pixelgenauen G4-Vergleich)
const BIN_HELPER = `
async function binPage(bytes, scale) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const bin = new Uint8Array(c.width * c.height);
  let black = 0;
  for (let i = 0, p = 0; p < d.length; i++, p += 4) {
    bin[i] = ((d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8) < 128 ? 1 : 0;
    black += bin[i];
  }
  await doc.destroy();
  return { bin, w: c.width, h: c.height, blackFrac: black / bin.length };
}
`;

// Als Funktionsdeklaration, damit sie aus eval() heraus sichtbar bleibt
const b64 = `function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768)); return btoa(s); }`;

test('Kompressionsstufen erzeugen kleinere, gültige PDFs', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ makeSrc, renderSrc }) => {
    eval(makeSrc); eval(renderSrc);
    const src = await makeTestPdf(3, 2000, 2829, 0.95);
    const { compressPdf, PRESETS } = window.__pdfpresser;
    const out = {};
    for (const k of ['mittel', 'extrem-grau', 'extrem-sw', 'verlustfrei']) out[k] = await compressPdf(src.slice(), PRESETS[k]);
    const info = {};
    for (const [k, v] of Object.entries(out)) info[k] = await inspectPdf(v, 0.5);
    return { srcSize: src.length, sizes: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])), info };
  }, { makeSrc: MAKE_TEST_PDF, renderSrc: RENDER_HELPER });

  console.log('Quelle:', res.srcSize, 'Ergebnisse:', res.sizes);
  expect(res.sizes.mittel).toBeLessThan(res.srcSize);
  expect(res.sizes['extrem-grau']).toBeLessThan(res.sizes.mittel);
  expect(res.sizes['extrem-sw']).toBeLessThan(res.srcSize * 0.5);
  expect(res.sizes.verlustfrei).toBeLessThan(res.srcSize * 1.2);
  for (const i of Object.values(res.info)) {
    expect(i.numPages).toBe(3);
    expect(Math.abs(i.width - 595.28)).toBeLessThan(1);
    expect(Math.abs(i.height - 841.89)).toBeLessThan(1);
    expect(i.nonWhiteFrac).toBeGreaterThan(0.02);
  }
  expect(res.info.verlustfrei.text).toContain('Testdokument Seite 1');
});

test('G4-Encoder: Pixel identisch zum Flate-Referenzpfad, Datei kleiner', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ binSrc }) => {
    eval(binSrc);
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const p = doc.addPage([595.28, 841.89]);
    for (let i = 0; i < 40; i++) {
      p.drawText('Zeile ' + i + ' — Ätzöl über müßige Brücken; Fax G4 Test 0123456789', { x: 30, y: 800 - i * 19, size: 11, font, color: rgb(0, 0, 0) });
    }
    for (let i = 0; i < 60; i++) {
      p.drawRectangle({ x: (i * 37) % 540 + 20, y: (i * 53) % 700 + 40, width: 2 + (i % 5), height: 2 + ((i * 3) % 7), color: rgb(0, 0, 0) });
    }
    p.drawLine({ start: { x: 20, y: 20 }, end: { x: 570, y: 120 }, thickness: 1.2, color: rgb(0, 0, 0) });
    const src = await doc.save();
    const { compressPdf } = window.__pdfpresser;
    const g4 = await compressPdf(src.slice(), { mode: 'raster', colorMode: 'bw', dpi: 200, bwFilter: 'g4' });
    const fl = await compressPdf(src.slice(), { mode: 'raster', colorMode: 'bw', dpi: 200, bwFilter: 'flate' });
    const auto = await compressPdf(src.slice(), { mode: 'raster', colorMode: 'bw', dpi: 200 });
    const a = await binPage(g4, 200 / 72);
    const b = await binPage(fl, 200 / 72);
    let mismatches = a.w === b.w && a.h === b.h ? 0 : -1;
    if (mismatches === 0) for (let i = 0; i < a.bin.length; i++) if (a.bin[i] !== b.bin[i]) mismatches++;
    return { g4: g4.length, fl: fl.length, auto: auto.length, mismatches, black: a.blackFrac };
  }, { binSrc: BIN_HELPER });
  console.log('G4/Flate/Auto:', res.g4, res.fl, res.auto, 'Abweichungen:', res.mismatches);
  expect(res.mismatches).toBe(0);
  expect(res.black).toBeGreaterThan(0.005);
  expect(res.auto).toBeLessThanOrEqual(Math.min(res.g4, res.fl) + 500);
});

test('Farbreduzierter Scanner-Modus: gültig, klein, wenige Farben', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ makeSrc, b64src }) => {
    eval(makeSrc); eval(b64src);
    const src = await makeTestPdf(2, 1600, 2263, 0.92);
    const { compressPdf } = window.__pdfpresser;
    const out = await compressPdf(src.slice(), { mode: 'raster', colorMode: 'indexed', dpi: 150, colors: 16 });
    const countColors = async (bytes) => {
      const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
      const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      const p = await doc.getPage(1);
      const vp = p.getViewport({ scale: 150 / 72 });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      const n = doc.numPages;
      await doc.destroy();
      return { colors: set.size, n };
    };
    return { srcSize: src.length, outSize: out.length, before: await countColors(src), after: await countColors(out), outB64: b64(out) };
  }, { makeSrc: MAKE_TEST_PDF, b64src: b64 });
  console.log('Indexed:', res.srcSize, '→', res.outSize, '; Farben', res.before.colors, '→', res.after.colors);
  expect(res.after.n).toBe(2);
  expect(res.outSize).toBeLessThan(res.srcSize);
  expect(res.after.colors).toBeLessThan(res.before.colors / 10);
  const st = await pdfiumStats(Buffer.from(res.outB64, 'base64'));
  expect(st.blackFrac).toBeLessThan(0.9);
});

test('Helligkeit & Kontrast verschieben die S/W-Binarisierung, dunkle Ränder laufen nicht zu', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ binSrc }) => {
    eval(binSrc);
    // Dunkle, verrauschte Aufnahme mit hellem Textbereich in der Mitte
    const W = 900, H = 1200;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.62);
    g.addColorStop(0, '#96969a'); g.addColorStop(0.6, '#8a8a8e'); g.addColorStop(1, '#4e4e52');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const img = x.getImageData(0, 0, W, H);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 46; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    x.putImageData(img, 0, 0);
    x.fillStyle = '#141414';
    for (let i = 0; i < 14; i++) x.fillRect(220, 260 + i * 48, 460, 13);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    const jpg = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    doc.addPage([595.28, 841.89]).drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
    const pdf = await doc.save();
    const { compressPdf } = window.__pdfpresser;
    const frac = async (o) => {
      const out = await compressPdf(pdf.slice(), { mode: 'raster', colorMode: 'bw', dpi: 150, ...o });
      const b = await binPage(out, 1);
      const reg = (x0, y0, x1, y1) => {
        let n = 0, t = 0;
        for (let yy = Math.round(y0 * b.h); yy < Math.round(y1 * b.h); yy++) for (let xx = Math.round(x0 * b.w); xx < Math.round(x1 * b.w); xx++) { t++; n += b.bin[yy * b.w + xx]; }
        return n / t;
      };
      return { rand: reg(0, 0, 0.06, 1), text: reg(0.2, 0.18, 0.82, 0.86) };
    };
    return {
      auto: await frac({}), invert: await frac({ darkAreas: 'invert' }),
      cMinus: await frac({ contrast: -40 }), cPlus: await frac({ contrast: 40 }),
      bDark: await frac({ bias: -35 }), bLight: await frac({ bias: 35 }),
    };
  }, { binSrc: BIN_HELPER });
  expect(res.auto.rand, 'Rand läuft nicht zu').toBeLessThan(0.3);
  expect(res.auto.text, 'Text bleibt').toBeGreaterThan(0.01);
  expect(res.invert.rand).toBeGreaterThan(res.auto.rand + 0.2);
  expect(res.cPlus.text).toBeGreaterThan(res.cMinus.text);
  expect(res.bLight.text).toBeLessThan(res.bDark.text);
});

test('DIN A4: abweichende Formate landen unverzerrt auf A4 (Raster & verlustfrei)', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ renderSrc }) => {
    eval(renderSrc);
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Letter hoch, ein schmaler Kassenbon und eine Querseite
    const letter = doc.addPage([612, 792]);
    letter.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.2, 0.4, 0.9) });
    const bon = doc.addPage([226, 600]);
    bon.drawRectangle({ x: 0, y: 0, width: 226, height: 600, color: rgb(0.2, 0.4, 0.9) });
    bon.drawText('Bon', { x: 20, y: 560, size: 20, font });
    const quer = doc.addPage([900, 500]);
    quer.drawRectangle({ x: 0, y: 0, width: 900, height: 500, color: rgb(0.2, 0.4, 0.9) });
    const src = await doc.save();
    const { compressPdf, PRESETS } = window.__pdfpresser;
    const raster = await compressPdf(src.slice(), { ...PRESETS.mittel, a4: true });
    const vector = await compressPdf(src.slice(), { ...PRESETS.verlustfrei, a4: true });
    const original = await compressPdf(src.slice(), { ...PRESETS.mittel, a4: false });
    const out = {};
    for (const [k, b] of Object.entries({ raster, vector, original })) {
      out[k] = { sizes: (await inspectPdf(b, 0.3)).sizes };
      // Bon-Seite: Ränder links/rechts müssen weiß sein (eingepasst, nicht gestreckt)
      const i2 = await inspectPdf(b, 0.4, 2);
      out[k].bonEdges = [i2.leftLum, i2.rightLum];
      const i1 = await inspectPdf(b, 0.4, 1);
      out[k].letterEdges = [i1.leftLum, i1.rightLum];
    }
    return out;
  }, { renderSrc: RENDER_HELPER });
  for (const k of ['raster', 'vector']) {
    expect(res[k].sizes, `${k}: alle Seiten A4`).toEqual([[595, 842], [595, 842], [842, 595]]);
    // Bon (schmal) wird mittig eingepasst -> links/rechts weiß
    expect(res[k].bonEdges[0]).toBeGreaterThan(240);
    expect(res[k].bonEdges[1]).toBeGreaterThan(240);
  }
  // Letter ist „fast A4“ -> wird exakt aufgezogen, kein weißer Rand
  expect(res.raster.letterEdges[0]).toBeLessThan(200);
  // Ohne A4-Option bleiben die Originalmaße
  expect(res.original.sizes).toEqual([[612, 792], [226, 600], [900, 500]]);
});

test('Pixelmaß-Scans (iPhone) bleiben unter dem iOS-Canvas-Limit und werden A4', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ b64src }) => {
    eval(b64src);
    const { PDFDocument } = window.PDFLib;
    const W = 2480, H = 3507;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#f3f0e9'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#111'; x.font = '54px Arial';
    for (let i = 1; i < 40; i++) x.fillText('Zeile ' + i + ': Scanner-Testtext Lorem ipsum 0123456789', 140, 200 + i * 80);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    const doc = await PDFDocument.create();
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    doc.addPage([W, H]).drawImage(img, { x: 0, y: 0, width: W, height: H });
    const src = await doc.save();
    const { compressPdf, previewPage } = window.__pdfpresser;
    const pvSw = await previewPage(src, { mode: 'raster', colorMode: 'bw', dpi: 300 }, 1);
    const sw = await compressPdf(src.slice(), { mode: 'raster', colorMode: 'bw', dpi: 300 });
    return { srcSize: src.length, swPx: pvSw.wPx * pvSw.hPx, swDims: `${pvSw.wPx}x${pvSw.hPx}`, swSize: sw.length, swB64: b64(sw) };
  }, { b64src: b64 });
  expect(res.swPx).toBeLessThanOrEqual(16777216);
  expect(res.swDims).toBe('2480x3507');
  expect(res.swSize).toBeLessThan(res.srcSize * 0.5);
  const stats = await pdfiumStats(Buffer.from(res.swB64, 'base64'));
  expect(stats.whiteFrac).toBeGreaterThan(0.5);
  const outDoc = await PDFDocument.load(Buffer.from(res.swB64, 'base64'));
  const { width, height } = outDoc.getPage(0).getSize();
  expect(Math.abs(width - 595.28)).toBeLessThan(2);
  expect(Math.abs(height - 841.89)).toBeLessThan(2);
});

test('Simulation: schätzt alle Profile und trifft die echte Größe', async ({ page }) => {
  await ready(page);
  const res = await page.evaluate(async ({ makeSrc }) => {
    eval(makeSrc);
    const src = await makeTestPdf(5, 1400, 1980, 0.92);
    const { simulateVariants, compressPdf, PRESETS, PRESET_INFO } = window.__pdfpresser;
    const variants = PRESET_INFO.map(({ key }) => ({ key, opts: { ...PRESETS[key], a4: true } }));
    const t0 = performance.now();
    const sim = await simulateVariants(src, variants);
    const simMs = performance.now() - t0;
    const real = {};
    for (const k of ['mittel', 'extrem-sw', 'extrem-farbe']) real[k] = (await compressPdf(src.slice(), { ...PRESETS[k], a4: true })).length;
    // Abbruch funktioniert
    const sig = { aborted: false };
    const p = simulateVariants(src, variants, () => { sig.aborted = true; }, sig).then(() => 'fertig', (e) => e.name);
    return { srcSize: src.length, sim, simMs, real, aborted: await p };
  }, { makeSrc: MAKE_TEST_PDF });
  console.log('Simulation', Math.round(res.simMs), 'ms:', res.sim.sizes, 'echt:', res.real);
  expect(res.sim.totalPages).toBe(5);
  expect(res.sim.estimated).toBe(true);
  expect(Object.keys(res.sim.sizes).length).toBe(7);
  for (const [k, real] of Object.entries(res.real)) {
    const est = res.sim.sizes[k];
    expect(Math.abs(est - real) / real, `Schätzung ${k}: ${est} vs. ${real}`).toBeLessThan(0.25);
  }
  expect(res.sim.sizes['extrem-sw']).toBeLessThan(res.srcSize * 0.5);
  expect(res.aborted).toBe('AbortError');
});

test('OCR: durchsuchbarer Textlayer auf jeder Seite, parallel zur Seitenverarbeitung', async ({ page }) => {
  test.setTimeout(360000);
  await ready(page);
  const res = await page.evaluate(async ({ renderSrc }) => {
    eval(renderSrc);
    const { PDFDocument } = window.PDFLib;
    const W = 1654, H = 2339; // A4 bei 200 dpi
    const doc = await PDFDocument.create();
    for (let n = 0; n < 3; n++) {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#000';
      ctx.font = '700 90px Arial';
      ctx.fillText(`RECHNUNG ${4711 + n}`, 150, 300);
      ctx.font = '400 64px Arial';
      ctx.fillText('Musterfirma GmbH', 150, 450);
      ctx.fillText(`Betrag: ${199 + n} Euro`, 150, 580);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      doc.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    }
    const src = await doc.save();
    const before = await inspectPdf(src, 0.3);
    const { compressPdf } = window.__pdfpresser;
    const phases = [];
    const out = await compressPdf(src.slice(), { mode: 'raster', colorMode: 'bw', dpi: 300, ocr: true, ocrLang: 'deu' }, (p) => phases.push(`${p.phase}:${p.rendered ?? ''}:${p.recognized ?? ''}`));
    const after = await inspectPdf(out, 0.3);
    // Mitschnitt: Wurde schon gerendert, während die Texterkennung noch lief?
    const overlap = phases.some((s) => { const [ph, r, o] = s.split(':'); return ph === 'render' && +r >= 2 && +o < +r; });
    return { srcSize: src.length, outSize: out.length, textBefore: before.text.trim(), textAfter: after.text.replace(/\s+/g, ' '), overlap };
  }, { renderSrc: RENDER_HELPER });
  console.log('OCR:', res.srcSize, '→', res.outSize, JSON.stringify(res.textAfter.slice(0, 160)));
  expect(res.textBefore).toBe('');
  for (const n of [4711, 4712, 4713]) expect(res.textAfter).toContain(`RECHNUNG ${n}`);
  expect(res.textAfter).toContain('Musterfirma');
  expect(res.outSize).toBeLessThan(res.srcSize);
  expect(res.overlap, 'Rendern läuft weiter, während OCR arbeitet').toBe(true);
});
