// „Paperless Prepare“ – die Vorstufe zwischen Scannen und Paperless.
//
// Rohscans und Fotos liegen im Sammelordner (Scanner_RAW) auf dem Server. Hier
// werden sie gesichtet, zusammengeführt, bearbeitet, komprimiert und erst dann
// an Paperless übergeben – auf Wunsch mit anschließendem Aufräumen.
//
// Wichtig zur Lastverteilung: Der Server hält nur die Dateien. Gerendert,
// komprimiert und OCR-t wird wie überall sonst im Browser, also auf dem Gerät,
// an dem gerade jemand sitzt. Der Mini-PC bleibt dadurch unbelastet.

import { icon, hydrateIcons } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  files: [],            // [{name, size, modified, kind}]
  selected: new Set(),
  busy: false,
  deps: null,           // von app.js gereichte Funktionen
};

export function initPrepare(deps) {
  state.deps = deps;
  $('#prepSection')?.classList.remove('hidden');
  wire();
  refresh();
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function setStatus(text, kind = '') {
  const el = $('#prepStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = `prep-status ${kind}`;
}

// ---------------------------------------------------------------- Liste

export async function refresh() {
  const list = $('#prepList');
  if (!list) return;
  try {
    const res = await fetch('/api/raw', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.files = data.files || [];
    // Auswahl auf noch vorhandene Dateien eindampfen
    state.selected = new Set([...state.selected].filter((n) => state.files.some((f) => f.name === n)));
    render();
  } catch (e) {
    list.innerHTML = `<p class="hint">Sammelordner nicht lesbar: ${e?.message || e}</p>`;
  }
}

function render() {
  const list = $('#prepList');
  list.innerHTML = '';
  if (state.files.length === 0) {
    list.innerHTML = '<p class="hint">Noch nichts im Sammelordner. Scans und Fotos landen hier, bis du sie an Paperless übergibst.</p>';
    syncActions();
    return;
  }
  for (const f of state.files) {
    const row = document.createElement('label');
    row.className = 'prep-item';
    row.innerHTML = `
      <input type="checkbox" ${state.selected.has(f.name) ? 'checked' : ''}>
      <span class="prep-ic">${icon(f.kind === 'pdf' ? 'doc' : 'image', { size: 18 })}</span>
      <span class="prep-body">
        <span class="prep-name"></span>
        <span class="prep-meta">${fmtSize(f.size)} · ${fmtDate(f.modified)}</span>
      </span>`;
    row.querySelector('.prep-name').textContent = f.name;
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) state.selected.add(f.name);
      else state.selected.delete(f.name);
      syncActions();
    });
    list.appendChild(row);
  }
  syncActions();
}

function syncActions() {
  const n = state.selected.size;
  const any = n > 0;
  for (const id of ['#prepOpenBtn', '#prepDeleteBtn']) {
    const b = $(id);
    if (b) b.disabled = !any || state.busy;
  }
  const info = $('#prepSelInfo');
  if (info) {
    info.textContent = any
      ? `${n} ausgewählt${n > 1 ? ' – werden zu einer PDF zusammengeführt' : ''}`
      : `${state.files.length} Datei${state.files.length === 1 ? '' : 'en'} im Sammelordner`;
  }
  const all = $('#prepSelectAll');
  if (all) all.checked = state.files.length > 0 && n === state.files.length;
}

// ---------------------------------------------------------------- Übernehmen

/** Ausgewählte Dateien laden und als eine PDF in die Arbeitsliste holen. */
async function openSelection() {
  if (state.busy || state.selected.size === 0) return;
  state.busy = true;
  syncActions();
  const names = state.files.filter((f) => state.selected.has(f.name)).map((f) => f.name);
  setStatus(`${names.length} Datei${names.length === 1 ? '' : 'en'} wird geladen …`);
  try {
    const { PDFDocument } = window.PDFLib;
    const merged = await PDFDocument.create();
    merged.setProducer('PDF Presser (Vorstufe)');

    for (const name of names) {
      setStatus(`„${name}“ wird gelesen …`);
      const res = await fetch(`/api/raw/file?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`„${name}“: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());

      if (/\.pdf$/i.test(name)) {
        const doc = await PDFDocument.load(buf);
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      } else {
        // Bild: unverzerrt auf ein A4-Blatt setzen (hoch oder quer)
        const img = /\.png$/i.test(name) ? await merged.embedPng(buf) : await merged.embedJpg(buf);
        const A4 = [595.28, 841.89];
        const landscape = img.width > img.height;
        const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
        const page = merged.addPage([pw, ph]);
        page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: window.PDFLib.rgb(1, 1, 1) });
        const s = Math.min(pw / img.width, ph / img.height);
        page.drawImage(img, {
          x: (pw - img.width * s) / 2,
          y: (ph - img.height * s) / 2,
          width: img.width * s,
          height: img.height * s,
        });
      }
    }

    const bytes = await merged.save({ useObjectStreams: true });
    const outName = names.length === 1
      ? names[0].replace(/\.[^.]+$/, '') + '.pdf'
      : `Sammlung_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pdf`;
    const file = new File([bytes], outName, { type: 'application/pdf' });
    file.rawSources = names;   // merkt sich die Herkunft für das Aufräumen

    state.deps.addFiles([file]);
    setStatus(`Übernommen: ${outName} – jetzt bearbeiten, komprimieren und an Paperless senden.`, 'ok');
    state.deps.applyPrepareDefaults?.();
    state.deps.focusWorkList?.();
  } catch (e) {
    setStatus(`Übernehmen fehlgeschlagen: ${e?.message || e}`, 'err');
  } finally {
    state.busy = false;
    syncActions();
  }
}

/** Ausgewählte Dateien im Sammelordner löschen. */
async function deleteSelection(namesArg = null, ask = true) {
  const names = namesArg || [...state.selected];
  if (names.length === 0) return 0;
  if (ask && !window.confirm(
    `${names.length} Datei${names.length === 1 ? '' : 'en'} endgültig aus dem Sammelordner löschen?`,
  )) return 0;
  let done = 0;
  for (const name of names) {
    try {
      const res = await fetch(`/api/raw?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) done++;
    } catch { /* nächste Datei */ }
  }
  state.selected.clear();
  await refresh();
  return done;
}

export { deleteSelection };

// ---------------------------------------------------------------- Hochladen

/** Datei(en) in den Sammelordner legen (Fotos vom Handy, Scans). */
export async function uploadToRaw(files, label = 'Datei') {
  const list = [...files];
  if (!list.length) return 0;
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    setStatus(`${label} ${i + 1}/${list.length} wird abgelegt …`);
    try {
      const res = await fetch(`/api/raw?name=${encodeURIComponent(f.name || 'datei')}`, {
        method: 'POST',
        headers: { 'Content-Type': f.type || 'application/octet-stream' },
        body: await f.arrayBuffer(),
      });
      if (res.ok) done++;
    } catch { /* nächste Datei */ }
  }
  await refresh();
  setStatus(done === list.length
    ? `${done} Datei${done === 1 ? '' : 'en'} im Sammelordner abgelegt.`
    : `${done} von ${list.length} abgelegt – Rest fehlgeschlagen.`, done === list.length ? 'ok' : 'err');
  return done;
}

// ---------------------------------------------------------------- Verdrahtung

function wire() {
  $('#prepRefreshBtn')?.addEventListener('click', refresh);
  $('#prepOpenBtn')?.addEventListener('click', openSelection);
  $('#prepDeleteBtn')?.addEventListener('click', () => deleteSelection());

  $('#prepSelectAll')?.addEventListener('change', (e) => {
    state.selected = e.target.checked ? new Set(state.files.map((f) => f.name)) : new Set();
    render();
  });

  // Fotos/Dateien vom Gerät in den Sammelordner
  const up = $('#prepUploadInput');
  $('#prepUploadBtn')?.addEventListener('click', () => up?.click());
  up?.addEventListener('change', (e) => {
    const files = [...e.target.files];   // lebende Liste – erst kopieren
    e.target.value = '';
    uploadToRaw(files, 'Datei');
  });

  // Direkt in den Sammelordner scannen
  $('#prepScanBtn')?.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    syncActions();
    try {
      const total = state.deps.scanPageCount?.() || 1;
      const delay = state.deps.scanDelay?.() || 0;
      await state.deps.scanIntoRaw?.(total, delay, setStatus);
      await refresh();
    } catch (e) {
      setStatus(`Scan fehlgeschlagen: ${e?.message || e}`, 'err');
    } finally {
      state.busy = false;
      syncActions();
    }
  });

  hydrateIcons($('#prepSection'));
}

// Für Tests
window.__pdfprepare = { state, refresh, uploadToRaw, deleteSelection };
