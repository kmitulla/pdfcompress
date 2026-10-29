// PDF-Editor: Unterschrift, Text, Zeichnen/Radieren, Bilder, Seiten,
// Zuschneiden, Formulare. Alle Änderungen werden beim Übernehmen fest ins
// PDF eingebrannt (pdf-lib) – die anschließende Kompression erfasst sie
// dadurch immer mit.

import { processSignatureImage, hasTransparency, strokeToSvgPath, normalizeStrokes } from './signature.js';
import { listSignatures, saveSignature, deleteSignature, listStamps, saveStamp, deleteStamp } from './store.js';
import { hydrateIcons, icon } from './icons.js';
import { toast, alertDialog, confirmDialog } from './ui.js';

const pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
}

const A4 = [595.28, 841.89];
const $ = (sel, root = document) => root.querySelector(sel);

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

// ---------------------------------------------------------------- Einbrennen

// Sichtkoordinaten (y nach unten, gedrehte Ansicht) -> Media-Koordinaten:
// pro Seitenrotation eine Transformationsmatrix, innerhalb derer alle
// pdf-lib-Zeichnungen wie auf einer ungedrehten Seite arbeiten.
function rotationMatrix(rotation, mediaW, mediaH) {
  switch (((rotation % 360) + 360) % 360) {
    case 90: return [0, 1, -1, 0, mediaW, 0];
    case 180: return [-1, 0, 0, -1, mediaW, mediaH];
    case 270: return [0, -1, 1, 0, 0, mediaH];
    default: return null;
  }
}

async function drawObjectsOnPage(newDoc, page, objects, viewW, viewH, fonts, assets) {
  const PDFLib = window.PDFLib;
  const rot = page.getRotation().angle || 0;
  const { width: mw, height: mh } = page.getSize();
  const m = rotationMatrix(rot, mw, mh);
  if (m) {
    page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...m));
  }
  for (const o of objects) {
    const col = hexToRgb(o.color || '#000000');
    const color = PDFLib.rgb(col.r, col.g, col.b);
    if (o.type === 'text') {
      const font = fonts[o.font || 'helv'];
      try {
        page.drawText(o.text, {
          x: o.x,
          y: viewH - o.y - o.size * 0.78,
          size: o.size,
          font,
          color,
          lineHeight: o.size * 1.25,
        });
      } catch {
        const clean = o.text.replace(/[^\x20-ÿ€„“”‚‘’–—]/g, '?');
        page.drawText(clean, { x: o.x, y: viewH - o.y - o.size * 0.78, size: o.size, font, color, lineHeight: o.size * 1.25 });
      }
    } else if (o.type === 'image' || o.type === 'sig-image') {
      const bytes = assets.bytes[o.assetId];
      const img = assets.kind[o.assetId] === 'jpeg' ? await newDoc.embedJpg(bytes) : await newDoc.embedPng(bytes);
      page.drawImage(img, { x: o.x, y: viewH - o.y - o.h, width: o.w, height: o.h });
    } else if (o.type === 'ink') {
      for (const stroke of o.paths) {
        page.drawSvgPath(strokeToSvgPath(stroke), {
          x: 0,
          y: viewH,
          borderColor: color,
          borderWidth: o.width,
          borderOpacity: o.opacity ?? 1,
          borderLineCap: PDFLib.LineCapStyle.Round,
        });
      }
    } else if (o.type === 'rect') {
      page.drawRectangle({ x: o.x, y: viewH - o.y - o.h, width: o.w, height: o.h, color });
    } else if (o.type === 'stamp' && o.style && o.style !== 'frame') {
      const canvas = renderStampCanvas(o);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const png = new Uint8Array(await blob.arrayBuffer());
      const img = await newDoc.embedPng(png);
      page.drawImage(img, { x: o.x, y: viewH - o.y - o.h, width: o.w, height: o.h });
    } else if (o.type === 'stamp') {
      // Einfacher Rahmen-Stempel: echter Text – bleibt in Paperless durchsuchbar
      const yTop = viewH - o.y;
      const L = frameStampLayout(o);
      page.drawRectangle({ x: o.x, y: yTop - o.h, width: o.w, height: o.h, borderColor: color, borderWidth: 2.2, opacity: 0 });
      for (const ln of L.lines) {
        try {
          page.drawText(ln.text, { x: o.x + L.pad, y: yTop - ln.base, size: ln.size, font: ln.bold ? fonts.helvB : fonts.helv, color });
        } catch {
          page.drawText(ln.text.replace(/[^\x20-ÿ€„“”‚‘’–—]/g, '?'), { x: o.x + L.pad, y: yTop - ln.base, size: ln.size, font: ln.bold ? fonts.helvB : fonts.helv, color });
        }
      }
    } else if (o.type === 'sig-vector') {
      for (const stroke of o.strokes) {
        const scaled = stroke.map((p) => ({ x: o.x + p.x * o.w, y: o.y + p.y * o.h }));
        page.drawSvgPath(strokeToSvgPath(scaled), {
          x: 0,
          y: viewH,
          borderColor: color,
          borderWidth: Math.max(0.4, o.widthN * o.h),
          borderLineCap: PDFLib.LineCapStyle.Round,
        });
      }
    }
  }
  if (m) page.pushOperators(PDFLib.popGraphicsState());
}


/**
 * Zeilen eines Rahmen-Stempels: Name/Firma (klein, fett), Titel (groß),
 * Datum + Notiz (klein). `base` = Abstand der Grundlinie von der Oberkante.
 */
export function frameStampLayout(o) {
  const pad = 8;
  const inner = o.w - pad * 2;
  let line2 = o.date || '';
  if (o.note) line2 += (line2 ? ' – ' : '') + o.note;
  const brand = (o.brand || '').trim();
  const title = o.title || 'STEMPEL';
  const small = Math.max(4, Math.min(9.5, o.h * (brand && line2 ? 0.15 : 0.18)));
  let titleSize = Math.min(o.h * (brand || line2 ? (brand && line2 ? 0.34 : 0.42) : 0.6), inner / Math.max(3, title.length) / 0.6);
  titleSize = Math.max(5, titleSize);
  const lines = [];
  let y = pad - 2;
  if (brand) {
    y += small;
    lines.push({ text: brand, size: Math.min(small, inner / Math.max(4, brand.length) / 0.56), bold: true, base: y });
    y += small * 0.35;
  }
  // Titel mittig im verbleibenden Raum
  const bottomReserve = line2 ? small + pad : pad;
  const free = o.h - y - bottomReserve;
  const tBase = y + Math.max(titleSize * 0.8, (free + titleSize * 0.72) / 2);
  lines.push({ text: title, size: titleSize, bold: true, base: tBase });
  if (line2) lines.push({ text: line2, size: Math.min(small, inner / Math.max(6, line2.length) / 0.5), bold: false, base: o.h - pad + 2 });
  return { pad, lines };
}

// Stempel im echten Stempel-Look als transparentes PNG rendern
function renderStampCanvas(o, scale = 4) {
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(o.w * scale));
  c.height = Math.max(8, Math.round(o.h * scale));
  const x = c.getContext('2d');
  x.scale(scale, scale);
  x.translate(o.w / 2, o.h / 2);
  if (o.style === 'stamp' || o.style === 'round') x.rotate(-6 * Math.PI / 180);
  x.strokeStyle = o.color;
  x.fillStyle = o.color;
  const w = o.w * 0.94;
  const h = o.h * 0.9;
  if (o.style === 'round') {
    x.lineWidth = 2.6;
    x.beginPath(); x.ellipse(0, 0, w / 2, h / 2, 0, 0, 7); x.stroke();
    x.lineWidth = 1.2;
    x.beginPath(); x.ellipse(0, 0, w / 2 - 4, h / 2 - 4, 0, 0, 7); x.stroke();
  } else {
    x.lineWidth = 2.6;
    x.strokeRect(-w / 2, -h / 2, w, h);
    x.lineWidth = 1.2;
    x.strokeRect(-w / 2 + 3.5, -h / 2 + 3.5, w - 7, h - 7);
  }
  const lines = [];
  if (o.brand) lines.push({ t: o.brand.toUpperCase(), s: Math.min(h * 0.2, w / Math.max(4, o.brand.length) / 0.66), b: true });
  lines.push({ t: o.title.toUpperCase(), s: Math.min(h * 0.34, (w - 16) / Math.max(4, o.title.length) / 0.66), b: true });
  let l2 = o.date || '';
  if (o.note) l2 += (l2 ? ' – ' : '') + o.note;
  if (l2) lines.push({ t: l2, s: Math.min(h * 0.16, (w - 16) / Math.max(6, l2.length) / 0.55), b: false });
  const total = lines.reduce((a, l) => a + l.s * 1.3, 0);
  let y = -total / 2;
  for (const l of lines) {
    y += l.s * 1.3;
    x.font = `${l.b ? '700' : '400'} ${l.s}px Helvetica, Arial, sans-serif`;
    x.textAlign = 'center';
    x.fillText(l.t, 0, y - l.s * 0.18);
  }
  return c;
}

// state: { pages: [{src, blankSize?, crop?, objects: []}], formValues?, flattenForm?, assets }
export async function applyEdits(srcBytes, state) {
  const PDFLib = window.PDFLib;
  const srcDoc = await PDFLib.PDFDocument.load(srcBytes, { updateMetadata: false });

  // Formularfelder zuerst ausfüllen (und standardmäßig fest einbrennen)
  if (state.formValues && Object.keys(state.formValues).length) {
    const form = srcDoc.getForm();
    const helv = await srcDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    for (const [name, value] of Object.entries(state.formValues)) {
      try {
        const field = form.getField(name);
        // Minifizierte Klassennamen -> Feldtyp über vorhandene Methoden erkennen
        if (typeof field.setText === 'function') {
          field.setText(String(value));
        } else if (typeof field.check === 'function') {
          if (value) field.check(); else field.uncheck();
        } else if (typeof field.select === 'function') {
          field.select(String(value));
        }
      } catch (e) {
        console.warn('Formularfeld übersprungen:', name, e);
      }
    }
    form.updateFieldAppearances(helv);
    if (state.flattenForm !== false) form.flatten();
  }

  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.setProducer('PDF Presser (lokal im Browser)');
  const fonts = {
    helv: await newDoc.embedFont(PDFLib.StandardFonts.Helvetica),
    helvB: await newDoc.embedFont(PDFLib.StandardFonts.HelveticaBold),
    times: await newDoc.embedFont(PDFLib.StandardFonts.TimesRoman),
    courier: await newDoc.embedFont(PDFLib.StandardFonts.Courier),
  };
  const assets = state.assets || { bytes: {}, kind: {} };

  for (const entry of state.pages) {
    let page;
    let viewW;
    let viewH;
    if (entry.src == null) {
      const [w, h] = entry.blankSize || A4;
      page = newDoc.addPage([w, h]);
      viewW = w;
      viewH = h;
      if (entry.rotate) {
        // Leere Seite drehen = Maße tauschen
        if (entry.rotate % 180 !== 0) page.setSize(h, w);
        viewW = page.getWidth();
        viewH = page.getHeight();
      }
    } else {
      const [copied] = await newDoc.copyPages(srcDoc, [entry.src]);
      page = newDoc.addPage(copied);
      if (entry.rotate) {
        const base = page.getRotation().angle || 0;
        page.setRotation(PDFLib.degrees((base + entry.rotate) % 360));
      }
      const rot = ((page.getRotation().angle % 360) + 360) % 360;
      const { width, height } = page.getSize();
      viewW = rot === 90 || rot === 270 ? height : width;
      viewH = rot === 90 || rot === 270 ? width : height;
    }
    if (entry.objects?.length) {
      await drawObjectsOnPage(newDoc, page, entry.objects, viewW, viewH, fonts, assets);
    }
    if (state.pageNumbers) {
      const idx = state.pages.indexOf(entry) + 1;
      const label = `${idx} / ${state.pages.length}`;
      const rot0 = entry.src == null ? 0 : ((page.getRotation().angle % 360) + 360) % 360;
      const m0 = rotationMatrix(rot0, page.getWidth(), page.getHeight());
      if (m0) page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...m0));
      page.drawText(label, { x: viewW / 2 - label.length * 2.6, y: 18, size: 10, font: fonts.helv, color: PDFLib.rgb(0.25, 0.25, 0.25) });
      if (m0) page.pushOperators(PDFLib.popGraphicsState());
    }
    if (entry.crop) {
      const c = entry.crop;
      const rot = entry.src == null ? 0 : ((page.getRotation().angle % 360) + 360) % 360;
      const { width: mw, height: mh } = page.getSize();
      // Sicht-Rechteck (y unten) -> Media-Rechteck je nach Rotation
      const x0 = c.x;
      const y0 = viewH - c.y - c.h;
      let box;
      if (rot === 90) box = [mw - (y0 + c.h), x0, c.h, c.w];
      else if (rot === 180) box = [mw - (x0 + c.w), mh - (y0 + c.h), c.w, c.h];
      else if (rot === 270) box = [y0, mh - (x0 + c.w), c.h, c.w];
      else box = [x0, y0, c.w, c.h];
      page.setCropBox(...box);
    }

    // Seite auf ein Zielformat bringen (z. B. A4): Inhalt unverzerrt einpassen
    // und mittig setzen, dann die Seitengröße ändern.
    if (entry.resizeTo) {
      const [tw, th] = entry.resizeTo;
      const { width: cw, height: ch } = page.getSize();
      if (cw > 0 && ch > 0 && (Math.abs(cw - tw) > 0.5 || Math.abs(ch - th) > 0.5)) {
        const s = Math.min(tw / cw, th / ch);
        page.scaleContent(s, s);
        page.scaleAnnotations?.(s, s);
        page.translateContent((tw - cw * s) / 2, (th - ch * s) / 2);
        page.setSize(tw, th);
        page.setCropBox(0, 0, tw, th);
      }
    }
  }
  return newDoc.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- Editor-UI
//
// Aufbau: oben eine schlanke Leiste (Abbrechen · Titel · Rückgängig ·
// Übernehmen), links – am Handy unten – die beschrifteten Werkzeuge, rechts –
// am Handy darüber – die Eigenschaften des gewählten Objekts bzw. Werkzeugs.
// Neue Objekte landen sofort sichtbar in der Mitte des Bildausschnitts und
// sind ausgewählt: verschieben per Ziehen, Größe über die Ecken.

const TOOLS = [
  { id: 'select', icon: 'move', label: 'Auswahl' },
  { id: 'sign', icon: 'signature', label: 'Unterschrift' },
  { id: 'text', icon: 'text', label: 'Text' },
  { id: 'stamp', icon: 'stamp', label: 'Stempel' },
  { id: 'draw', icon: 'pen', label: 'Stift' },
  { id: 'whiteout', icon: 'whiteout', label: 'Abdecken' },
  { id: 'redact', icon: 'marker', label: 'Schwärzen' },
  { id: 'image', icon: 'image', label: 'Bild' },
  { id: 'crop', icon: 'crop', label: 'Zuschnitt' },
];
// Werkzeuge, die nur ein Blatt öffnen und dann zur Auswahl zurückkehren
const SHEET_TOOLS = new Set(['sign', 'stamp', 'image']);

const INK_COLORS = ['#111111', '#1b2a80', '#1d4ed8', '#c00000', '#15803d'];
const STAMP_COLORS = ['#c00000', '#1d4ed8', '#15803d', '#111111'];
const STAMP_PRESETS = ['BEZAHLT', 'ERLEDIGT', 'ERHALTEN', 'EINGEGANGEN', 'GEPRÜFT', 'KOPIE', 'ENTWURF'];
const TYPE_NAME = {
  text: 'Text', image: 'Bild', 'sig-image': 'Unterschrift', 'sig-vector': 'Unterschrift',
  rect: 'Schwärzung', stamp: 'Stempel', ink: 'Zeichnung',
};

let ed = null; // aktiver Editor-Zustand

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('de-DE');

function buildUi() {
  const root = document.createElement('div');
  root.id = 'editorRoot';
  root.innerHTML = `
  <div class="ed-overlay" role="dialog" aria-modal="true" aria-label="PDF bearbeiten">
    <header class="ed-bar">
      <button id="edCancel" class="btn btn-ghost ed-cancel">Abbrechen</button>
      <div class="ed-title"><strong>Bearbeiten</strong><small id="edDocName"></small></div>
      <div class="ed-hist">
        <button id="edUndoBtn" class="ed-iconbtn" title="Rückgängig (Strg+Z)" aria-label="Rückgängig"><i data-icon="undo" data-icon-size="19"></i></button>
        <button id="edRedoBtn" class="ed-iconbtn" title="Wiederholen (Strg+Umschalt+Z)" aria-label="Wiederholen"><i data-icon="redo" data-icon-size="19"></i></button>
      </div>
      <button id="edApply" class="btn btn-primary"><i data-icon="check" data-icon-size="17"></i><span>Übernehmen</span></button>
    </header>
    <div class="ed-main">
      <nav class="ed-dock" role="toolbar" aria-label="Werkzeuge">
        ${TOOLS.map((t) => `<button class="ed-tool" data-tool="${t.id}" title="${t.label}" aria-label="${t.label}"><i data-icon="${t.icon}" data-icon-size="21"></i><span>${t.label}</span></button>`).join('')}
        <span class="ed-dock-sep" aria-hidden="true"></span>
        <button class="ed-tool" id="edPagesBtn" title="Seiten verwalten" aria-label="Seiten verwalten"><i data-icon="docStack" data-icon-size="21"></i><span>Seiten</span></button>
        <button class="ed-tool hidden" id="edFormBtn" title="Formular ausfüllen" aria-label="Formular ausfüllen"><i data-icon="doc" data-icon-size="21"></i><span>Formular</span></button>
      </nav>
      <div class="ed-stage" id="edStage">
        <div class="ed-page" id="edPage">
          <canvas id="edCanvas"></canvas>
          <svg id="edSvg" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
        <div class="ed-float" role="group" aria-label="Seite und Zoom">
          <button id="edPrev" class="ed-iconbtn" aria-label="Vorherige Seite"><i data-icon="chevronLeft" data-icon-size="17"></i></button>
          <span id="edPageInfo">1/1</span>
          <button id="edNext" class="ed-iconbtn" aria-label="Nächste Seite"><i data-icon="chevronRight" data-icon-size="17"></i></button>
          <span class="ed-float-sep"></span>
          <button id="edZoomOut" class="ed-iconbtn" aria-label="Verkleinern"><i data-icon="minus" data-icon-size="17"></i></button>
          <button id="edZoomFit" class="ed-iconbtn ed-fit" aria-label="Einpassen">Fit</button>
          <button id="edZoomIn" class="ed-iconbtn" aria-label="Vergrößern"><i data-icon="plus" data-icon-size="17"></i></button>
        </div>
      </div>
      <aside class="ed-panel" id="edProps" aria-live="polite"></aside>
    </div>
    <div class="ed-modal hidden" id="edModal"><div class="ed-modal-box" id="edModalBox" role="dialog" aria-modal="true"></div></div>
    <input type="file" id="edImageInput" accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif" hidden>
    <input type="file" id="edSigPhotoInput" accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif" hidden>
    <input type="file" id="edStampImageInput" accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif" hidden>
  </div>`;
  hydrateIcons(root);
  // Verborgen einhängen: sichtbar wird der Editor erst, wenn sein Zustand
  // steht (siehe openEditor).
  root.classList.add('hidden');
  document.body.appendChild(root);
  return root;
}

// ---------------------------------------------------------------- Verlauf

function snapshot(label = 'Änderung') {
  ed.undoStack.push({ label, json: JSON.stringify(ed.state.pages) });
  if (ed.undoStack.length > 80) ed.undoStack.shift();
  ed.redoStack = [];
  syncHistoryButtons();
}

function restore(json) {
  ed.state.pages = JSON.parse(json);
  if (ed.pageIdx >= ed.state.pages.length) ed.pageIdx = ed.state.pages.length - 1;
  ed.selected = null;
  renderPageView();
  renderPanel();
}

function undo() {
  const prev = ed.undoStack.pop();
  if (!prev) return;
  ed.redoStack.push({ label: prev.label, json: JSON.stringify(ed.state.pages) });
  restore(prev.json);
  syncHistoryButtons();
}

function redo() {
  const next = ed.redoStack.pop();
  if (!next) return;
  ed.undoStack.push({ label: next.label, json: JSON.stringify(ed.state.pages) });
  restore(next.json);
  syncHistoryButtons();
}

function syncHistoryButtons() {
  const u = $('#edUndoBtn');
  const r = $('#edRedoBtn');
  if (u) { u.disabled = ed.undoStack.length === 0; u.title = ed.undoStack.length ? `Rückgängig: ${ed.undoStack[ed.undoStack.length - 1].label}` : 'Rückgängig'; }
  if (r) r.disabled = ed.redoStack.length === 0;
}

const curPage = () => ed.state.pages[ed.pageIdx];
const selObj = () => (ed.selected != null ? curPage().objects[ed.selected] : null);

// ---------------------------------------------------------------- Seiten-Rendering

async function renderPageView() {
  const entry = curPage();
  const canvas = $('#edCanvas');
  const token = ++ed.renderToken;
  let wPt = A4[0];
  let hPt = A4[1];
  if (entry.src != null) {
    const page = await ed.pdf.getPage(entry.src + 1);
    if (token !== ed.renderToken) return;
    const totalRot = ((page.rotate || 0) + (entry.rotate || 0)) % 360;
    const base = page.getViewport({ scale: 1, rotation: totalRot });
    wPt = base.width;
    hPt = base.height;
    const scale = Math.min(3, 1600 / Math.max(wPt, hPt) * (window.devicePixelRatio || 1));
    const viewport = page.getViewport({ scale, rotation: totalRot });
    const off = document.createElement('canvas');
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    const octx = off.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, off.width, off.height);
    await page.render({ canvasContext: octx, viewport }).promise;
    if (token !== ed.renderToken) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
  } else {
    [wPt, hPt] = entry.blankSize || A4;
    if ((entry.rotate || 0) % 180 !== 0) [wPt, hPt] = [hPt, wPt];
    canvas.width = Math.round(wPt * 2);
    canvas.height = Math.round(hPt * 2);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ed.pagePt = { w: wPt, h: hPt };
  $('#edSvg').setAttribute('viewBox', `0 0 ${wPt} ${hPt}`);
  $('#edPageInfo').textContent = `${ed.pageIdx + 1}/${ed.state.pages.length}`;
  $('#edPrev').disabled = ed.pageIdx === 0;
  $('#edNext').disabled = ed.pageIdx >= ed.state.pages.length - 1;
  layoutPage();
  renderOverlay();
}

/** Seitengröße an die Bühne anpassen (ohne neu zu rendern). */
function layoutPage() {
  if (!ed) return;
  const s = ed.fitScale();
  const pageEl = $('#edPage');
  pageEl.style.width = `${ed.pagePt.w * s}px`;
  pageEl.style.height = `${ed.pagePt.h * s}px`;
  applyZoom();
}

function applyZoom() {
  $('#edPage').style.transform = `translate(${ed.pan.x}px, ${ed.pan.y}px) scale(${ed.zoom})`;
  $('#edZoomFit').textContent = ed.zoom === 1 && !ed.pan.x && !ed.pan.y ? 'Fit' : `${Math.round(ed.zoom * 100)} %`;
}

function zoomTo(z) {
  ed.zoom = Math.min(8, Math.max(0.5, z));
  if (ed.zoom <= 1) ed.pan = { x: 0, y: 0 };
  applyZoom();
  renderOverlay();
}

// ---------------------------------------------------------------- Objekte zeichnen (SVG-Vorschau)

const fontFamily = (f) => (f === 'times' ? 'Times New Roman,Times,serif' : f === 'courier' ? 'Courier New,monospace' : 'Helvetica,Arial,sans-serif');

/** SVG-Markup eines Objekts – auch für Vorschauen im Stempel-Blatt. */
function objectSvg(o, i = -1) {
  const di = i >= 0 ? ` data-i="${i}"` : '';
  if (o.type === 'text') {
    const lines = o.text.split('\n');
    const tspans = lines.map((ln, li) => `<tspan x="${o.x}" dy="${li === 0 ? o.size * 0.95 : o.size * 1.25}">${esc(ln) || ' '}</tspan>`).join('');
    const weight = o.font === 'helvB' ? ' font-weight="bold"' : '';
    return `<text${di} x="${o.x}" y="${o.y}" font-size="${o.size}" fill="${o.color}"${weight} font-family="${fontFamily(o.font)}" style="white-space:pre">${tspans}</text>`;
  }
  if (o.type === 'image' || o.type === 'sig-image') {
    return `<image${di} x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${ed.state.assets.url[o.assetId]}" preserveAspectRatio="none"/>`;
  }
  if (o.type === 'sig-vector') {
    const d = o.strokes.map((st) => strokeToSvgPath(st.map((p) => ({ x: o.x + p.x * o.w, y: o.y + p.y * o.h })))).join(' ');
    return `<path${di} d="${d}" fill="none" stroke="${o.color}" stroke-width="${Math.max(0.4, o.widthN * o.h)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (o.type === 'rect') return `<rect${di} x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.color}"/>`;
  if (o.type === 'stamp' && o.style && o.style !== 'frame') {
    return `<image${di} x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${stampPng(o)}" preserveAspectRatio="none"/>`;
  }
  if (o.type === 'stamp') {
    const L = frameStampLayout(o);
    return `<g${di}><rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="none" stroke="${o.color}" stroke-width="2.2"/>
      ${L.lines.map((ln) => `<text x="${o.x + L.pad}" y="${o.y + ln.base}" font-size="${ln.size}" ${ln.bold ? 'font-weight="bold"' : ''} fill="${o.color}" font-family="Helvetica,Arial,sans-serif">${esc(ln.text)}</text>`).join('')}</g>`;
  }
  if (o.type === 'ink') {
    const d = o.paths.map((st) => strokeToSvgPath(st)).join(' ');
    return `<path${di} d="${d}" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-opacity="${o.opacity ?? 1}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return '';
}

// Stempel-Bilder zwischenspeichern – sonst entsteht bei jeder Mausbewegung ein neues PNG
const stampCache = new Map();
function stampPng(o) {
  const key = JSON.stringify([o.style, o.color, o.title, o.brand, o.date, o.note, Math.round(o.w), Math.round(o.h)]);
  let url = stampCache.get(key);
  if (!url) {
    url = renderStampCanvas(o, 3).toDataURL('image/png');
    if (stampCache.size > 40) stampCache.clear();
    stampCache.set(key, url);
  }
  return url;
}

function boxOf(o) {
  if (o.type === 'text') return { x: o.x - 2, y: o.y - 2, w: textWidth(o) + 6, h: textHeight(o) + 4 };
  if (o.w != null) return { x: o.x, y: o.y, w: o.w, h: o.h };
  return null;
}

function renderOverlay() {
  if (!ed) return;
  const svg = $('#edSvg');
  const entry = curPage();
  const parts = entry.objects.map((o, i) => objectSvg(o, i));
  const o = selObj();
  if (o) {
    const b = boxOf(o);
    if (b) parts.push(selectionSvg(b));
  }
  if (entry.crop) {
    const c = entry.crop;
    const { w, h } = ed.pagePt;
    parts.push(`<path d="M0 0H${w}V${h}H0Z M${c.x} ${c.y}h${c.w}v${c.h}h${-c.w}Z" fill="rgba(15,23,42,0.55)" fill-rule="evenodd" pointer-events="none"/><rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="none" stroke="#4f7bff" stroke-width="1.5" stroke-dasharray="6 4" pointer-events="none"/>`);
  }
  if (ed.tempRect) {
    const r = ed.tempRect;
    const fill = ed.tool === 'redact' ? 'rgba(0,0,0,0.55)' : 'rgba(79,123,255,0.15)';
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${fill}" stroke="#4f7bff" stroke-width="1" pointer-events="none"/>`);
  }
  if (ed.tempStroke) {
    const white = ed.tool === 'whiteout';
    const col = white ? '#ffffff' : ed.penColor;
    const width = white ? ed.whiteWidth : ed.penWidth;
    const op = !white && ed.penMode === 'marker' ? 0.45 : 1;
    parts.push(`<path d="${strokeToSvgPath(ed.tempStroke)}" fill="none" stroke="${col}" stroke-width="${width}" stroke-opacity="${op}" stroke-linecap="round" stroke-linejoin="round" ${white ? 'style="filter:drop-shadow(0 0 1px rgba(0,0,0,.35))"' : ''}/>`);
  }
  svg.innerHTML = parts.join('');
}

/** Auswahlrahmen mit vier Eck-Anfassern und Lösch-Knopf (Bildschirmgröße konstant). */
function selectionSvg(b) {
  const u = 1 / (ed.zoom * ed.fitScale());
  const r = 7 * u;
  const hit = 22 * u;
  const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
  const dx = b.x + b.w + 14 * u;
  const dy = b.y - 14 * u;
  return `<g class="ed-sel">
    <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="rgba(79,123,255,0.06)" stroke="#4f7bff" stroke-width="${1.6 * u}" stroke-dasharray="${5 * u} ${3 * u}" pointer-events="none"/>
    ${corners.map(([x, y], k) => `<circle data-handle="${k}" cx="${x}" cy="${y}" r="${hit}" fill="transparent"/><circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="#4f7bff" stroke-width="${2 * u}" pointer-events="none"/>`).join('')}
    <g data-del="1" class="ed-del"><circle cx="${dx}" cy="${dy}" r="${hit * 0.75}" fill="transparent"/><circle cx="${dx}" cy="${dy}" r="${10 * u}" fill="#e5484d"/>
    <path d="M ${dx - 3.6 * u} ${dy - 3.6 * u} l ${7.2 * u} ${7.2 * u} M ${dx + 3.6 * u} ${dy - 3.6 * u} l ${-7.2 * u} ${7.2 * u}" stroke="#fff" stroke-width="${2 * u}" pointer-events="none"/></g>
  </g>`;
}

function textWidth(o) {
  // grobe Breitenschätzung – genügt für Auswahlrahmen und Treffer
  const k = o.font === 'courier' ? 0.6 : o.font === 'helvB' ? 0.58 : 0.53;
  return Math.max(...o.text.split('\n').map((l) => l.length), 1) * o.size * k;
}
function textHeight(o) {
  return o.text.split('\n').length * o.size * 1.25;
}

// ---------------------------------------------------------------- Koordinaten & Treffer

function toPagePt(ev) {
  const rect = $('#edSvg').getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * ed.pagePt.w,
    y: ((ev.clientY - rect.top) / rect.height) * ed.pagePt.h,
  };
}

/** Mitte des sichtbaren Seitenausschnitts in Seitenkoordinaten. */
function viewCenter() {
  const st = $('#edStage').getBoundingClientRect();
  const pt = toPagePt({ clientX: st.left + st.width / 2, clientY: st.top + st.height / 2 });
  return { x: Math.min(ed.pagePt.w * 0.9, Math.max(ed.pagePt.w * 0.1, pt.x)), y: Math.min(ed.pagePt.h * 0.9, Math.max(ed.pagePt.h * 0.1, pt.y)) };
}

function hitObject(pt, types = null) {
  const objs = curPage().objects;
  const pad = 6 / (ed.zoom * ed.fitScale());
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (types && !types.includes(o.type)) continue;
    const b = boxOf(o);
    if (b && pt.x >= b.x - pad && pt.x <= b.x + b.w + pad && pt.y >= b.y - pad && pt.y <= b.y + b.h + pad) return i;
  }
  return null;
}

// ---------------------------------------------------------------- Werkzeuge

function setTool(tool) {
  if (!ed) return;   // Editor lädt noch – Tippen darf nicht ins Leere laufen
  if (SHEET_TOOLS.has(tool)) {
    if (tool === 'sign') openSignSheet();
    if (tool === 'stamp') openStampSheet();
    if (tool === 'image') $('#edImageInput').click();
    return;
  }
  ed.tool = tool;
  ed.tempRect = null;
  if (tool !== 'select' && tool !== 'text') ed.selected = null;
  syncToolButtons();
  renderPanel();
  renderOverlay();
}

function syncToolButtons() {
  document.querySelectorAll('#editorRoot [data-tool]').forEach((b) => {
    const on = b.dataset.tool === ed.tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#edStage').dataset.tool = ed.tool;
}

function select(i) {
  ed.selected = i;
  if (ed.tool !== 'select' && ed.tool !== 'text' && ed.tool !== 'redact') ed.tool = 'select';
  syncToolButtons();
  renderPanel();
  renderOverlay();
}

/** Neues Objekt in die Mitte des sichtbaren Ausschnitts setzen und auswählen. */
function insertObject(o, label) {
  snapshot(label);
  const c = viewCenter();
  if (o.w != null) {
    o.x = Math.max(0, Math.min(ed.pagePt.w - o.w, c.x - o.w / 2));
    o.y = Math.max(0, Math.min(ed.pagePt.h - o.h, c.y - o.h / 2));
  } else {
    o.x = c.x - textWidth(o) / 2;
    o.y = c.y - textHeight(o) / 2;
  }
  curPage().objects.push(o);
  ed.tool = 'select';
  select(curPage().objects.length - 1);
}

function deleteSelected() {
  if (ed.selected == null) return;
  snapshot(`${TYPE_NAME[selObj()?.type] || 'Objekt'} gelöscht`);
  curPage().objects.splice(ed.selected, 1);
  ed.selected = null;
  renderPanel();
  renderOverlay();
}

function duplicateSelected() {
  const o = selObj();
  if (!o) return;
  snapshot('Dupliziert');
  const copy = JSON.parse(JSON.stringify(o));
  copy.x += 14;
  copy.y += 14;
  curPage().objects.push(copy);
  select(curPage().objects.length - 1);
}

function bringToFront() {
  const objs = curPage().objects;
  if (ed.selected == null || ed.selected === objs.length - 1) return;
  snapshot('Nach vorne');
  const [o] = objs.splice(ed.selected, 1);
  objs.push(o);
  select(objs.length - 1);
}

// ---------------------------------------------------------------- Eigenschaften-Panel

function swatchesHtml(name, value, colors) {
  return `<div class="ed-swatches" data-swatches="${name}">
    ${colors.map((c) => `<button type="button" class="ed-swatch ${c.toLowerCase() === String(value).toLowerCase() ? 'active' : ''}" data-color="${c}" style="--c:${c}" aria-label="Farbe ${c}"></button>`).join('')}
    <label class="ed-swatch ed-swatch-custom" title="Eigene Farbe"><input type="color" id="${name}" value="${value}" aria-label="Eigene Farbe"></label>
  </div>`;
}

function wireSwatches(root, name, onColor) {
  const box = root.querySelector(`[data-swatches="${name}"]`);
  if (!box) return;
  const input = box.querySelector('input[type="color"]');
  const mark = (c) => box.querySelectorAll('.ed-swatch[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color.toLowerCase() === c.toLowerCase()));
  box.querySelectorAll('.ed-swatch[data-color]').forEach((b) => b.addEventListener('click', () => {
    input.value = b.dataset.color;
    mark(b.dataset.color);
    onColor(b.dataset.color);
  }));
  input.addEventListener('input', () => { mark(input.value); onColor(input.value); });
}

function stepperHtml(id, value, { step = 1, min = 1, label }) {
  return `<div class="ed-stepper">
    <button type="button" class="ed-step" id="${id}Down" aria-label="${label} kleiner">${icon('minus', { size: 16 })}</button>
    <input type="number" id="${id}Num" value="${value}" step="${step}" min="${min}" inputmode="decimal" aria-label="${label}">
    <button type="button" class="ed-step" id="${id}Up" aria-label="${label} größer">${icon('plus', { size: 16 })}</button>
  </div>`;
}

/** Zahl mit Stepper + Schieber verbinden (Zahl ohne Obergrenze). */
function wireNumber(id, { get, set, min = 1, rangeMax, stepFor }) {
  const num = $(`#${id}Num`);
  const range = $(`#${id}`);
  const apply = (v, from) => {
    const val = Math.max(min, Number(v) || min);
    set(val);
    if (from !== 'num') num.value = Math.round(val * 100) / 100;
    if (range && from !== 'range') range.value = Math.min(rangeMax, val);
  };
  num.oninput = (e) => apply(e.target.value, 'num');
  if (range) range.oninput = (e) => apply(e.target.value, 'range');
  $(`#${id}Down`).onclick = () => apply(get() - stepFor(get()));
  $(`#${id}Up`).onclick = () => apply(get() + stepFor(get()));
}

function panelSection(title, body, actions = '') {
  return `<div class="ed-panel-head"><strong>${title}</strong>${actions}</div><div class="ed-panel-body">${body}</div>`;
}

function objectActions() {
  return `<span class="ed-panel-actions">
    <button class="ed-iconbtn" id="edObjFront" title="Nach vorne" aria-label="Nach vorne">${icon('layers', { size: 17 })}</button>
    <button class="ed-iconbtn" id="edObjDup" title="Duplizieren" aria-label="Duplizieren">${icon('duplicate', { size: 17 })}</button>
    <button class="ed-iconbtn ed-danger" id="edDeleteBtn" title="Löschen (Entf)" aria-label="Löschen">${icon('trash', { size: 17 })}</button>
  </span>`;
}

function renderPanel() {
  const panel = $('#edProps');
  const o = selObj();
  let html = '';
  let idle = false;
  if (o) {
    html = panelSection(TYPE_NAME[o.type] || 'Objekt', objectPanelBody(o), objectActions());
  } else if (ed.tool === 'draw') {
    html = panelSection('Stift', `
      <div class="ed-field"><span class="ed-label">Art</span>
        <div class="seg ed-seg" id="edPenMode">
          <button data-v="pen" class="${ed.penMode === 'pen' ? 'active' : ''}">Stift</button>
          <button data-v="marker" class="${ed.penMode === 'marker' ? 'active' : ''}">Marker</button>
          <button data-v="erase" class="${ed.penMode === 'erase' ? 'active' : ''}">Radierer</button>
        </div></div>
      ${ed.penMode === 'erase' ? '<p class="ed-hint">Über gezeichnete Striche wischen, um sie zu entfernen. Inhalt der PDF bleibt – dafür „Abdecken“ oder „Schwärzen“.</p>' : `
      <div class="ed-field"><span class="ed-label">Farbe</span>${swatchesHtml('edPenColor', ed.penColor, INK_COLORS.concat(['#f5c400']))}</div>
      <div class="ed-field"><label class="ed-label" for="edPenWidthNum">Strichbreite (pt)</label>
        ${stepperHtml('edPenWidth', ed.penWidth, { step: 0.5, min: 0.1, label: 'Strichbreite' })}
        <input type="range" id="edPenWidth" min="0.5" max="40" step="0.5" value="${Math.min(40, ed.penWidth)}" aria-label="Strichbreite grob"></div>`}`);
  } else if (ed.tool === 'whiteout') {
    html = panelSection('Abdecken (weiß)', `
      <div class="ed-field"><label class="ed-label" for="edWhiteWidthNum">Pinselgröße (pt)</label>
        <div class="ed-inline">${stepperHtml('edWhiteWidth', ed.whiteWidth, { step: 1, min: 1, label: 'Pinselgröße' })}<span class="ed-brushdot" id="edWhiteDot"></span></div>
        <input type="range" id="edWhiteWidth" min="2" max="120" step="1" value="${Math.min(120, ed.whiteWidth)}" aria-label="Pinselgröße grob"></div>
      <p class="ed-hint">Über Ränder, Schatten, Flecken oder Notizen malen – deckt in Weiß ab und wird beim Übernehmen fest eingebrannt.</p>`);
  } else if (ed.tool === 'redact') {
    html = panelSection('Schwärzen', `<p class="ed-hint">Rechteck über den Inhalt ziehen. Vorhandene Balken lassen sich antippen, verschieben und skalieren.</p>
      <p class="ed-hint ed-hint-warn">${icon('warning', { size: 15 })} Wirklich entfernt ist der Inhalt erst nach dem Komprimieren mit einem Bild-Profil (nicht „Verlustfrei“).</p>`);
  } else if (ed.tool === 'crop') {
    const has = !!curPage().crop;
    html = panelSection('Zuschnitt', `<p class="ed-hint">Rechteck über den Bereich ziehen, der stehen bleiben soll.</p>
      <div class="ed-btnrow">
        <button class="btn btn-small btn-primary" id="edCropApply" ${ed.tempRect ? '' : 'disabled'}>${icon('check', { size: 15 })}<span>Zuschnitt setzen</span></button>
        <button class="btn btn-small" id="edCropClear" ${has ? '' : 'disabled'}>Entfernen</button>
      </div>
      <div class="ed-btnrow"><button class="btn btn-small" id="edFormatA4">${icon('a4', { size: 15 })}<span>Diese Seite auf A4 skalieren</span></button></div>`);
  } else if (ed.tool === 'text') {
    html = panelSection('Text', '<p class="ed-hint">Auf die Seite tippen, wo der Text stehen soll – danach direkt lostippen. Vorhandenen Text antippen zum Ändern.</p>');
  } else {
    idle = true;
    html = panelSection('Auswahl', `<p class="ed-hint">Objekt antippen, um es zu verschieben, zu skalieren oder zu ändern. Mit zwei Fingern oder dem Mausrad zoomen.</p>
      <div class="ed-quick">
        <button class="ed-quick-btn" data-quick="sign">${icon('signature', { size: 20 })}<span>Unterschreiben</span></button>
        <button class="ed-quick-btn" data-quick="text">${icon('text', { size: 20 })}<span>Text</span></button>
        <button class="ed-quick-btn" data-quick="stamp">${icon('stamp', { size: 20 })}<span>Stempel</span></button>
      </div>`);
  }
  panel.innerHTML = html;
  panel.classList.toggle('is-idle', idle);
  wirePanel(o);
  requestAnimationFrame(layoutPage);
}

function objectPanelBody(o) {
  if (o.type === 'text') {
    return `
      <div class="ed-field"><label class="ed-label" for="edTextInput">Text</label>
        <textarea id="edTextInput" rows="3" placeholder="Text eingeben …">${esc(o.text)}</textarea></div>
      <div class="ed-field"><label class="ed-label" for="edTextSizeNum">Größe (pt)</label>
        ${stepperHtml('edTextSize', o.size, { step: 1, min: 1, label: 'Schriftgröße' })}
        <input type="range" id="edTextSize" min="6" max="200" step="1" value="${Math.min(200, o.size)}" aria-label="Schriftgröße grob"></div>
      <div class="ed-field"><label class="ed-label" for="edTextFont">Schrift</label>
        <select id="edTextFont">
          <option value="helv">Helvetica</option><option value="helvB">Helvetica fett</option>
          <option value="times">Times</option><option value="courier">Courier</option>
        </select></div>
      <div class="ed-field"><span class="ed-label">Farbe</span>${swatchesHtml('edTextColor', o.color, INK_COLORS)}</div>`;
  }
  if (o.type === 'stamp') return stampFieldsHtml(o, 'edSt');
  if (o.type === 'sig-vector') {
    return `<div class="ed-field"><span class="ed-label">Farbe</span>${swatchesHtml('edSigColor', o.color, INK_COLORS)}</div>
      <p class="ed-hint">Ziehen zum Verschieben, Ecke ziehen zum Skalieren (Seitenverhältnis bleibt).</p>`;
  }
  if (o.type === 'image' || o.type === 'sig-image') {
    return `<label class="ed-check"><input type="checkbox" id="edAspect" ${o.free ? '' : 'checked'}> Seitenverhältnis beibehalten</label>
      <p class="ed-hint">Ziehen zum Verschieben, Ecke ziehen zum Skalieren.</p>`;
  }
  if (o.type === 'rect') {
    return `<div class="ed-field"><span class="ed-label">Farbe</span>${swatchesHtml('edRectColor', o.color, ['#000000', '#ffffff'])}</div>
      <p class="ed-hint ed-hint-warn">${icon('warning', { size: 15 })} Echt entfernt erst nach Komprimieren mit Bild-Profil.</p>`;
  }
  return '';
}

function stampFieldsHtml(o, p) {
  return `
    <div class="ed-field"><label class="ed-label" for="${p}Title">Text</label>
      <input type="text" id="${p}Title" value="${esc(o.title)}" maxlength="40" autocomplete="off">
      <div class="ed-chips">${STAMP_PRESETS.map((t) => `<button type="button" class="ed-chip ${t === o.title ? 'active' : ''}" data-title="${t}">${t}</button>`).join('')}</div></div>
    <div class="ed-field"><label class="ed-label" for="${p}Brand">Name / Firma (optional)</label>
      <input type="text" id="${p}Brand" value="${esc(o.brand || '')}" maxlength="60" placeholder="z. B. Peter Müller" autocomplete="off"></div>
    <div class="ed-field ed-field-row">
      <div class="ed-field"><label class="ed-label" for="${p}Date">Datum</label><input type="text" id="${p}Date" value="${esc(o.date || '')}" maxlength="24" autocomplete="off"></div>
      <button type="button" class="btn btn-small" id="${p}Today">Heute</button>
    </div>
    <div class="ed-field"><label class="ed-label" for="${p}Note">Notiz (optional)</label>
      <input type="text" id="${p}Note" value="${esc(o.note || '')}" maxlength="80" placeholder="z. B. per Überweisung" autocomplete="off"></div>
    <div class="ed-field"><span class="ed-label">Stil</span>
      <div class="seg ed-seg" id="${p}Style">
        <button data-v="frame" class="${(o.style || 'frame') === 'frame' ? 'active' : ''}" title="Schlichter Rahmen – Text bleibt durchsuchbar">Rahmen</button>
        <button data-v="stamp" class="${o.style === 'stamp' ? 'active' : ''}" title="Wie ein echter Stempel, leicht schräg">Stempel</button>
        <button data-v="round" class="${o.style === 'round' ? 'active' : ''}">Rund</button>
      </div></div>
    <div class="ed-field"><span class="ed-label">Farbe</span>${swatchesHtml(`${p}Color`, o.color, STAMP_COLORS)}</div>`;
}

/** Stempel-Felder mit einem Objekt verbinden (Panel oder Stempel-Blatt). */
function wireStampFields(root, p, o, onChange) {
  const q = (id) => root.querySelector(`#${p}${id}`);
  const upd = () => onChange();
  q('Title').oninput = (e) => {
    o.title = e.target.value.trim() || 'STEMPEL';
    root.querySelectorAll('.ed-chip[data-title]').forEach((c) => c.classList.toggle('active', c.dataset.title === o.title));
    upd();
  };
  root.querySelectorAll('.ed-chip[data-title]').forEach((c) => c.addEventListener('click', () => {
    o.title = c.dataset.title;
    q('Title').value = o.title;
    root.querySelectorAll('.ed-chip[data-title]').forEach((x) => x.classList.toggle('active', x === c));
    upd();
  }));
  q('Brand').oninput = (e) => { o.brand = e.target.value; upd(); };
  q('Date').oninput = (e) => { o.date = e.target.value; upd(); };
  q('Today').onclick = () => { o.date = today(); q('Date').value = o.date; upd(); };
  q('Note').oninput = (e) => { o.note = e.target.value; upd(); };
  q('Style').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    o.style = b.dataset.v;
    q('Style').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    // runde Stempel brauchen etwas mehr Höhe
    if (o.style === 'round' && o.h / o.w < 0.5) o.h = o.w * 0.56;
    upd();
  }));
  wireSwatches(root, `${p}Color`, (c) => { o.color = c; upd(); });
}

function wirePanel(o) {
  const panel = $('#edProps');
  panel.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.quick)));
  if (o) {
    $('#edDeleteBtn').onclick = deleteSelected;
    $('#edObjDup').onclick = duplicateSelected;
    $('#edObjFront').onclick = bringToFront;
    // Eine Änderungsserie am Objekt = ein Schritt im Verlauf
    let snapped = false;
    const change = (label) => { if (!snapped) { snapshot(label); snapped = true; } renderOverlay(); };
    if (o.type === 'text') {
      const ta = $('#edTextInput');
      ta.oninput = (e) => { o.text = e.target.value || ' '; change('Text geändert'); };
      wireNumber('edTextSize', {
        get: () => o.size,
        set: (v) => { o.size = v; change('Textgröße'); },
        rangeMax: 200,
        // Schrittweite wächst mit der Größe – so kommt man auch bei 300 pt flott voran
        stepFor: (v) => (v < 20 ? 1 : v < 60 ? 2 : v < 150 ? 5 : 10),
      });
      $('#edTextFont').value = o.font || 'helv';
      $('#edTextFont').onchange = (e) => { o.font = e.target.value; change('Schrift'); };
      wireSwatches(panel, 'edTextColor', (c) => { o.color = c; change('Textfarbe'); });
      if (ed.focusText) {
        ed.focusText = false;
        ta.focus();
        ta.select();
      }
    } else if (o.type === 'stamp') {
      wireStampFields(panel, 'edSt', o, () => change('Stempel geändert'));
    } else if (o.type === 'sig-vector') {
      wireSwatches(panel, 'edSigColor', (c) => { o.color = c; change('Farbe'); });
    } else if (o.type === 'rect') {
      wireSwatches(panel, 'edRectColor', (c) => { o.color = c; change('Farbe'); });
    } else if (o.type === 'image' || o.type === 'sig-image') {
      $('#edAspect').onchange = (e) => { o.free = !e.target.checked; };
    }
    return;
  }
  if (ed.tool === 'draw') {
    $('#edPenMode').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { ed.penMode = b.dataset.v; renderPanel(); }));
    if (ed.penMode !== 'erase') {
      wireSwatches(panel, 'edPenColor', (c) => { ed.penColor = c; });
      wireNumber('edPenWidth', { get: () => ed.penWidth, set: (v) => { ed.penWidth = v; }, min: 0.1, rangeMax: 40, stepFor: (v) => (v < 4 ? 0.5 : 2) });
    }
  } else if (ed.tool === 'whiteout') {
    const dot = $('#edWhiteDot');
    const syncDot = () => {
      const d = Math.min(46, Math.max(6, ed.whiteWidth * ed.fitScale() * ed.zoom));
      dot.style.width = `${d}px`;
      dot.style.height = `${d}px`;
    };
    wireNumber('edWhiteWidth', { get: () => ed.whiteWidth, set: (v) => { ed.whiteWidth = v; syncDot(); }, rangeMax: 120, stepFor: (v) => (v < 10 ? 1 : 4) });
    syncDot();
  } else if (ed.tool === 'crop') {
    $('#edCropApply').onclick = () => {
      if (ed.tempRect && ed.tempRect.w > 8 && ed.tempRect.h > 8) {
        snapshot('Zugeschnitten');
        curPage().crop = { ...ed.tempRect };
        ed.tempRect = null;
        renderOverlay();
        renderPanel();
        toast('Zuschnitt gesetzt', 'ok', 2000);
      }
    };
    $('#edCropClear').onclick = () => { snapshot('Zuschnitt entfernt'); delete curPage().crop; ed.tempRect = null; renderOverlay(); renderPanel(); };
    $('#edFormatA4').onclick = () => {
      snapshot('Seite auf A4');
      if (curPage().src == null) curPage().blankSize = A4.slice();
      else curPage().resizeTo = A4.slice();
      toast('Seite wird beim Übernehmen auf A4 skaliert', 'ok');
    };
  }
}

// ---------------------------------------------------------------- Zeiger (Maus, Finger, Stift)

function attachPointerHandlers() {
  const stage = $('#edStage');
  const pointers = new Map();
  let pinchStart = null;
  let dragging = null;

  const startDrag = (d) => { dragging = { ...d, snapped: false }; };
  const snapOnce = (label) => { if (dragging && !dragging.snapped) { snapshot(label); dragging.snapped = true; } };

  stage.addEventListener('pointerdown', (e) => {
    if (!ed || e.target.closest('.ed-float')) return;
    // Ein primärer Zeiger startet immer eine frische Geste (Reste verpasster
    // pointerup-Ereignisse – kommt auf iOS vor – verwerfen).
    if (e.isPrimary) {
      pointers.clear();
      pinchStart = null;
      dragging = null;
      ed.tempStroke = null;
    }
    try { stage.setPointerCapture(e.pointerId); } catch { /* nicht kritisch */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Zoomen mit zwei echten Fingern
    if (pointers.size === 2 && e.pointerType === 'touch') {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: ed.zoom, pan: { ...ed.pan }, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      dragging = null;
      ed.tempStroke = null;
      ed.tempRect = null;
      renderOverlay();
      return;
    }
    const pt = toPagePt(e);
    const tool = ed.tool;

    // Auswahl-Bedienelemente haben überall Vorrang
    if (e.target.closest?.('[data-del]')) { deleteSelected(); return; }
    const handle = e.target.closest?.('[data-handle]');
    if (handle && selObj()) {
      const o = selObj();
      const b = boxOf(o);
      const k = Number(handle.dataset.handle);
      // gegenüberliegende Ecke bleibt stehen
      const ax = k === 0 || k === 3 ? b.x + b.w : b.x;
      const ay = k === 0 || k === 1 ? b.y + b.h : b.y;
      startDrag({ kind: 'resize', k, ax, ay, orig: { ...o, box: b } });
      return;
    }

    if (tool === 'select' || tool === 'text' || tool === 'redact') {
      const types = tool === 'redact' ? ['rect'] : tool === 'text' ? ['text'] : null;
      const hit = hitObject(pt, types);
      if (hit != null) {
        if (hit !== ed.selected) select(hit);
        const o = curPage().objects[hit];
        startDrag({ kind: 'move', start: pt, orig: { x: o.x, y: o.y } });
        return;
      }
      if (ed.selected != null) {
        ed.selected = null;
        renderPanel();
        renderOverlay();
        if (tool === 'select') return;   // erster Tipp daneben hebt nur die Auswahl auf
      }
    }

    if (tool === 'select') {
      startDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, pan: { ...ed.pan } });
    } else if (tool === 'text') {
      snapshot('Text eingefügt');
      curPage().objects.push({ type: 'text', x: pt.x, y: pt.y - 8, size: 14, color: '#111111', font: 'helv', text: 'Text' });
      ed.focusText = true;
      select(curPage().objects.length - 1);
    } else if (tool === 'draw' && ed.penMode === 'erase') {
      startDrag({ kind: 'erase' });
      eraseAt(pt, () => snapOnce('Radiert'));
    } else if (tool === 'draw' || tool === 'whiteout') {
      ed.tempStroke = [pt];
      startDrag({ kind: 'draw' });
      renderOverlay();
    } else if (tool === 'crop' || tool === 'redact') {
      startDrag({ kind: 'rect', start: pt });
      ed.tempRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!ed) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist;
      ed.zoom = Math.min(8, Math.max(0.5, pinchStart.zoom * factor));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ed.pan = {
        x: pinchStart.pan.x + (mid.x - pinchStart.mid.x) + (1 - ed.zoom / pinchStart.zoom) * (pinchStart.mid.x - stage.clientWidth / 2 - pinchStart.pan.x),
        y: pinchStart.pan.y + (mid.y - pinchStart.mid.y) + (1 - ed.zoom / pinchStart.zoom) * (pinchStart.mid.y - stage.clientHeight / 2 - pinchStart.pan.y),
      };
      applyZoom();
      return;
    }
    if (!dragging) return;
    const pt = toPagePt(e);
    const o = selObj();
    if (dragging.kind === 'pan') {
      ed.pan = { x: dragging.pan.x + e.clientX - dragging.start.x, y: dragging.pan.y + e.clientY - dragging.start.y };
      applyZoom();
    } else if (dragging.kind === 'move' && o) {
      const dx = pt.x - dragging.start.x;
      const dy = pt.y - dragging.start.y;
      if (!dragging.snapped && Math.hypot(dx, dy) < 1.5) return;   // nur angetippt
      snapOnce(`${TYPE_NAME[o.type] || 'Objekt'} verschoben`);
      o.x = dragging.orig.x + dx;
      o.y = dragging.orig.y + dy;
      renderOverlay();
    } else if (dragging.kind === 'resize' && o) {
      snapOnce('Größe geändert');
      resizeObject(o, dragging, pt);
      renderOverlay();
    } else if (dragging.kind === 'draw') {
      ed.tempStroke.push(pt);
      renderOverlay();
    } else if (dragging.kind === 'erase') {
      eraseAt(pt, () => snapOnce('Radiert'));
    } else if (dragging.kind === 'rect') {
      ed.tempRect = {
        x: Math.min(dragging.start.x, pt.x),
        y: Math.min(dragging.start.y, pt.y),
        w: Math.abs(pt.x - dragging.start.x),
        h: Math.abs(pt.y - dragging.start.y),
      };
      renderOverlay();
    }
  });

  const finish = (e) => {
    if (!ed) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (dragging?.kind === 'rect' && ed.tempRect) {
      if (ed.tool === 'redact') {
        if (ed.tempRect.w > 4 && ed.tempRect.h > 4) {
          snapshot('Geschwärzt');
          curPage().objects.push({ type: 'rect', color: '#000000', ...ed.tempRect });
          ed.tempRect = null;
          select(curPage().objects.length - 1);
        }
        ed.tempRect = null;
        renderOverlay();
      } else {
        renderPanel();   // „Zuschnitt setzen“ freischalten
      }
    }
    if (dragging?.kind === 'draw' && ed.tempStroke?.length) {
      const stroke = ed.tempStroke;
      ed.tempStroke = null;
      // Abdecken ist ein deckender Strich in Weiß – dieselbe Ink-Struktur
      const white = ed.tool === 'whiteout';
      const color = white ? '#ffffff' : ed.penColor;
      const width = white ? ed.whiteWidth : ed.penWidth;
      const opacity = white ? 1 : (ed.penMode === 'marker' ? 0.45 : 1);
      snapshot(white ? 'Abgedeckt' : 'Gezeichnet');
      const objs = curPage().objects;
      const last = objs[objs.length - 1];
      if (last && last.type === 'ink' && last.color === color && last.width === width && (last.opacity ?? 1) === opacity) {
        last.paths.push(stroke);
      } else {
        objs.push({ type: 'ink', color, width, opacity, paths: [stroke] });
      }
      renderOverlay();
    }
    dragging = null;
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
  // Global aufräumen: endet ein Zeiger außerhalb der Bühne, bliebe er sonst
  // als „Geisterfinger“ stehen.
  const cleanup = (e) => { if (pointers.has(e.pointerId)) finish(e); };
  window.addEventListener('pointerup', cleanup);
  window.addEventListener('pointercancel', cleanup);
  stage.addEventListener('lostpointercapture', cleanup);

  stage.addEventListener('wheel', (e) => {
    if (!ed) return;
    e.preventDefault();
    zoomTo(ed.zoom * (e.deltaY > 0 ? 0.88 : 1.14));
  }, { passive: false });
}

/** Ecke ziehen: gegenüberliegende Ecke bleibt; Bilder/Unterschriften/Stempel proportional. */
function resizeObject(o, d, pt) {
  const minS = 8;
  const sx = d.k === 1 || d.k === 2 ? 1 : -1;
  const sy = d.k === 2 || d.k === 3 ? 1 : -1;
  let w = Math.max(minS, (pt.x - d.ax) * sx);
  let h = Math.max(minS, (pt.y - d.ay) * sy);
  const b = d.orig.box;
  if (o.type === 'text') {
    // Text: Schriftgröße folgt der Rahmenhöhe (keine Obergrenze)
    const f = Math.max(w / b.w, h / b.h);
    o.size = Math.max(1, d.orig.size * f);
    const nb = boxOf(o);
    o.x = (sx > 0 ? d.ax : d.ax - nb.w) + 2;
    o.y = (sy > 0 ? d.ay : d.ay - nb.h) + 2;
    return;
  }
  const keep = o.type === 'sig-vector' || o.type === 'stamp' || ((o.type === 'image' || o.type === 'sig-image') && !o.free);
  if (keep) {
    const ratio = b.h / b.w;
    if (h / ratio > w) w = h / ratio;
    h = w * ratio;
  }
  o.w = w;
  o.h = h;
  o.x = sx > 0 ? d.ax : d.ax - w;
  o.y = sy > 0 ? d.ay : d.ay - h;
}

function eraseAt(pt, before) {
  const objs = curPage().objects;
  const r = 6 / (ed.zoom * ed.fitScale()) + 3;
  let changed = false;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type !== 'ink' || o.color === '#ffffff') continue;
    const keep = o.paths.filter((stroke) => !stroke.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < r + o.width / 2));
    if (keep.length !== o.paths.length) {
      if (!changed) before?.();
      changed = true;
      o.paths = keep;
      if (!keep.length) objs.splice(i, 1);
    }
  }
  if (changed) renderOverlay();
}

// ---------------------------------------------------------------- Hilfen: Bilder & Assets

// Bild robust laden (HEIC/Safari-Fallback über <img>)
async function loadBitmap(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function addAssetFromDataUrl(dataUrl, kind) {
  const id = `a${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const bin = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  ed.state.assets.bytes[id] = bytes;
  ed.state.assets.kind[id] = kind;
  ed.state.assets.url[id] = dataUrl;
  return id;
}

// ---------------------------------------------------------------- Blätter (Modal)

function openSheet(title, body, { foot = '', wide = false, onClose = null } = {}) {
  const box = $('#edModalBox');
  box.className = `ed-modal-box${wide ? ' wide' : ''}`;
  box.innerHTML = `
    <div class="ed-sheet-head"><h3>${title}</h3><button class="ed-iconbtn" id="edSheetClose" aria-label="Schließen">${icon('close', { size: 19 })}</button></div>
    <div class="ed-sheet-body">${body}</div>
    ${foot ? `<div class="ed-sheet-foot">${foot}</div>` : ''}`;
  $('#edModal').classList.remove('hidden');
  ed.sheetClose = onClose;
  $('#edSheetClose').onclick = closeSheet;
  return box;
}

function closeSheet() {
  $('#edModal').classList.add('hidden');
  const fn = ed?.sheetClose;
  if (ed) ed.sheetClose = null;
  fn?.();
}

const sheetOpen = () => !$('#edModal')?.classList.contains('hidden');

// ---------------------------------------------------------------- Unterschrift

function sigPreviewEl(sig, w = 180) {
  if (sig.kind === 'image') {
    const img = document.createElement('img');
    img.src = sig.dataUrl;
    img.alt = sig.name || 'Unterschrift';
    return img;
  }
  const c = document.createElement('canvas');
  c.width = w * 2;
  c.height = Math.max(40, Math.round((w * 2) / (sig.aspect || 3)));
  const ctx = c.getContext('2d');
  ctx.strokeStyle = sig.color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const padX = 8;
  const padY = 8;
  for (const st of sig.strokes) {
    ctx.stroke(new Path2D(strokeToSvgPath(st.map((p) => ({ x: padX + p.x * (c.width - padX * 2), y: padY + p.y * (c.height - padY * 2) })))));
  }
  return c;
}

async function openSignSheet() {
  const saved = await listSignatures();
  const box = openSheet('Unterschrift', `
    <div class="seg ed-tabs" role="tablist">
      <button class="ed-tab" data-tab="savedTab" role="tab">Gespeichert (${saved.length})</button>
      <button class="ed-tab" data-tab="drawTab" role="tab">Zeichnen</button>
      <button class="ed-tab" data-tab="photoTab" role="tab">Bild / Foto</button>
    </div>
    <div id="savedTab" class="ed-tabpane"><div id="sigSavedList" class="ed-sig-grid"></div></div>
    <div id="drawTab" class="ed-tabpane hidden">
      <div class="ed-pad-wrap"><canvas id="sigPad" width="900" height="300"></canvas><span class="ed-pad-hint">Hier unterschreiben</span></div>
      <div class="ed-pad-tools">
        ${swatchesHtml('sigColor', '#1b2a80', ['#111111', '#1b2a80', '#1d4ed8'])}
        <label class="ed-inline ed-label">Stift <input type="range" id="sigWidth" min="1.5" max="7" step="0.5" value="3.5"></label>
        <button class="btn btn-small" id="sigClear">${icon('undo', { size: 15 })}<span>Neu</span></button>
      </div>
      <label class="ed-check"><input type="checkbox" id="sigSave" checked> Speichern als <input type="text" id="sigName" value="Meine Unterschrift" maxlength="40"></label>
      <div class="ed-sheet-actions"><button class="btn btn-primary" id="sigUseDrawn" disabled>${icon('check', { size: 16 })}<span>Einfügen</span></button></div>
    </div>
    <div id="photoTab" class="ed-tabpane hidden">
      <button class="ed-dropzone" id="sigPhotoPick">${icon('image', { size: 26 })}<strong>Bild wählen</strong><small>Foto der Unterschrift auf weißem Papier – oder ein freigestelltes PNG</small></button>
      <div class="ed-photo hidden" id="sigPhotoBox">
        <div class="ed-checker"><canvas id="sigPhotoPreview"></canvas></div>
        <p class="ed-hint" id="sigPhotoInfo"></p>
        <div class="ed-photo-ctrls" id="sigPhotoCtrls">
          <label class="ed-label">Schwellwert <input type="range" id="sigThr" min="0" max="100" value="50"></label>
          <label class="ed-label">Helligkeit <input type="range" id="sigBright" min="-100" max="100" value="0"></label>
          <label class="ed-label">Kontrast <input type="range" id="sigContrast" min="-100" max="100" value="0"></label>
        </div>
        <div class="ed-field"><span class="ed-label">Farbe</span>
          <div class="seg ed-seg" id="sigPhotoColorSeg">
            <button data-v="original">Original</button><button data-v="#111111">Schwarz</button><button data-v="#1b2a80">Blau</button>
          </div></div>
        <label class="ed-check"><input type="checkbox" id="sigPhotoSave" checked> Speichern als <input type="text" id="sigPhotoName" value="Unterschrift (Bild)" maxlength="40"></label>
        <div class="ed-sheet-actions"><button class="btn btn-primary" id="sigUsePhoto">${icon('check', { size: 16 })}<span>Einfügen</span></button></div>
      </div>
    </div>`, { wide: true });

  const showTab = (id) => {
    box.querySelectorAll('.ed-tab').forEach((x) => {
      x.classList.toggle('active', x.dataset.tab === id);
      x.setAttribute('aria-selected', String(x.dataset.tab === id));
    });
    box.querySelectorAll('.ed-tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== id));
  };
  box.querySelectorAll('.ed-tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  showTab(saved.length ? 'savedTab' : 'drawTab');

  // --- Gespeicherte
  const listEl = $('#sigSavedList');
  const renderSaved = async () => {
    const sigs = await listSignatures();
    box.querySelector('[data-tab="savedTab"]').textContent = `Gespeichert (${sigs.length})`;
    listEl.innerHTML = sigs.length ? '' : '<p class="ed-hint">Noch keine gespeicherten Unterschriften – zeichne eine oder lade ein Bild.</p>';
    for (const sig of sigs) {
      const card = document.createElement('div');
      card.className = 'ed-sig-card';
      const use = document.createElement('button');
      use.className = 'ed-sig-use';
      use.title = `„${sig.name}“ einfügen`;
      use.append(sigPreviewEl(sig));
      const name = document.createElement('span');
      name.textContent = sig.name;
      use.append(name);
      use.onclick = () => insertSignature(sig);
      const del = document.createElement('button');
      del.className = 'ed-iconbtn ed-sig-del';
      del.setAttribute('aria-label', `„${sig.name}“ löschen`);
      del.innerHTML = icon('trash', { size: 15 });
      del.onclick = async () => {
        if (!(await confirmDialog('Unterschrift löschen?', `„${sig.name}“ wird aus der Liste entfernt.`, 'Löschen', 'danger'))) return;
        await deleteSignature(sig.id);
        renderSaved();
      };
      card.append(use, del);
      listEl.appendChild(card);
    }
  };
  renderSaved();

  // --- Zeichnen
  const pad = $('#sigPad');
  const pctx = pad.getContext('2d');
  let strokes = [];
  let cur = null;
  let penColor = '#1b2a80';
  const padPt = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
  };
  const repaint = () => {
    pctx.clearRect(0, 0, pad.width, pad.height);
    pctx.strokeStyle = '#d5dbe6';
    pctx.lineWidth = 2;
    pctx.setLineDash([8, 8]);
    pctx.beginPath();
    pctx.moveTo(50, pad.height * 0.74);
    pctx.lineTo(pad.width - 50, pad.height * 0.74);
    pctx.stroke();
    pctx.setLineDash([]);
    pctx.strokeStyle = penColor;
    pctx.lineWidth = parseFloat($('#sigWidth').value) * 2.2;
    pctx.lineCap = 'round';
    pctx.lineJoin = 'round';
    for (const st of strokes.concat(cur ? [cur] : [])) pctx.stroke(new Path2D(strokeToSvgPath(st)));
    $('#sigUseDrawn').disabled = !strokes.length;
    box.querySelector('.ed-pad-hint')?.classList.toggle('hidden', strokes.length > 0 || !!cur);
  };
  repaint();
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); pad.setPointerCapture(e.pointerId); cur = [padPt(e)]; repaint(); });
  pad.addEventListener('pointermove', (e) => { if (cur) { cur.push(padPt(e)); repaint(); } });
  const padUp = () => { if (cur && cur.length > 1) strokes.push(cur); cur = null; repaint(); };
  pad.addEventListener('pointerup', padUp);
  pad.addEventListener('pointercancel', padUp);
  $('#sigClear').onclick = () => { strokes = []; cur = null; repaint(); };
  wireSwatches(box, 'sigColor', (c) => { penColor = c; repaint(); });
  $('#sigWidth').oninput = repaint;
  $('#sigUseDrawn').onclick = async () => {
    if (!strokes.length) return;
    const { aspect, strokes: norm } = normalizeStrokes(strokes);
    const widthN = (parseFloat($('#sigWidth').value) * 2.2) / (300 * Math.min(1, aspect >= 1 ? 1 : aspect));
    const sig = { kind: 'vector', name: $('#sigName').value.trim() || 'Unterschrift', strokes: norm, aspect, color: penColor, widthN };
    if ($('#sigSave').checked) await saveSignature({ ...sig });
    insertSignature(sig);
  };

  // --- Bild / Foto
  let bitmap = null;
  let transparent = false;
  let processed = null;
  let color = 'original';
  const setColorSeg = () => $('#sigPhotoColorSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === color));
  $('#sigPhotoPick').onclick = () => $('#edSigPhotoInput').click();
  $('#edSigPhotoInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !$('#sigPhotoBox')) return;
    try {
      bitmap = await loadBitmap(file);
    } catch {
      toast('Bild konnte nicht gelesen werden', 'err');
      return;
    }
    transparent = hasTransparency(bitmap);
    // Freigestelltes PNG: Farben behalten. Foto: dunkelblau wie Tinte.
    color = transparent ? 'original' : '#1b2a80';
    setColorSeg();
    $('#sigPhotoCtrls').classList.toggle('hidden', transparent);
    $('#sigPhotoInfo').textContent = transparent
      ? 'Transparentes PNG erkannt – der Hintergrund bleibt durchsichtig.'
      : 'Foto: Papier wird entfernt. Mit dem Schwellwert bestimmst du, was als Tinte zählt.';
    $('#sigPhotoBox').classList.remove('hidden');
    $('#sigPhotoPick').classList.add('compact');
    updatePhoto();
  };
  const updatePhoto = () => {
    if (!bitmap) return;
    processed = processSignatureImage(bitmap, {
      threshold: parseInt($('#sigThr').value, 10),
      brightness: parseInt($('#sigBright').value, 10),
      contrast: parseInt($('#sigContrast').value, 10),
      color,
      transparent,
    });
    const prev = $('#sigPhotoPreview');
    prev.width = processed.width;
    prev.height = processed.height;
    const pc = prev.getContext('2d');
    pc.clearRect(0, 0, prev.width, prev.height);
    pc.drawImage(processed, 0, 0);
  };
  ['sigThr', 'sigBright', 'sigContrast'].forEach((id) => { $(`#${id}`).oninput = updatePhoto; });
  $('#sigPhotoColorSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { color = b.dataset.v; setColorSeg(); updatePhoto(); }));
  $('#sigUsePhoto').onclick = async () => {
    if (!processed) return;
    const dataUrl = processed.toDataURL('image/png');
    const sig = { kind: 'image', name: $('#sigPhotoName').value.trim() || 'Unterschrift', dataUrl, aspect: processed.width / processed.height };
    if ($('#sigPhotoSave').checked) await saveSignature({ ...sig });
    insertSignature(sig);
  };
}

function insertSignature(sig) {
  closeSheet();
  const w = Math.min(170, ed.pagePt.w * 0.32);
  const h = w / (sig.aspect || 3);
  if (sig.kind === 'image') {
    const assetId = addAssetFromDataUrl(sig.dataUrl, 'png');
    insertObject({ type: 'sig-image', assetId, w, h, color: '#000000' }, 'Unterschrift eingefügt');
  } else {
    insertObject({ type: 'sig-vector', strokes: sig.strokes, w, h, color: sig.color, widthN: sig.widthN || 0.02 }, 'Unterschrift eingefügt');
  }
  toast('Unterschrift eingefügt – an die richtige Stelle ziehen, Ecke zum Skalieren', 'info', 4500);
}

// ---------------------------------------------------------------- Stempel

function newStampDraft() {
  return { type: 'stamp', w: 180, h: 62, color: '#c00000', title: 'BEZAHLT', brand: '', date: today(), note: '', style: 'frame' };
}

function stampPreviewSvg(o) {
  const p = { ...o, x: 4, y: 4 };
  return `<svg viewBox="0 0 ${o.w + 8} ${o.h + 8}" class="ed-stamp-svg" role="img" aria-label="Vorschau">${objectSvg(p)}</svg>`;
}

async function openStampSheet() {
  const draft = ed.lastStamp ? { ...ed.lastStamp, date: ed.lastStamp.dateAuto === false ? ed.lastStamp.date : today() } : newStampDraft();
  const box = openSheet('Stempel', `
    <div class="ed-stamp">
      <div class="ed-stamp-preview" id="edStampPreview"></div>
      <div class="ed-stamp-form">${stampFieldsHtml(draft, 'stD')}</div>
    </div>
    <div class="ed-field"><span class="ed-label">Vorlagen</span><div class="ed-tpls" id="edTplList"></div></div>`, {
    wide: true,
    foot: `<button class="btn btn-small" id="edStampFromImg">${icon('image', { size: 15 })}<span>Bild als Stempel …</span></button>
      <span class="spacer"></span>
      <button class="btn btn-small" id="edStampSaveTpl">${icon('download', { size: 15 })}<span>Als Vorlage</span></button>
      <button class="btn btn-primary" id="edStampInsert">${icon('check', { size: 16 })}<span>Einfügen</span></button>`,
  });
  const preview = () => { $('#edStampPreview').innerHTML = stampPreviewSvg(draft); };
  wireStampFields(box, 'stD', draft, preview);
  preview();

  const renderTpls = async () => {
    const list = $('#edTplList');
    if (!list) return;
    const stamps = await listStamps();
    list.innerHTML = stamps.length ? '' : '<p class="ed-hint">Noch keine eigenen Vorlagen – Stempel einrichten und „Als Vorlage“ tippen.</p>';
    for (const st of stamps) {
      const card = document.createElement('div');
      card.className = 'ed-tpl';
      const use = document.createElement('button');
      use.className = 'ed-tpl-use';
      if (st.kind === 'image') {
        use.innerHTML = `<img src="${st.dataUrl}" alt="">`;
        use.title = st.name || 'Bild-Stempel';
        use.onclick = () => insertImageStamp(st);
      } else {
        const o = { ...newStampDraft(), ...st, type: 'stamp', date: st.dateAuto === false ? st.date : today() };
        use.innerHTML = stampPreviewSvg(o);
        use.title = `${st.brand ? `${st.brand} – ` : ''}${st.title}`;
        use.onclick = () => {
          Object.assign(draft, o);
          box.querySelector('.ed-stamp-form').innerHTML = stampFieldsHtml(draft, 'stD');
          wireStampFields(box, 'stD', draft, preview);
          preview();
        };
      }
      const del = document.createElement('button');
      del.className = 'ed-iconbtn ed-tpl-del';
      del.setAttribute('aria-label', 'Vorlage löschen');
      del.innerHTML = icon('close', { size: 14 });
      del.onclick = async () => { await deleteStamp(st.id); renderTpls(); };
      card.append(use, del);
      list.appendChild(card);
    }
  };
  renderTpls();

  $('#edStampSaveTpl').onclick = async () => {
    await saveStamp({ kind: 'text', title: draft.title, brand: draft.brand || '', note: draft.note || '', color: draft.color, style: draft.style || 'frame', w: draft.w, h: draft.h, dateAuto: draft.date === today(), date: draft.date });
    toast('Als Vorlage gespeichert', 'ok', 2000);
    renderTpls();
  };
  $('#edStampInsert').onclick = () => {
    ed.lastStamp = { ...draft, dateAuto: draft.date === today() };
    closeSheet();
    insertObject({ ...draft }, 'Stempel eingefügt');
  };
  $('#edStampFromImg').onclick = () => $('#edStampImageInput').click();
}

function insertImageStamp(st) {
  closeSheet();
  const assetId = addAssetFromDataUrl(st.dataUrl, 'png');
  const w = 150;
  insertObject({ type: 'image', assetId, w, h: w / (st.aspect || 2.5) }, 'Stempel eingefügt');
}

async function onStampImage(file) {
  let bmp;
  try { bmp = await loadBitmap(file); } catch { toast('Bild konnte nicht gelesen werden', 'err'); return; }
  const transparent = hasTransparency(bmp);
  // Logo/Stempel-Scan: Farben behalten, nur weißen Hintergrund entfernen
  const processed = processSignatureImage(bmp, { threshold: 82, color: 'original', transparent });
  const dataUrl = processed.toDataURL('image/png');
  const st = { kind: 'image', name: file.name.replace(/\.[^.]+$/, '') || 'Bild-Stempel', dataUrl, aspect: processed.width / processed.height };
  await saveStamp({ ...st });
  toast(transparent ? 'Bild-Stempel gespeichert (Transparenz übernommen)' : 'Bild-Stempel gespeichert (weißer Hintergrund entfernt)', 'ok', 3000);
  insertImageStamp(st);
}

// ---------------------------------------------------------------- Bild einfügen

async function onImagePicked(file) {
  let bitmap;
  try { bitmap = await loadBitmap(file); } catch { toast('Bild konnte nicht gelesen werden', 'err'); return; }
  const canvas = document.createElement('canvas');
  const s = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * s);
  canvas.height = Math.round(bitmap.height * s);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // Transparenz erhalten (PNG), Fotos als JPEG
  const keepAlpha = hasTransparency(canvas);
  const dataUrl = keepAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88);
  const assetId = addAssetFromDataUrl(dataUrl, keepAlpha ? 'png' : 'jpeg');
  const w = Math.min(ed.pagePt.w * 0.5, 250);
  insertObject({ type: 'image', assetId, w, h: w * (canvas.height / canvas.width), color: '#000000' }, 'Bild eingefügt');
}

// ---------------------------------------------------------------- Seitenverwaltung

// Quelle für „Seite scannen“. Wird von app.js gesetzt, sobald das Backend
// einen Netzwerk-Scanner meldet.
let scanProvider = null;
export function setScanProvider(fn) { scanProvider = fn || null; }

/**
 * Hängt ein Bild als neue Seite an: A4-Blatt (hoch oder quer je nach
 * Seitenverhältnis), Bild unverzerrt eingepasst und zentriert.
 */
async function addImagePage(file, atIndex = null) {
  const bitmap = await loadBitmap(file);
  const canvas = document.createElement('canvas');
  const s = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * s));
  canvas.height = Math.max(1, Math.round(bitmap.height * s));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const isJpeg = /jpe?g/i.test(file.type || '');
  const dataUrl = canvas.toDataURL(isJpeg ? 'image/jpeg' : 'image/png', 0.9);
  const assetId = addAssetFromDataUrl(dataUrl, isJpeg ? 'jpeg' : 'png');

  const landscape = canvas.width > canvas.height;
  const [pw, ph] = landscape ? [A4[1], A4[0]] : A4.slice();
  const fit = Math.min(pw / canvas.width, ph / canvas.height);
  const w = canvas.width * fit;
  const h = canvas.height * fit;
  const page = {
    src: null,
    blankSize: [pw, ph],
    objects: [{ type: 'image', assetId, color: '#000000', x: (pw - w) / 2, y: (ph - h) / 2, w, h }],
  };
  if (atIndex == null) ed.state.pages.push(page);
  else ed.state.pages.splice(atIndex, 0, page);
  return page;
}

async function pageThumb(entry, tw = 112, th = 158) {
  const thumb = document.createElement('canvas');
  thumb.width = tw * 2;
  thumb.height = th * 2;
  const tctx = thumb.getContext('2d');
  tctx.scale(2, 2);
  let [bw, bh] = entry.blankSize || A4;
  if (entry.src != null) {
    const page = await ed.pdf.getPage(entry.src + 1);
    const rot = ((page.rotate || 0) + (entry.rotate || 0)) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const sc = Math.min(tw / vp1.width, th / vp1.height);
    const vp = page.getViewport({ scale: sc * 2, rotation: rot });
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(vp.width));
    off.height = Math.max(1, Math.round(vp.height));
    const octx = off.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, off.width, off.height);
    await page.render({ canvasContext: octx, viewport: vp }).promise;
    const dw = off.width / 2;
    const dh = off.height / 2;
    tctx.drawImage(off, (tw - dw) / 2, (th - dh) / 2, dw, dh);
    return thumb;
  }
  if ((entry.rotate || 0) % 180 !== 0) [bw, bh] = [bh, bw];
  const sc = Math.min(tw / bw, th / bh);
  const ox = (tw - bw * sc) / 2;
  const oy = (th - bh * sc) / 2;
  tctx.fillStyle = '#fff';
  tctx.fillRect(ox, oy, bw * sc, bh * sc);
  const imgObj = (entry.objects || []).find((o) => o.type === 'image' && ed.state.assets.url[o.assetId]);
  if (imgObj && !(entry.rotate % 180)) {
    await new Promise((res) => {
      const im = new Image();
      im.onload = () => { tctx.drawImage(im, ox + imgObj.x * sc, oy + imgObj.y * sc, imgObj.w * sc, imgObj.h * sc); res(); };
      im.onerror = res;
      im.src = ed.state.assets.url[imgObj.assetId];
    });
  }
  return thumb;
}

function openPagesSheet() {
  openSheet('Seiten', `
    <div class="ed-addrow">
      <span class="ed-label">Seite hinzufügen</span>
      <div class="ed-btnrow">
        <button class="btn btn-small ${scanProvider ? '' : 'hidden'}" id="edAddScan">${icon('scanner', { size: 15 })}<span>Scannen</span></button>
        <button class="btn btn-small" id="edAddCam">${icon('camera', { size: 15 })}<span>Kamera</span></button>
        <button class="btn btn-small" id="edAddPhoto">${icon('image', { size: 15 })}<span>Fotos / Dateien</span></button>
        <button class="btn btn-small" id="edAddBlank">${icon('plus', { size: 15 })}<span>Leere A4-Seite</span></button>
      </div>
    </div>
    <p class="ed-hint" id="edPagesHint" aria-live="polite"></p>
    <div class="ed-pagegrid" id="edPageGrid"></div>
    <input type="file" id="edPageCamInput" accept="image/*" capture="environment" hidden>
    <input type="file" id="edPagePhotoInput" accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif" multiple hidden>`, {
    wide: true,
    foot: `<button class="btn btn-small" id="edAllA4">${icon('a4', { size: 15 })}<span>Alle auf A4</span></button>
      <label class="ed-check"><input type="checkbox" id="edPageNums" ${ed.state.pageNumbers ? 'checked' : ''}> Seitenzahlen</label>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="edPagesClose">${icon('check', { size: 16 })}<span>Fertig</span></button>`,
    onClose: () => { if (ed.pageIdx >= ed.state.pages.length) ed.pageIdx = ed.state.pages.length - 1; ed.selected = null; renderPageView(); renderPanel(); },
  });
  $('#edPagesClose').onclick = closeSheet;
  $('#edAddBlank').onclick = () => { snapshot('Leere Seite'); ed.state.pages.push({ src: null, blankSize: A4.slice(), objects: [] }); renderGrid(); };

  const hint = $('#edPagesHint');
  const busy = (on, text = '') => {
    hint.textContent = text;
    ['#edAddScan', '#edAddCam', '#edAddPhoto', '#edAddBlank'].forEach((sel) => { const b = $(sel); if (b) b.disabled = on; });
  };
  const addFiles = async (files) => {
    const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i.test(f.name));
    if (!list.length) return;
    snapshot('Seiten hinzugefügt');
    busy(true, `${list.length} Bild${list.length === 1 ? '' : 'er'} wird eingefügt …`);
    try {
      for (const f of list) await addImagePage(f);
      await renderGrid();
      busy(false, `${list.length} Seite${list.length === 1 ? '' : 'n'} hinzugefügt.`);
    } catch (e) {
      busy(false, `Hinzufügen fehlgeschlagen: ${e?.message || e}`);
    }
  };
  $('#edAddCam').onclick = () => $('#edPageCamInput').click();
  $('#edAddPhoto').onclick = () => $('#edPagePhotoInput').click();
  // files ist eine lebende Liste – erst kopieren, dann das Feld leeren
  const takeFiles = (e) => { const f = [...e.target.files]; e.target.value = ''; return f; };
  $('#edPageCamInput').onchange = (e) => addFiles(takeFiles(e));
  $('#edPagePhotoInput').onchange = (e) => addFiles(takeFiles(e));
  if (scanProvider) {
    $('#edAddScan').onclick = async () => {
      busy(true, 'Scanne … Vorlage auflegen');
      try {
        const file = await scanProvider();
        snapshot('Seite gescannt');
        await addImagePage(file);
        await renderGrid();
        busy(false, 'Seite gescannt und angefügt.');
      } catch (e) {
        busy(false, `Scan fehlgeschlagen: ${e?.message || e}`);
      }
    };
  }
  $('#edAllA4').onclick = () => {
    snapshot('Alle Seiten auf A4');
    for (const p of ed.state.pages) {
      if (p.src == null) p.blankSize = A4.slice();
      else p.resizeTo = A4.slice();
    }
    renderGrid();
    hint.textContent = 'Alle Seiten werden beim Übernehmen auf A4 gebracht.';
  };
  $('#edPageNums').onchange = (e) => { ed.state.pageNumbers = e.target.checked; };

  const renderGrid = async () => {
    const grid = $('#edPageGrid');
    if (!grid) return;
    const cells = [];
    for (let i = 0; i < ed.state.pages.length; i++) {
      const entry = ed.state.pages[i];
      const cell = document.createElement('div');
      cell.className = `ed-pagecell${i === ed.pageIdx ? ' current' : ''}`;
      const thumbBtn = document.createElement('button');
      thumbBtn.className = 'ed-pagethumb';
      thumbBtn.title = `Seite ${i + 1} bearbeiten`;
      thumbBtn.append(await pageThumb(entry));
      thumbBtn.onclick = () => { ed.pageIdx = i; closeSheet(); };
      const bar = document.createElement('div');
      bar.className = 'ed-pagecell-bar';
      const mk = (name, title, fn, disabled) => {
        const b = document.createElement('button');
        b.className = 'btn btn-small';
        b.innerHTML = icon(name, { size: 15 });
        b.title = title;
        b.setAttribute('aria-label', title);
        b.disabled = !!disabled;
        b.onclick = () => { snapshot(title); fn(); renderGrid(); };
        return b;
      };
      const n = ed.state.pages.length;
      bar.append(
        mk('chevronLeft', 'Nach vorne schieben', () => { [ed.state.pages[i - 1], ed.state.pages[i]] = [ed.state.pages[i], ed.state.pages[i - 1]]; }, i === 0),
        mk('rotate', 'Seite drehen', () => { entry.rotate = ((entry.rotate || 0) + 90) % 360; }),
        mk('duplicate', 'Seite duplizieren', () => { ed.state.pages.splice(i + 1, 0, JSON.parse(JSON.stringify(entry))); }),
        mk('trash', 'Seite löschen', () => { ed.state.pages.splice(i, 1); if (ed.pageIdx >= ed.state.pages.length) ed.pageIdx = ed.state.pages.length - 1; }, n <= 1),
        mk('chevronRight', 'Nach hinten schieben', () => { [ed.state.pages[i + 1], ed.state.pages[i]] = [ed.state.pages[i], ed.state.pages[i + 1]]; }, i === n - 1),
      );
      const label = document.createElement('div');
      label.className = 'ed-pagelabel';
      const hasImg = (entry.objects || []).some((o) => o.type === 'image');
      const kind = entry.src != null ? '' : (hasImg ? ' (Bild)' : ' (leer)');
      label.textContent = `Seite ${i + 1}${kind}${entry.resizeTo ? ' · A4' : ''}${entry.rotate ? ` · ${entry.rotate}°` : ''}`;
      cell.append(thumbBtn, label, bar);
      cells.push(cell);
    }
    if ($('#edPageGrid') === grid) grid.replaceChildren(...cells);
  };
  renderGrid();
}

// ---------------------------------------------------------------- Formular

function openFormSheet() {
  const rows = ed.formFields.map((f, i) => {
    const val = ed.state.formValues[f.name] ?? f.value ?? '';
    if (f.type === 'checkbox') return `<label class="ed-check"><input type="checkbox" data-form="${i}" ${val ? 'checked' : ''}> ${esc(f.name)}</label>`;
    return `<div class="ed-field"><label class="ed-label" for="edForm${i}">${esc(f.name)}</label><input type="text" id="edForm${i}" data-form="${i}" value="${esc(val)}"></div>`;
  }).join('');
  const box = openSheet('Formular ausfüllen', `<div class="ed-form">${rows}</div>
    <label class="ed-check"><input type="checkbox" id="edFlatten" ${ed.state.flattenForm !== false ? 'checked' : ''}> Felder fest einbrennen (empfohlen für Paperless)</label>`, {
    foot: '<span class="spacer"></span><button class="btn btn-primary" id="edFormOk">Fertig</button>',
  });
  $('#edFormOk').onclick = () => {
    box.querySelectorAll('[data-form]').forEach((el) => {
      const f = ed.formFields[parseInt(el.dataset.form, 10)];
      ed.state.formValues[f.name] = f.type === 'checkbox' ? el.checked : el.value;
    });
    ed.state.flattenForm = $('#edFlatten').checked;
    closeSheet();
    toast('Formular übernommen – wird beim Übernehmen eingetragen', 'ok', 2500);
  };
}

// ---------------------------------------------------------------- Tastatur

function onKey(e) {
  if (!ed || document.getElementById('editorRoot')?.classList.contains('hidden')) return;
  if (document.querySelector('.dlg-wrap')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (sheetOpen()) closeSheet();
    else if (ed.selected != null) { ed.selected = null; renderPanel(); renderOverlay(); }
    else if (ed.tool !== 'select') setTool('select');
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (typing || sheetOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && ed.selected != null) { e.preventDefault(); deleteSelected(); return; }
  const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (mv && selObj()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (!ed.nudgeSnap) { snapshot('Verschoben'); ed.nudgeSnap = true; clearTimeout(ed.nudgeTimer); }
    ed.nudgeTimer = setTimeout(() => { if (ed) ed.nudgeSnap = false; }, 800);
    selObj().x += mv[0] * step;
    selObj().y += mv[1] * step;
    renderOverlay();
  }
}

// ---------------------------------------------------------------- Öffnen/Schließen

let wired = false;
function wire(root) {
  if (wired) return;
  wired = true;
  root.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#edPagesBtn').addEventListener('click', openPagesSheet);
  $('#edFormBtn').addEventListener('click', openFormSheet);
  $('#edUndoBtn').addEventListener('click', undo);
  $('#edRedoBtn').addEventListener('click', redo);
  $('#edPrev').addEventListener('click', () => { if (ed.pageIdx > 0) { ed.pageIdx--; ed.selected = null; ed.tempRect = null; renderPageView(); renderPanel(); } });
  $('#edNext').addEventListener('click', () => { if (ed.pageIdx < ed.state.pages.length - 1) { ed.pageIdx++; ed.selected = null; ed.tempRect = null; renderPageView(); renderPanel(); } });
  $('#edZoomIn').addEventListener('click', () => zoomTo(ed.zoom * 1.25));
  $('#edZoomOut').addEventListener('click', () => zoomTo(ed.zoom / 1.25));
  $('#edZoomFit').addEventListener('click', () => { ed.pan = { x: 0, y: 0 }; zoomTo(1); });
  $('#edCancel').addEventListener('click', requestCancel);
  $('#edModal').addEventListener('pointerdown', (e) => { if (e.target.id === 'edModal') closeSheet(); });
  $('#edApply').addEventListener('click', async () => {
    const btn = $('#edApply');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Wird übernommen …';
    try {
      const out = await applyEdits(ed.srcBytes, ed.state);
      const done = ed.onApplied;
      closeEditor();
      done?.(out);
    } catch (e) {
      alertDialog('Übernehmen fehlgeschlagen', String(e?.message || e));
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Übernehmen';
    }
  });
  const pick = (id, fn) => $(id).addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) fn(file);
  });
  pick('#edImageInput', onImagePicked);
  pick('#edStampImageInput', onStampImage);
  attachPointerHandlers();
  document.addEventListener('keydown', onKey);
  new ResizeObserver(() => { if (ed && !root.classList.contains('hidden')) { layoutPage(); renderOverlay(); } }).observe($('#edStage'));
}

async function requestCancel() {
  if (ed.undoStack.length || Object.keys(ed.state.formValues).length) {
    const ok = await confirmDialog('Änderungen verwerfen?', 'Alles, was du hier bearbeitet hast, geht verloren.', 'Verwerfen', 'danger');
    if (!ok) return;
  }
  closeEditor();
}

export async function openEditor(item, onApplied) {
  const srcBytes = item.editedBytes ? item.editedBytes.slice() : new Uint8Array(await item.file.arrayBuffer());
  const root = document.getElementById('editorRoot') || buildUi();
  const pdf = await pdfjsLib.getDocument({ data: srcBytes.slice() }).promise;
  const lastStamp = ed?.lastStamp || null;

  ed = {
    item,
    onApplied,
    srcBytes,
    pdf,
    pageIdx: 0,
    zoom: 1,
    pan: { x: 0, y: 0 },
    tool: 'select',
    penColor: '#1b2a80',
    penWidth: 2,
    penMode: 'pen',
    whiteWidth: 16,   // Abdecken: standardmäßig deutlich breiter
    selected: null,
    tempRect: null,
    tempStroke: null,
    undoStack: [],
    redoStack: [],
    renderToken: 0,
    lastStamp,
    pagePt: { w: A4[0], h: A4[1] },
    formFields: [],
    fitScale: () => {
      const stage = $('#edStage');
      return Math.max(0.05, Math.min((stage.clientWidth - 32) / ed.pagePt.w, (stage.clientHeight - 76) / ed.pagePt.h));
    },
    state: {
      pages: Array.from({ length: pdf.numPages }, (_, i) => ({ src: i, objects: [] })),
      formValues: {},
      flattenForm: true,
      assets: { bytes: {}, kind: {}, url: {} },
    },
  };

  // Formularfelder erkennen (pdf-lib)
  try {
    const probe = await window.PDFLib.PDFDocument.load(srcBytes.slice());
    ed.formFields = probe.getForm().getFields().map((f) => {
      const isCheckbox = typeof f.setText !== 'function' && typeof f.check === 'function';
      return { name: f.getName(), type: isCheckbox ? 'checkbox' : 'text', value: isCheckbox ? f.isChecked?.() : (f.getText ? f.getText() : '') };
    });
  } catch { ed.formFields = []; }

  wire(root);
  $('#edFormBtn').classList.toggle('hidden', ed.formFields.length === 0);
  $('#edDocName').textContent = item.file?.name || '';
  syncToolButtons();
  syncHistoryButtons();
  $('#edModal').classList.add('hidden');
  // Jetzt ist alles bereit – erst hier wird der Editor sichtbar.
  root.classList.remove('hidden');
  renderPanel();
  await renderPageView();
  if (ed.formFields.length) toast('Dieses PDF hat Formularfelder – „Formular“ in der Werkzeugleiste', 'info', 4000);
}

function closeEditor() {
  ed?.pdf?.destroy();
  document.getElementById('editorRoot')?.classList.add('hidden');
  $('#edModal')?.classList.add('hidden');
}

// Für Tests
window.__pdfeditor = { applyEdits, processSignatureImage, hasTransparency, strokeToSvgPath, normalizeStrokes, frameStampLayout };
window.__pdfeditorState = () => ed;
