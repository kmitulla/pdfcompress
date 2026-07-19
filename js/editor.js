// PDF-Editor: Unterschrift, Text, Zeichnen/Radieren, Bilder, Seiten,
// Zuschneiden, Formulare. Alle Änderungen werden beim Übernehmen fest ins
// PDF eingebrannt (pdf-lib) – die anschließende Kompression erfasst sie
// dadurch immer mit.

import { processSignatureImage, strokeToSvgPath, normalizeStrokes } from './signature.js';
import { listSignatures, saveSignature, deleteSignature, listStamps, saveStamp, deleteStamp } from './store.js';

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
      const yTop = viewH - o.y;
      page.drawRectangle({ x: o.x, y: yTop - o.h, width: o.w, height: o.h, borderColor: color, borderWidth: 2.2, opacity: 0 });
      const titleSize = Math.min(o.h * 0.42, (o.w - 14) / Math.max(4, o.title.length) / 0.62);
      page.drawText(o.title, { x: o.x + 8, y: yTop - titleSize - 5, size: titleSize, font: fonts.helvB, color });
      let line2 = o.date || '';
      if (o.note) line2 += (line2 ? ' – ' : '') + o.note;
      if (line2) {
        const ns = Math.min(9, o.h * 0.18);
        try { page.drawText(line2, { x: o.x + 8, y: yTop - o.h + 6, size: ns, font: fonts.helv, color }); } catch { /* Zeichen */ }
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
  }
  return newDoc.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- Editor-UI

let ed = null; // aktiver Editor-Zustand

function buildUi() {
  const root = document.createElement('div');
  root.id = 'editorRoot';
  root.innerHTML = `
  <div class="ed-overlay">
    <div class="ed-topbar">
      <div class="ed-tools" role="toolbar">
        <button data-tool="pan" class="ed-btn active" title="Auswählen/Verschieben">✥</button>
        <button data-tool="sign" class="ed-btn" title="Unterschrift">✒️</button>
        <button data-tool="text" class="ed-btn" title="Text">T</button>
        <button data-tool="draw" class="ed-btn" title="Stift">✏️</button>
        <button data-tool="erase" class="ed-btn" title="Radierer (Striche entfernen)">◻️</button>
        <button data-tool="image" class="ed-btn" title="Bild einfügen">🖼️</button>
        <button data-tool="stamp" class="ed-btn" title="Stempel (BEZAHLT/KOPIE …)">🏷️</button>
        <button data-tool="redact" class="ed-btn" title="Schwärzen">⬛</button>
        <button data-tool="crop" class="ed-btn" title="Zuschneiden">⛶</button>
        <button id="edPagesBtn" class="ed-btn" title="Seiten verwalten">🗂️</button>
        <button id="edFormBtn" class="ed-btn hidden" title="Formular ausfüllen">📋</button>
        <button id="edUndoBtn" class="ed-btn" title="Rückgängig">↶</button>
        <button id="edRedoBtn" class="ed-btn" title="Wiederholen">↷</button>
        <button id="edHistBtn" class="ed-btn" title="Verlauf">🕘</button>
        <button id="edDeleteBtn" class="ed-btn hidden" title="Objekt löschen">🗑️</button>
      </div>
      <div class="ed-nav">
        <button id="edPrev" class="ed-btn">‹</button>
        <span id="edPageInfo">1/1</span>
        <button id="edNext" class="ed-btn">›</button>
        <button id="edZoomOut" class="ed-btn">−</button>
        <button id="edZoomIn" class="ed-btn">+</button>
        <button id="edZoomFit" class="ed-btn">Fit</button>
      </div>
      <div class="ed-actions">
        <button id="edCancel" class="btn btn-small btn-ghost">Abbrechen</button>
        <button id="edApply" class="btn btn-small btn-primary">Übernehmen</button>
      </div>
    </div>
    <div class="ed-props hidden" id="edProps"></div>
    <div class="ed-stage" id="edStage">
      <div class="ed-page" id="edPage">
        <canvas id="edCanvas"></canvas>
        <svg id="edSvg" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>
    <div class="ed-modal hidden" id="edModal"><div class="ed-modal-box" id="edModalBox"></div></div>
    <input type="file" id="edImageInput" accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif" hidden>
    <input type="file" id="edSigPhotoInput" accept="image/*,.png,.jpg,.jpeg,.webp,.heic,.heif" hidden>
  </div>`;
  document.body.appendChild(root);
  return root;
}

function snapshot(label = 'Änderung') {
  ed.undoStack.push({ label, json: JSON.stringify(ed.state.pages) });
  if (ed.undoStack.length > 60) ed.undoStack.shift();
  ed.redoStack = [];
  syncHistoryButtons();
}

function restore(json) {
  ed.state.pages = JSON.parse(json);
  if (ed.pageIdx >= ed.state.pages.length) ed.pageIdx = ed.state.pages.length - 1;
  ed.selected = null;
  updateProps();
  renderPageView();
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
  if (u) u.disabled = ed.undoStack.length === 0;
  if (r) r.disabled = ed.redoStack.length === 0;
}

function openHistoryModal() {
  const box = $('#edModalBox');
  const rows = [
    ...ed.undoStack.map((h, i) => `<div class="ed-histrow" data-undo="${ed.undoStack.length - i}">↶ ${h.label}</div>`),
    '<div class="ed-histrow ed-histnow">● Aktueller Stand</div>',
    ...[...ed.redoStack].reverse().map((h, i) => `<div class="ed-histrow" data-redo="${i + 1}">↷ ${h.label}</div>`),
  ].join('');
  box.innerHTML = `<h3>Verlauf</h3><div class="ed-histlist">${rows || '<p>Noch keine Änderungen.</p>'}</div>
    <div class="ed-row"><button class="btn btn-small btn-ghost" id="edHistClose">Schließen</button></div>`;
  $('#edModal').classList.remove('hidden');
  $('#edHistClose').onclick = () => $('#edModal').classList.add('hidden');
  box.querySelectorAll('[data-undo]').forEach((el) => el.addEventListener('click', () => {
    const n = parseInt(el.dataset.undo, 10);
    for (let i = 0; i < n; i++) undo();
    $('#edModal').classList.add('hidden');
  }));
  box.querySelectorAll('[data-redo]').forEach((el) => el.addEventListener('click', () => {
    const n = parseInt(el.dataset.redo, 10);
    for (let i = 0; i < n; i++) redo();
    $('#edModal').classList.add('hidden');
  }));
}

function curPage() {
  return ed.state.pages[ed.pageIdx];
}

// ---------------------------------------------------------------- Seiten-Rendering

async function renderPageView() {
  const entry = curPage();
  const canvas = $('#edCanvas');
  let wPt = A4[0];
  let hPt = A4[1];
  if (entry.src != null) {
    const page = await ed.pdf.getPage(entry.src + 1);
    const totalRot = ((page.rotate || 0) + (entry.rotate || 0)) % 360;
    const base = page.getViewport({ scale: 1, rotation: totalRot });
    // Riesige Pixelmaß-Scans in der Ansicht wie in der Kompression behandeln
    wPt = base.width;
    hPt = base.height;
    const scale = Math.min(3, 1600 / Math.max(wPt, hPt) * (window.devicePixelRatio || 1));
    const viewport = page.getViewport({ scale, rotation: totalRot });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
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
  const cssScale = ed.fitScale();
  const pageEl = $('#edPage');
  pageEl.style.width = `${wPt * cssScale}px`;
  pageEl.style.height = `${hPt * cssScale}px`;
  const svg = $('#edSvg');
  svg.setAttribute('viewBox', `0 0 ${wPt} ${hPt}`);
  $('#edPageInfo').textContent = `${ed.pageIdx + 1}/${ed.state.pages.length}`;
  applyZoom();
  renderOverlay();
}

function applyZoom() {
  const stagePage = $('#edPage');
  stagePage.style.transform = `translate(${ed.pan.x}px, ${ed.pan.y}px) scale(${ed.zoom})`;
}

function renderOverlay() {
  const svg = $('#edSvg');
  const entry = curPage();
  const parts = [];
  for (let i = 0; i < entry.objects.length; i++) {
    const o = entry.objects[i];
    const sel = ed.selected === i;
    if (o.type === 'text') {
      const lines = o.text.split('\n');
      const tspans = lines.map((ln, li) => `<tspan x="${o.x}" dy="${li === 0 ? o.size * 0.95 : o.size * 1.25}">${ln.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</tspan>`).join('');
      parts.push(`<text data-i="${i}" x="${o.x}" y="${o.y}" font-size="${o.size}" fill="${o.color}" font-family="${o.font === 'times' ? 'Times New Roman,serif' : o.font === 'courier' ? 'monospace' : 'Helvetica,Arial,sans-serif'}">${tspans}</text>`);
      if (sel) parts.push(selBox(o.x - 2, o.y - 2, textWidth(o) + 6, textHeight(o) + 4, i));
    } else if (o.type === 'image' || o.type === 'sig-image') {
      parts.push(`<image data-i="${i}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${ed.state.assets.url[o.assetId]}" preserveAspectRatio="none"/>`);
      if (sel) parts.push(selBox(o.x, o.y, o.w, o.h, i));
    } else if (o.type === 'sig-vector') {
      const d = o.strokes.map((st) => strokeToSvgPath(st.map((p) => ({ x: o.x + p.x * o.w, y: o.y + p.y * o.h })))).join(' ');
      parts.push(`<path data-i="${i}" d="${d}" fill="none" stroke="${o.color}" stroke-width="${Math.max(0.4, o.widthN * o.h)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      if (sel) parts.push(selBox(o.x, o.y, o.w, o.h, i));
    } else if (o.type === 'rect') {
      parts.push(`<rect data-i="${i}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.color}"/>`);
      if (sel) parts.push(selBox(o.x, o.y, o.w, o.h, i));
    } else if (o.type === 'stamp' && o.style && o.style !== 'frame') {
      parts.push(`<image data-i="${i}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${renderStampCanvas(o, 3).toDataURL('image/png')}" preserveAspectRatio="none"/>`);
      if (sel) parts.push(selBox(o.x, o.y, o.w, o.h, i));
    } else if (o.type === 'stamp') {
      const ts = Math.min(o.h * 0.42, (o.w - 14) / Math.max(4, o.title.length) / 0.62);
      let line2 = o.date || '';
      if (o.note) line2 += (line2 ? ' – ' : '') + o.note;
      parts.push(`<g data-i="${i}"><rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="none" stroke="${o.color}" stroke-width="2.2" rx="4"/>
        <text x="${o.x + 8}" y="${o.y + ts + 4}" font-size="${ts}" font-weight="bold" fill="${o.color}" font-family="Helvetica,Arial,sans-serif">${o.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
        ${line2 ? `<text x="${o.x + 8}" y="${o.y + o.h - 6}" font-size="${Math.min(9, o.h * 0.18)}" fill="${o.color}" font-family="Helvetica,Arial,sans-serif">${line2.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>` : ''}</g>`);
      if (sel) parts.push(selBox(o.x, o.y, o.w, o.h, i));
    } else if (o.type === 'ink') {
      const d = o.paths.map((st) => strokeToSvgPath(st)).join(' ');
      parts.push(`<path data-i="${i}" d="${d}" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-opacity="${o.opacity ?? 1}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  if (entry.crop) {
    const c = entry.crop;
    const { w, h } = ed.pagePt;
    parts.push(`<path d="M0 0H${w}V${h}H0Z M${c.x} ${c.y}h${c.w}v${c.h}h${-c.w}Z" fill="rgba(15,23,42,0.55)" fill-rule="evenodd"/><rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="6 4"/>`);
  }
  if (ed.tempRect) {
    const r = ed.tempRect;
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="rgba(56,189,248,0.15)" stroke="#38bdf8" stroke-width="1"/>`);
  }
  if (ed.tempStroke) {
    parts.push(`<path d="${strokeToSvgPath(ed.tempStroke)}" fill="none" stroke="${ed.penColor}" stroke-width="${ed.penWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  svg.innerHTML = parts.join('');
  $('#edDeleteBtn').classList.toggle('hidden', ed.selected == null);
}

function selBox(x, y, w, h, i) {
  const u = 1 / (ed.zoom * ed.fitScale());
  const hs = 16 * u;   // sichtbarer Griff
  const hit = 44 * u;  // Trefferfläche (ergonomisch groß)
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#0ea5e9" stroke-width="${2 * u}" stroke-dasharray="5 4"/>
    <circle data-del="${i}" cx="${x}" cy="${y}" r="${11 * u}" fill="#ef4444"/>
    <path d="M ${x - 4.5 * u} ${y - 4.5 * u} l ${9 * u} ${9 * u} M ${x + 4.5 * u} ${y - 4.5 * u} l ${-9 * u} ${9 * u}" stroke="#fff" stroke-width="${2.2 * u}"/>
    <circle data-del="${i}" cx="${x}" cy="${y}" r="${hit / 2}" fill="transparent"/>
    <rect data-handle="${i}" x="${x + w - hs / 2}" y="${y + h - hs / 2}" width="${hs}" height="${hs}" rx="${3 * u}" fill="#0ea5e9" stroke="#fff" stroke-width="${1.5 * u}"/>
    <rect data-handle="${i}" x="${x + w - hit / 2}" y="${y + h - hit / 2}" width="${hit}" height="${hit}" fill="transparent"/></g>`;
}

function textWidth(o) {
  return Math.max(...o.text.split('\n').map((l) => l.length)) * o.size * 0.55;
}
function textHeight(o) {
  return o.text.split('\n').length * o.size * 1.25;
}

// ---------------------------------------------------------------- Eingaben

function toPagePt(ev) {
  const rect = $('#edSvg').getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * ed.pagePt.w,
    y: ((ev.clientY - rect.top) / rect.height) * ed.pagePt.h,
  };
}

function hitObject(pt) {
  const objs = curPage().objects;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    let box = null;
    if (o.type === 'text') box = { x: o.x - 2, y: o.y - 2, w: textWidth(o) + 6, h: textHeight(o) + 4 };
    else if (o.type === 'image' || o.type === 'sig-image' || o.type === 'sig-vector') box = { x: o.x, y: o.y, w: o.w, h: o.h };
    if (o.type === 'rect' || o.type === 'stamp') box = { x: o.x, y: o.y, w: o.w, h: o.h };
    const pad = 12 / (ed.zoom * ed.fitScale()) * 4 + 6; // großzügige Trefferzone
    if (box && pt.x >= box.x - pad && pt.x <= box.x + box.w + pad && pt.y >= box.y - pad && pt.y <= box.y + box.h + pad) return i;
  }
  return null;
}

function setTool(tool) {
  ed.tool = tool;
  document.querySelectorAll('.ed-tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  ed.selected = null;
  updateProps();
  renderOverlay();
  if (tool === 'sign') openSignModal();
  if (tool === 'image') $('#edImageInput').click();
}

function updateProps() {
  const props = $('#edProps');
  const o = ed.selected != null ? curPage().objects[ed.selected] : null;
  if (ed.tool === 'draw') {
    props.innerHTML = `Stift: <input type="color" id="edPenColor" value="${ed.penColor}">
      Breite <input type="range" id="edPenWidth" min="0.5" max="8" step="0.5" value="${ed.penWidth}">
      <label><input type="checkbox" id="edMarker" ${ed.marker ? 'checked' : ''}> Marker (transparent)</label>`;
    props.classList.remove('hidden');
    $('#edPenColor').oninput = (e) => { ed.penColor = e.target.value; };
    $('#edPenWidth').oninput = (e) => { ed.penWidth = parseFloat(e.target.value); };
    $('#edMarker').onchange = (e) => { ed.marker = e.target.checked; };
  } else if (o && o.type === 'text') {
    props.innerHTML = `<textarea id="edTextInput" rows="2">${o.text}</textarea>
      Größe <input type="range" id="edTextSize" min="6" max="60" step="1" value="${o.size}">
      <input type="color" id="edTextColor" value="${o.color}">
      <select id="edTextFont"><option value="helv">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></select>`;
    props.classList.remove('hidden');
    $('#edTextFont').value = o.font || 'helv';
    $('#edTextInput').oninput = (e) => { o.text = e.target.value || ' '; renderOverlay(); };
    $('#edTextSize').oninput = (e) => { o.size = parseInt(e.target.value, 10); renderOverlay(); };
    $('#edTextColor').oninput = (e) => { o.color = e.target.value; renderOverlay(); };
    $('#edTextFont').onchange = (e) => { o.font = e.target.value; renderOverlay(); };
  } else if (o && o.type === 'stamp') {
    props.innerHTML = `Stempel:
      <select id="edStampTitle"><option>BEZAHLT</option><option>KOPIE</option><option>ERLEDIGT</option><option>ENTWURF</option><option>GEPRÜFT</option><option>ERHALTEN</option><option value="__custom">Eigener…</option></select>
      <input type="text" id="edStampCustom" class="hidden" size="10" placeholder="Eigener Text">
      Datum <input type="text" id="edStampDate" value="${o.date || ''}" size="9">
      Notiz <input type="text" id="edStampNote" value="${(o.note || '').replace(/"/g, '&quot;')}" size="16" placeholder="z. B. per Überweisung">
      Name/Firma <input type="text" id="edStampBrand" value="${(o.brand || '').replace(/"/g, '&quot;')}" size="12" placeholder="z. B. Peter Müller">
      Stil <select id="edStampStyle"><option value="frame">Einfach</option><option value="stamp">Stempel</option><option value="round">Stempel rund</option></select>
      <input type="color" id="edStampColor" value="${o.color}">
      <button class="btn btn-small" id="edStampSaveTpl">Als Vorlage speichern</button>
      <button class="btn btn-small btn-ghost" id="edStampTpls">Vorlagen…</button>`;
    props.classList.remove('hidden');
    const sel = $('#edStampTitle');
    if ([...sel.options].some((op) => op.value === o.title)) sel.value = o.title;
    else { sel.value = '__custom'; $('#edStampCustom').classList.remove('hidden'); $('#edStampCustom').value = o.title; }
    const syncTitle = () => {
      const custom = sel.value === '__custom';
      $('#edStampCustom').classList.toggle('hidden', !custom);
      o.title = custom ? ($('#edStampCustom').value || 'STEMPEL') : sel.value;
      renderOverlay();
    };
    sel.onchange = syncTitle;
    $('#edStampCustom').oninput = syncTitle;
    $('#edStampDate').oninput = (e) => { o.date = e.target.value; renderOverlay(); };
    $('#edStampNote').oninput = (e) => { o.note = e.target.value; renderOverlay(); };
    $('#edStampColor').oninput = (e) => { o.color = e.target.value; renderOverlay(); };
    $('#edStampStyle').value = o.style || 'frame';
    $('#edStampStyle').onchange = (e) => { o.style = e.target.value; renderOverlay(); };
    $('#edStampBrand').oninput = (e) => { o.brand = e.target.value; renderOverlay(); };
    $('#edStampSaveTpl').onclick = async () => {
      await saveStamp({ kind: 'text', title: o.title, brand: o.brand || '', note: o.note || '', color: o.color, style: o.style || 'frame', dateAuto: true });
      $('#edStampSaveTpl').textContent = 'Gespeichert ✓';
      setTimeout(() => { $('#edStampSaveTpl').textContent = 'Als Vorlage speichern'; }, 1500);
    };
    $('#edStampTpls').onclick = openStampTplModal;
  } else if (o && (o.type === 'image' || o.type === 'sig-image' || o.type === 'rect')) {
    props.innerHTML = `<label><input type="checkbox" id="edAspect" ${ed.aspectLock ? 'checked' : ''}> Seitenverhältnis sperren</label>
      ${o.type === 'rect' ? '<span class="hint-inline">Schwärzung: Für ECHTES Entfernen danach mit einer Bild-Stufe komprimieren (nicht „Verlustfrei“).</span>' : ''}`;
    props.classList.remove('hidden');
    $('#edAspect').onchange = (e) => { ed.aspectLock = e.target.checked; };
  } else if (ed.tool === 'redact') {
    props.innerHTML = '<span class="hint-inline">Rechteck über den Inhalt ziehen. Wichtig: ECHT entfernt ist der Inhalt nach Kompression mit einer Bild-Stufe (z. B. Mittel oder Extrem S/W) – „Verlustfrei“ deckt nur ab.</span>';
    props.classList.remove('hidden');
  } else if (ed.tool === 'crop') {
    props.innerHTML = `Rechteck aufziehen, dann: <button class="btn btn-small" id="edCropApply">Zuschnitt setzen</button>
      <button class="btn btn-small btn-ghost" id="edCropClear">Zuschnitt entfernen</button>
      <button class="btn btn-small btn-ghost" id="edFormatA4">Format: auf A4 skalieren</button>`;
    props.classList.remove('hidden');
    $('#edCropApply').onclick = () => {
      if (ed.tempRect && ed.tempRect.w > 8 && ed.tempRect.h > 8) {
        snapshot('Zugeschnitten');
        curPage().crop = { ...ed.tempRect };
        ed.tempRect = null;
        renderOverlay();
      }
    };
    $('#edCropClear').onclick = () => { snapshot(); delete curPage().crop; ed.tempRect = null; renderOverlay(); };
    $('#edFormatA4').onclick = () => { snapshot(); curPage().resizeTo = A4.slice(); alert('Seite wird beim Übernehmen auf A4 skaliert.'); };
  } else {
    props.classList.add('hidden');
    props.innerHTML = '';
  }
}

function attachPointerHandlers() {
  const stage = $('#edStage');
  const pointers = new Map();
  let pinchStart = null;
  let dragging = null;

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: ed.zoom, pan: { ...ed.pan }, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      dragging = null;
      ed.tempStroke = null;
      return;
    }
    const pt = toPagePt(e);
    if (ed.tool === 'pan') {
      const delBadge = e.target.closest?.('[data-del]');
      if (delBadge) {
        snapshot('Objekt gelöscht');
        curPage().objects.splice(parseInt(delBadge.dataset.del, 10), 1);
        ed.selected = null;
        updateProps();
        renderOverlay();
        return;
      }
      const handle = e.target.closest?.('[data-handle]');
      if (handle) {
        dragging = { kind: 'resize', i: parseInt(handle.dataset.handle, 10), start: pt };
        snapshot('Größe geändert');
        return;
      }
      const hit = hitObject(pt);
      if (hit != null) {
        ed.selected = hit;
        const o = curPage().objects[hit];
        dragging = { kind: 'move', i: hit, start: pt, orig: { x: o.x, y: o.y } };
        snapshot('Objekt verschoben');
        updateProps();
        renderOverlay();
      } else {
        ed.selected = null;
        dragging = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, pan: { ...ed.pan } };
        updateProps();
        renderOverlay();
      }
    } else if (ed.tool === 'draw') {
      snapshot('Stift-Strich');
      ed.tempStroke = [pt];
      dragging = { kind: 'draw' };
    } else if (ed.tool === 'erase') {
      snapshot('Radiert');
      eraseAt(pt);
      dragging = { kind: 'erase' };
    } else if (ed.tool === 'text') {
      snapshot('Text eingefügt');
      curPage().objects.push({ type: 'text', x: pt.x, y: pt.y, size: 14, color: '#111111', font: 'helv', text: 'Text' });
      ed.selected = curPage().objects.length - 1;
      setToolSoft('pan');
      updateProps();
      renderOverlay();
    } else if (ed.tool === 'crop') {
      dragging = { kind: 'rect', start: pt };
      ed.tempRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
    } else if (ed.tool === 'redact') {
      const handle = e.target.closest?.('[data-handle]');
      if (handle) {
        dragging = { kind: 'resize', i: parseInt(handle.dataset.handle, 10), start: pt };
        snapshot('Schwärzung skaliert');
        return;
      }
      const hit = hitObject(pt);
      if (hit != null && curPage().objects[hit].type === 'rect') {
        ed.selected = hit;
        const ro = curPage().objects[hit];
        dragging = { kind: 'move', i: hit, start: pt, orig: { x: ro.x, y: ro.y } };
        snapshot('Schwärzung verschoben');
        updateProps();
        renderOverlay();
        return;
      }
      ed.selected = null;
      dragging = { kind: 'redact', start: pt };
      ed.tempRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
    } else if (ed.tool === 'stamp') {
      snapshot('Stempel eingefügt');
      const heute = new Date().toLocaleDateString('de-DE');
      curPage().objects.push({ type: 'stamp', x: pt.x - 85, y: pt.y - 28, w: 170, h: 56, color: '#c00000', title: 'BEZAHLT', date: heute, note: '' });
      ed.selected = curPage().objects.length - 1;
      setToolSoft('pan');
      updateProps();
      renderOverlay();
    } else if (ed.tool === 'place') {
      placePending(pt);
      dragging = null;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = dist / pinchStart.dist;
      ed.zoom = Math.min(8, Math.max(0.4, pinchStart.zoom * factor));
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
    if (dragging.kind === 'pan') {
      ed.pan = { x: dragging.pan.x + e.clientX - dragging.start.x, y: dragging.pan.y + e.clientY - dragging.start.y };
      applyZoom();
    } else if (dragging.kind === 'move') {
      const o = curPage().objects[dragging.i];
      o.x = dragging.orig.x + pt.x - dragging.start.x;
      o.y = dragging.orig.y + pt.y - dragging.start.y;
      renderOverlay();
    } else if (dragging.kind === 'resize') {
      const o = curPage().objects[dragging.i];
      if (o.type === 'text') {
        o.size = Math.max(6, Math.min(80, ((pt.y - o.y) / 1.25)));
      } else if ((o.type === 'image' || o.type === 'rect' || o.type === 'stamp') && !ed.aspectLock) {
        o.w = Math.max(12, pt.x - o.x);
        o.h = Math.max(12, pt.y - o.y);
      } else {
        const ratio = o.h / o.w;
        o.w = Math.max(12, Math.max(pt.x - o.x, (pt.y - o.y) / ratio));
        o.h = o.w * ratio;
      }
      renderOverlay();
    } else if (dragging.kind === 'draw') {
      ed.tempStroke.push(pt);
      renderOverlay();
    } else if (dragging.kind === 'erase') {
      eraseAt(pt);
    } else if (dragging.kind === 'rect' || dragging.kind === 'redact') {
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
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (dragging?.kind === 'redact' && ed.tempRect) {
      if (ed.tempRect.w > 4 && ed.tempRect.h > 4) {
        snapshot('Schwärzung hinzugefügt');
        curPage().objects.push({ type: 'rect', color: '#000000', ...ed.tempRect });
        ed.selected = curPage().objects.length - 1;
        updateProps();
      }
      ed.tempRect = null;
      renderOverlay();
    }
    if (dragging?.kind === 'draw' && ed.tempStroke?.length) {
      const objs = curPage().objects;
      const last = objs[objs.length - 1];
      const stroke = ed.tempStroke;
      ed.tempStroke = null;
      if (last && last.type === 'ink' && last.color === ed.penColor && last.width === ed.penWidth && (last.opacity ?? 1) === (ed.marker ? 0.45 : 1)) {
        last.paths.push(stroke);
      } else {
        objs.push({ type: 'ink', color: ed.penColor, width: ed.penWidth, opacity: ed.marker ? 0.45 : 1, paths: [stroke] });
      }
      renderOverlay();
    }
    dragging = null;
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 0.88 : 1.14;
    ed.zoom = Math.min(8, Math.max(0.4, ed.zoom * dir));
    applyZoom();
  }, { passive: false });
}

function setToolSoft(tool) {
  ed.tool = tool;
  document.querySelectorAll('.ed-tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
}

function eraseAt(pt) {
  const objs = curPage().objects;
  const r = 8;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type !== 'ink') continue;
    o.paths = o.paths.filter((stroke) => !stroke.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < r + o.width));
    if (o.paths.length === 0) objs.splice(i, 1);
  }
  renderOverlay();
}

// Ein vorbereitetes Objekt (Unterschrift) mit Tipp platzieren
function placePending(pt) {
  if (!ed.pending) return;
  snapshot('Eingefügt/platziert');
  const o = { ...ed.pending, x: pt.x - ed.pending.w / 2, y: pt.y - ed.pending.h / 2 };
  curPage().objects.push(o);
  ed.pending = null;
  ed.selected = curPage().objects.length - 1;
  setToolSoft('pan');
  updateProps();
  renderOverlay();
}


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

// ---------------------------------------------------------------- Unterschrift

async function openSignModal() {
  const modal = $('#edModal');
  const box = $('#edModalBox');
  const saved = await listSignatures();
  box.innerHTML = `
    <h3>Unterschrift</h3>
    <div class="ed-tabs">
      <button class="ed-tab active" data-tab="drawTab">Zeichnen</button>
      <button class="ed-tab" data-tab="photoTab">Foto/Bild</button>
      <button class="ed-tab" data-tab="savedTab">Gespeicherte (${saved.length})</button>
    </div>
    <div id="drawTab" class="ed-tabpane">
      <canvas id="sigPad" width="900" height="300"></canvas>
      <div class="ed-row">Farbe <input type="color" id="sigColor" value="#1b2a80">
        Stift <input type="range" id="sigWidth" min="1.5" max="7" step="0.5" value="3.5">
        <button class="btn btn-small btn-ghost" id="sigClear">Leeren</button></div>
      <div class="ed-row"><label><input type="checkbox" id="sigSave" checked> Unterschrift speichern als</label>
        <input type="text" id="sigName" value="Meine Unterschrift" size="14"></div>
      <div class="ed-row"><button class="btn btn-small btn-primary" id="sigUseDrawn">Einfügen</button></div>
    </div>
    <div id="photoTab" class="ed-tabpane hidden">
      <div class="ed-row"><button class="btn btn-small" id="sigPhotoPick">📷 Foto/Bild wählen</button>
        <span class="hint-inline">Fertig freigestellte PNGs (transparent) werden direkt übernommen.</span></div>
      <canvas id="sigPhotoPreview" class="hidden"></canvas>
      <div class="ed-row hidden" id="sigPhotoCtrls">
        Schwellwert <input type="range" id="sigThr" min="0" max="100" value="50">
        Helligkeit <input type="range" id="sigBright" min="-100" max="100" value="0">
        Kontrast <input type="range" id="sigContrast" min="-100" max="100" value="0">
        Farbe <select id="sigPhotoColor"><option value="#000000">Schwarz</option><option value="#1b2a80">Blau</option><option value="original">Original</option><option value="custom">Eigene…</option></select>
        <input type="color" id="sigPhotoCustom" value="#0a7a35" class="hidden">
        <label><input type="checkbox" id="sigPhotoSave" checked> speichern als</label>
        <input type="text" id="sigPhotoName" value="Unterschrift (Foto)" size="12">
        <button class="btn btn-small btn-primary" id="sigUsePhoto">Einfügen</button>
      </div>
    </div>
    <div id="savedTab" class="ed-tabpane hidden"><div id="sigSavedList" class="ed-savedlist"></div></div>
    <div class="ed-row"><button class="btn btn-small btn-ghost" id="sigCancel">Schließen</button></div>`;
  modal.classList.remove('hidden');

  box.querySelectorAll('.ed-tab').forEach((t) => t.addEventListener('click', () => {
    box.querySelectorAll('.ed-tab').forEach((x) => x.classList.toggle('active', x === t));
    box.querySelectorAll('.ed-tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== t.dataset.tab));
  }));
  $('#sigCancel').onclick = closeSignModal;

  // --- Zeichnen
  const pad = $('#sigPad');
  const pctx = pad.getContext('2d');
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, pad.width, pad.height);
  drawBaseline();
  function drawBaseline() {
    pctx.strokeStyle = '#dbe3ee';
    pctx.setLineDash([6, 6]);
    pctx.beginPath();
    pctx.moveTo(40, pad.height * 0.72);
    pctx.lineTo(pad.width - 40, pad.height * 0.72);
    pctx.stroke();
    pctx.setLineDash([]);
  }
  let strokes = [];
  let cur = null;
  const padPt = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
  };
  const repaint = () => {
    pctx.fillStyle = '#fff';
    pctx.fillRect(0, 0, pad.width, pad.height);
    drawBaseline();
    pctx.strokeStyle = $('#sigColor').value;
    pctx.lineWidth = parseFloat($('#sigWidth').value) * 2.2;
    pctx.lineCap = 'round';
    pctx.lineJoin = 'round';
    for (const st of strokes.concat(cur ? [cur] : [])) {
      pctx.stroke(new Path2D(strokeToSvgPath(st)));
    }
  };
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); cur = [padPt(e)]; });
  pad.addEventListener('pointermove', (e) => { if (cur) { cur.push(padPt(e)); repaint(); } });
  const padUp = () => { if (cur && cur.length > 1) strokes.push(cur); cur = null; repaint(); };
  pad.addEventListener('pointerup', padUp);
  pad.addEventListener('pointercancel', padUp);
  $('#sigClear').onclick = () => { strokes = []; cur = null; repaint(); };
  $('#sigColor').oninput = repaint;
  $('#sigWidth').oninput = repaint;

  $('#sigUseDrawn').onclick = async () => {
    if (!strokes.length) return;
    const { aspect, strokes: norm } = normalizeStrokes(strokes);
    const widthN = (parseFloat($('#sigWidth').value) * 2.2) / (300 * Math.min(1, aspect >= 1 ? 1 : aspect));
    const sig = { kind: 'vector', name: $('#sigName').value || 'Unterschrift', strokes: norm, aspect, color: $('#sigColor').value, widthN };
    if ($('#sigSave').checked) await saveSignature({ ...sig });
    insertSignature(sig);
  };

  // --- Foto
  let photoBitmap = null;
  let processed = null;
  $('#sigPhotoPick').onclick = () => $('#edSigPhotoInput').click();
  $('#edSigPhotoInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    photoBitmap = await loadBitmap(file);
    $('#sigPhotoCtrls').classList.remove('hidden');
    $('#sigPhotoPreview').classList.remove('hidden');
    updatePhoto();
  };
  const updatePhoto = () => {
    if (!photoBitmap) return;
    let color = $('#sigPhotoColor').value;
    $('#sigPhotoCustom').classList.toggle('hidden', color !== 'custom');
    if (color === 'custom') color = $('#sigPhotoCustom').value;
    processed = processSignatureImage(photoBitmap, {
      threshold: parseInt($('#sigThr').value, 10),
      brightness: parseInt($('#sigBright').value, 10),
      contrast: parseInt($('#sigContrast').value, 10),
      color,
    });
    const prev = $('#sigPhotoPreview');
    prev.width = processed.width;
    prev.height = processed.height;
    const pc = prev.getContext('2d');
    pc.clearRect(0, 0, prev.width, prev.height);
    pc.drawImage(processed, 0, 0);
  };
  ['sigThr', 'sigBright', 'sigContrast', 'sigPhotoColor', 'sigPhotoCustom'].forEach((id) => { $(`#${id}`).oninput = updatePhoto; });
  $('#sigUsePhoto').onclick = async () => {
    if (!processed) return;
    const dataUrl = processed.toDataURL('image/png');
    if (ed.stampFromImage) {
      ed.stampFromImage = false;
      const stamp = { kind: 'image', name: $('#sigPhotoName').value || 'Bild-Stempel', dataUrl, aspect: processed.width / processed.height };
      if ($('#sigPhotoSave').checked) await saveStamp({ ...stamp });
      const assetId = addAssetFromDataUrl(dataUrl, 'png');
      ed.pending = { type: 'image', assetId, w: 160, h: 160 / stamp.aspect };
      closeSignModal();
      ed.tool = 'place';
      alert('Tippe/Klicke an die Stelle für den Stempel.');
      return;
    }
    const sig = { kind: 'image', name: $('#sigPhotoName').value || 'Unterschrift', dataUrl, aspect: processed.width / processed.height };
    if ($('#sigPhotoSave').checked) await saveSignature({ ...sig });
    insertSignature(sig);
  };

  // --- Gespeicherte
  const listEl = $('#sigSavedList');
  const renderSaved = async () => {
    const sigs = await listSignatures();
    box.querySelector('[data-tab="savedTab"]').textContent = `Gespeicherte (${sigs.length})`;
    listEl.innerHTML = sigs.length ? '' : '<p>Noch keine gespeicherten Unterschriften.</p>';
    for (const sig of sigs) {
      const row = document.createElement('div');
      row.className = 'ed-savedrow';
      const preview = document.createElement(sig.kind === 'image' ? 'img' : 'canvas');
      if (sig.kind === 'image') {
        preview.src = sig.dataUrl;
      } else {
        preview.width = 160;
        preview.height = Math.max(24, Math.round(160 / sig.aspect));
        const c = preview.getContext('2d');
        c.strokeStyle = sig.color;
        c.lineWidth = 2;
        c.lineCap = 'round';
        for (const st of sig.strokes) {
          c.stroke(new Path2D(strokeToSvgPath(st.map((p) => ({ x: p.x * 160, y: p.y * (160 / sig.aspect) })))));
        }
      }
      const name = document.createElement('span');
      name.textContent = sig.name;
      const use = document.createElement('button');
      use.className = 'btn btn-small btn-primary';
      use.textContent = 'Einfügen';
      use.onclick = () => insertSignature(sig);
      const del = document.createElement('button');
      del.className = 'btn btn-small btn-ghost';
      del.textContent = '🗑';
      del.onclick = async () => { await deleteSignature(sig.id); renderSaved(); };
      row.append(preview, name, use, del);
      listEl.appendChild(row);
    }
  };
  renderSaved();
}

function closeSignModal() {
  $('#edModal').classList.add('hidden');
  if (ed.tool === 'sign' && !ed.pending) setToolSoft('pan');
}

function insertSignature(sig) {
  const w = Math.min(180, ed.pagePt.w * 0.4);
  const h = w / (sig.aspect || 3);
  if (sig.kind === 'image') {
    const assetId = addAssetFromDataUrl(sig.dataUrl, 'png');
    ed.pending = { type: 'sig-image', assetId, w, h, color: '#000000' };
  } else {
    ed.pending = { type: 'sig-vector', strokes: sig.strokes, w, h, color: sig.color, widthN: sig.widthN || 0.02 };
  }
  closeSignModal();
  ed.tool = 'place';
  alert('Tippe/Klicke an die Stelle, an der die Unterschrift stehen soll. Danach kannst du sie verschieben und in der Größe ändern.');
}

function addAssetFromDataUrl(dataUrl, kind) {
  const id = `a${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  ed.state.assets.bytes[id] = bytes;
  ed.state.assets.kind[id] = kind;
  ed.state.assets.url[id] = dataUrl;
  return id;
}


async function openStampTplModal() {
  const box = $('#edModalBox');
  const stamps = await listStamps();
  box.innerHTML = `<h3>Stempel-Vorlagen</h3><div class="ed-savedlist" id="edTplList">${stamps.length ? '' : '<p>Noch keine Vorlagen gespeichert.</p>'}</div>
    <div class="ed-row"><button class="btn btn-small" id="edStampFromImg">🖼️ Stempel aus Bild erstellen</button>
    <button class="btn btn-small btn-ghost" id="edTplClose">Schließen</button></div>`;
  $('#edModal').classList.remove('hidden');
  $('#edTplClose').onclick = () => $('#edModal').classList.add('hidden');
  $('#edStampFromImg').onclick = async () => {
    ed.stampFromImage = true;
    await openSignModal();
    $('#edModalBox').querySelector('[data-tab="photoTab"]').click();
    $('#edSigPhotoInput').click();
  };
  const list = $('#edTplList');
  for (const st of stamps) {
    const row = document.createElement('div');
    row.className = 'ed-savedrow';
    const prev = document.createElement(st.kind === 'image' ? 'img' : 'canvas');
    if (st.kind === 'image') prev.src = st.dataUrl;
    else {
      const tmp = renderStampCanvas({ ...st, w: 170, h: 56, date: st.dateAuto ? new Date().toLocaleDateString('de-DE') : '', style: st.style === 'frame' ? 'stamp' : st.style }, 2);
      prev.width = tmp.width; prev.height = tmp.height;
      prev.getContext('2d').drawImage(tmp, 0, 0);
    }
    const name = document.createElement('span');
    name.textContent = st.kind === 'image' ? (st.name || 'Bild-Stempel') : `${st.brand ? st.brand + ' – ' : ''}${st.title}`;
    const use = document.createElement('button');
    use.className = 'btn btn-small btn-primary';
    use.textContent = 'Einfügen';
    use.onclick = () => {
      $('#edModal').classList.add('hidden');
      if (st.kind === 'image') {
        const assetId = addAssetFromDataUrl(st.dataUrl, 'png');
        ed.pending = { type: 'image', assetId, w: 160, h: 160 / (st.aspect || 2.5) };
      } else {
        ed.pending = { type: 'stamp', w: 170, h: 56, color: st.color, title: st.title, brand: st.brand || '',
          note: st.note || '', style: st.style || 'stamp', date: st.dateAuto ? new Date().toLocaleDateString('de-DE') : '' };
      }
      ed.tool = 'place';
      alert('Tippe/Klicke an die Stelle für den Stempel.');
    };
    const del = document.createElement('button');
    del.className = 'btn btn-small btn-ghost';
    del.textContent = '🗑';
    del.onclick = async () => { await deleteStamp(st.id); openStampTplModal(); };
    row.append(prev, name, use, del);
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------- Seitenverwaltung

async function openPagesModal() {
  const modal = $('#edModal');
  const box = $('#edModalBox');
  box.innerHTML = '<h3>Seiten verwalten</h3><div class="ed-pagegrid" id="edPageGrid"></div><div class="ed-row"><button class="btn btn-small" id="edAddBlank">+ Leere A4-Seite</button><button class="btn btn-small" id="edPageNums">Seitenzahlen: aus</button><button class="btn btn-small btn-ghost" id="edPagesClose">Fertig</button></div>';
  modal.classList.remove('hidden');
  $('#edPagesClose').onclick = () => { modal.classList.add('hidden'); renderPageView(); };
  $('#edAddBlank').onclick = () => { snapshot(); ed.state.pages.push({ src: null, blankSize: A4.slice(), objects: [] }); renderGrid(); };
  const pnBtn = $('#edPageNums');
  const syncPn = () => { pnBtn.textContent = `Seitenzahlen: ${ed.state.pageNumbers ? 'AN' : 'aus'}`; };
  syncPn();
  pnBtn.onclick = () => { ed.state.pageNumbers = !ed.state.pageNumbers; syncPn(); };
  const renderGrid = async () => {
    const grid = $('#edPageGrid');
    grid.innerHTML = '';
    for (let i = 0; i < ed.state.pages.length; i++) {
      const entry = ed.state.pages[i];
      const cell = document.createElement('div');
      cell.className = 'ed-pagecell';
      const thumb = document.createElement('canvas');
      thumb.width = 100;
      thumb.height = 141;
      const tctx = thumb.getContext('2d');
      tctx.fillStyle = '#fff';
      tctx.fillRect(0, 0, 100, 141);
      if (entry.src != null) {
        const page = await ed.pdf.getPage(entry.src + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const sc = Math.min(100 / vp1.width, 141 / vp1.height);
        const vp = page.getViewport({ scale: sc });
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(vp.width));
        off.height = Math.max(1, Math.round(vp.height));
        await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
        tctx.drawImage(off, (100 - off.width) / 2, (141 - off.height) / 2);
      }
      const bar = document.createElement('div');
      bar.className = 'ed-pagecell-bar';
      const mk = (label, fn, disabled) => {
        const b = document.createElement('button');
        b.className = 'btn btn-small';
        b.textContent = label;
        b.disabled = !!disabled;
        b.onclick = () => { snapshot(); fn(); renderGrid(); };
        return b;
      };
      bar.append(
        mk('↻', () => { entry.rotate = ((entry.rotate || 0) + 90) % 360; }),
        mk('←', () => { [ed.state.pages[i - 1], ed.state.pages[i]] = [ed.state.pages[i], ed.state.pages[i - 1]]; }, i === 0),
        mk('→', () => { [ed.state.pages[i + 1], ed.state.pages[i]] = [ed.state.pages[i], ed.state.pages[i + 1]]; }, i === ed.state.pages.length - 1),
        mk('⧉', () => { ed.state.pages.splice(i + 1, 0, JSON.parse(JSON.stringify(entry))); }),
        mk('🗑', () => { ed.state.pages.splice(i, 1); if (ed.pageIdx >= ed.state.pages.length) ed.pageIdx = ed.state.pages.length - 1; }, ed.state.pages.length <= 1),
      );
      const label = document.createElement('div');
      label.textContent = `Seite ${i + 1}${entry.src == null ? ' (leer)' : ''}${entry.rotate ? ` ↻${entry.rotate}°` : ''}`;
      cell.append(thumb, label, bar);
      grid.appendChild(cell);
    }
  };
  renderGrid();
}

// ---------------------------------------------------------------- Formular

async function openFormModal() {
  const modal = $('#edModal');
  const box = $('#edModalBox');
  const rows = ed.formFields.map((f, i) => {
    const val = ed.state.formValues[f.name] ?? f.value ?? '';
    if (f.type === 'checkbox') {
      return `<div class="ed-row"><label><input type="checkbox" data-form="${i}" ${val ? 'checked' : ''}> ${f.name}</label></div>`;
    }
    return `<div class="ed-row"><label>${f.name}<br><input type="text" data-form="${i}" value="${String(val).replace(/"/g, '&quot;')}" size="28"></label></div>`;
  }).join('');
  box.innerHTML = `<h3>Formular ausfüllen</h3>${rows}
    <div class="ed-row"><label><input type="checkbox" id="edFlatten" ${ed.state.flattenForm !== false ? 'checked' : ''}> Felder fest einbrennen (empfohlen)</label></div>
    <div class="ed-row"><button class="btn btn-small btn-primary" id="edFormOk">Fertig</button></div>`;
  modal.classList.remove('hidden');
  $('#edFormOk').onclick = () => {
    box.querySelectorAll('[data-form]').forEach((el) => {
      const f = ed.formFields[parseInt(el.dataset.form, 10)];
      ed.state.formValues[f.name] = f.type === 'checkbox' ? el.checked : el.value;
    });
    ed.state.flattenForm = $('#edFlatten').checked;
    modal.classList.add('hidden');
  };
}

// ---------------------------------------------------------------- Öffnen/Schließen

export async function openEditor(item, onApplied) {
  const srcBytes = item.editedBytes ? item.editedBytes.slice() : new Uint8Array(await item.file.arrayBuffer());
  const root = document.getElementById('editorRoot') || buildUi();
  root.classList.remove('hidden');
  const pdf = await pdfjsLib.getDocument({ data: srcBytes.slice() }).promise;

  ed = {
    item,
    onApplied,
    srcBytes,
    pdf,
    pageIdx: 0,
    zoom: 1,
    pan: { x: 0, y: 0 },
    tool: 'pan',
    penColor: '#d21f1f',
    aspectLock: true,
    penWidth: 2,
    marker: false,
    selected: null,
    pending: null,
    tempRect: null,
    tempStroke: null,
    undoStack: [],
    redoStack: [],
    pagePt: { w: A4[0], h: A4[1] },
    formFields: [],
    fitScale: () => {
      const stage = $('#edStage');
      return Math.min((stage.clientWidth - 30) / ed.pagePt.w, (stage.clientHeight - 30) / ed.pagePt.h);
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
    const fields = probe.getForm().getFields();
    ed.formFields = fields.map((f) => {
      const isCheckbox = typeof f.setText !== 'function' && typeof f.check === 'function';
      return {
        name: f.getName(),
        type: isCheckbox ? 'checkbox' : 'text',
        value: isCheckbox ? f.isChecked?.() : (f.getText ? f.getText() : ''),
      };
    });
  } catch { ed.formFields = []; }
  $('#edFormBtn').classList.toggle('hidden', ed.formFields.length === 0);

  if (!root.dataset.wired) {
    root.dataset.wired = '1';
    root.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#edPagesBtn').addEventListener('click', openPagesModal);
    $('#edFormBtn').addEventListener('click', openFormModal);
    $('#edUndoBtn').addEventListener('click', undo);
    $('#edRedoBtn').addEventListener('click', redo);
    $('#edHistBtn').addEventListener('click', openHistoryModal);
    $('#edDeleteBtn').addEventListener('click', () => {
      if (ed.selected != null) {
        snapshot('Objekt gelöscht');
        curPage().objects.splice(ed.selected, 1);
        ed.selected = null;
        updateProps();
        renderOverlay();
      }
    });
    $('#edPrev').addEventListener('click', () => { if (ed.pageIdx > 0) { ed.pageIdx--; ed.selected = null; renderPageView(); } });
    $('#edNext').addEventListener('click', () => { if (ed.pageIdx < ed.state.pages.length - 1) { ed.pageIdx++; ed.selected = null; renderPageView(); } });
    $('#edZoomIn').addEventListener('click', () => { ed.zoom = Math.min(8, ed.zoom * 1.25); applyZoom(); });
    $('#edZoomOut').addEventListener('click', () => { ed.zoom = Math.max(0.4, ed.zoom / 1.25); applyZoom(); });
    $('#edZoomFit').addEventListener('click', () => { ed.zoom = 1; ed.pan = { x: 0, y: 0 }; applyZoom(); });
    $('#edCancel').addEventListener('click', closeEditor);
    $('#edApply').addEventListener('click', async () => {
      $('#edApply').disabled = true;
      $('#edApply').textContent = 'Wird übernommen …';
      try {
        const out = await applyEdits(ed.srcBytes, ed.state);
        ed.onApplied?.(out);
        closeEditor();
      } catch (e) {
        alert(`Übernehmen fehlgeschlagen: ${e?.message || e}`);
      } finally {
        $('#edApply').disabled = false;
        $('#edApply').textContent = 'Übernehmen';
      }
    });
    $('#edImageInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) { setToolSoft('pan'); return; }
      const bitmap = await loadBitmap(file);
      const canvas = document.createElement('canvas');
      const s = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * s);
      canvas.height = Math.round(bitmap.height * s);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const isJpeg = /jpe?g/i.test(file.type);
      const dataUrl = canvas.toDataURL(isJpeg ? 'image/jpeg' : 'image/png', 0.85);
      const assetId = addAssetFromDataUrl(dataUrl, isJpeg ? 'jpeg' : 'png');
      const w = Math.min(ed.pagePt.w * 0.5, 250);
      ed.pending = { type: 'image', assetId, w, h: w * (canvas.height / canvas.width), color: '#000000' };
      ed.tool = 'place';
      alert('Tippe/Klicke an die Stelle für das Bild.');
    });
    attachPointerHandlers();
  }
  setToolSoft('pan');
  updateProps();
  await renderPageView();
}

function closeEditor() {
  ed?.pdf?.destroy();
  document.getElementById('editorRoot')?.classList.add('hidden');
  $('#edModal')?.classList.add('hidden');
}

// Für Tests
window.__pdfeditor = { applyEdits, processSignatureImage, strokeToSvgPath, normalizeStrokes };
