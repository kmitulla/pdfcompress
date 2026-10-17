// Sammelordner („Paperless Prepare“) – die Vorstufe zwischen Scannen und
// Paperless.
//
// Rohscans und Fotos liegen im Sammelordner auf dem Server. Hier werden sie
// gesichtet und ausgewählt; „Als Dokument öffnen“ macht daraus EIN Dokument
// in der Arbeitsliste (Bilder über das Scan-Studio mit automatischem
// A4-Zuschnitt, PDFs direkt). Nach der Übergabe an Paperless bietet die App an,
// die Rohdateien zu löschen.
//
// Lastverteilung: Der Server hält nur die Dateien. Gerendert, komprimiert und
// OCR-t wird im Browser – der Mini-PC bleibt unbelastet.

import { icon } from './icons.js';
import { $, escapeHtml, fmtSize, plural, confirmDialog, toast } from './ui.js';
import { mergePdfs, newPdf, addImagePageA4, imageBytesFor } from './pdfkit.js';

const state = {
  files: [],            // [{name, size, modified, kind}]
  selected: new Set(),
  busy: false,
  deps: null,           // von app.js gereichte Funktionen
  wired: false,
};

export function initPrepare(deps) {
  state.deps = deps;
  if (!state.wired) wire();
  refresh();
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

export function setStatus(text, kind = '') {
  const el = $('#rawStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = `inline-status ${kind}`;
}

const fileUrl = (name) => `/api/raw/file?name=${encodeURIComponent(name)}`;

// ---------------------------------------------------------------- Liste

export async function refresh() {
  try {
    const res = await fetch('/api/raw', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.files = data.files || [];
    state.selected = new Set([...state.selected].filter((n) => state.files.some((f) => f.name === n)));
    render();
  } catch (e) {
    setStatus(`Sammelordner nicht lesbar: ${e?.message || e}`, 'err');
  }
  state.deps?.onCount?.(state.files.length);
}

function render() {
  const grid = $('#rawGrid');
  if (!grid) return;
  if (state.files.length === 0) {
    grid.innerHTML = `<div class="raw-empty">${icon('inbox', { size: 34 })}<p>Der Sammelordner ist leer.<br>Scans und Fotos landen hier, bis du sie an Paperless übergibst.</p></div>`;
    syncActions();
    return;
  }
  grid.innerHTML = state.files.map((f) => `
    <div class="raw-item ${state.selected.has(f.name) ? 'selected' : ''}" data-name="${escapeHtml(f.name)}" tabindex="0" role="checkbox" aria-checked="${state.selected.has(f.name)}">
      <input type="checkbox" ${state.selected.has(f.name) ? 'checked' : ''} tabindex="-1" aria-label="Auswählen">
      <div class="raw-thumb">${f.kind === 'image' && !/\.(heic|heif|tiff?)$/i.test(f.name)
        ? `<img loading="lazy" src="${fileUrl(f.name)}" alt="">`
        : icon(f.kind === 'pdf' ? 'doc' : 'image', { size: 34 })}</div>
      <div class="raw-info">
        <div class="raw-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="raw-meta">${fmtSize(f.size)} · ${fmtDate(f.modified)}</div>
      </div>
    </div>`).join('');
  syncActions();
}

function toggle(name) {
  if (state.selected.has(name)) state.selected.delete(name);
  else state.selected.add(name);
  render();
}

function syncActions() {
  const n = state.selected.size;
  $('#rawOpenBtn').disabled = n === 0 || state.busy;
  $('#rawDeleteBtn').disabled = n === 0 || state.busy;
  $('#rawSelInfo').textContent = n
    ? `${n} ausgewählt${n > 1 ? ' – werden ein Dokument' : ''}`
    : plural(state.files.length, 'Datei', 'Dateien');
  $('#rawSelectAll').checked = state.files.length > 0 && n === state.files.length;
  $('#inboxSub').textContent = state.files.length
    ? `${plural(state.files.length, 'Datei wartet', 'Dateien warten')} auf die Übergabe an Paperless.`
    : 'Rohscans und Fotos sammeln, sichten – erst dann an Paperless.';
}

// ---------------------------------------------------------------- Übernehmen

async function fetchFile(name) {
  const res = await fetch(fileUrl(name), { cache: 'no-store' });
  if (!res.ok) throw new Error(`„${name}“: HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || (/\.pdf$/i.test(name) ? 'application/pdf' : 'image/jpeg') });
}

/** Ausgewählte Dateien (älteste zuerst) als EIN Dokument öffnen. */
async function openSelection() {
  if (state.busy || state.selected.size === 0) return;
  state.busy = true;
  syncActions();
  const names = state.files.filter((f) => state.selected.has(f.name)).map((f) => f.name);
  setStatus(`${plural(names.length, 'Datei wird', 'Dateien werden')} geladen …`);
  try {
    const files = [];
    for (const name of names) files.push(await fetchFile(name));
    const allImages = files.every((f) => !/\.pdf$/i.test(f.name));
    if (allImages) {
      // Bilder ins Studio: dort greift der automatische A4-Zuschnitt, und man
      // sieht jede Seite, bevor daraus ein Dokument wird.
      state.deps.showView('docs');
      await state.deps.openStudio({ files, rawSources: names });
      setStatus('Im Scan-Studio geöffnet – prüfen und „Fertig“.', 'ok');
    } else {
      // Gemischt: PDFs übernehmen, Bilder unverzerrt auf A4 setzen
      const parts = [];
      for (const f of files) {
        if (/\.pdf$/i.test(f.name)) {
          parts.push(new Uint8Array(await f.arrayBuffer()));
        } else {
          const doc = await newPdf('PDF Presser (Sammelordner)');
          const { bytes, kind } = await imageBytesFor(f);
          await addImagePageA4(doc, bytes, kind);
          parts.push(await doc.save());
        }
      }
      const bytes = parts.length === 1 ? parts[0] : new Uint8Array(await mergePdfs(parts, 'PDF Presser (Sammelordner)'));
      const outName = names.length === 1 ? names[0].replace(/\.[^.]+$/, '') : `Sammlung ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}`;
      state.deps.showView('docs');
      await state.deps.addPdfDoc(bytes, outName, { kind: 'scan', rawSources: names });
      setStatus(`Übernommen: ${outName}`, 'ok');
    }
    state.selected.clear();
    render();
  } catch (e) {
    setStatus(`Übernehmen fehlgeschlagen: ${e?.message || e}`, 'err');
  } finally {
    state.busy = false;
    syncActions();
  }
}

/** Dateien im Sammelordner löschen (ohne Nachfrage). Liefert die Anzahl. */
export async function deleteFiles(names) {
  let done = 0;
  for (const name of names) {
    try {
      const res = await fetch(`/api/raw?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) done++;
    } catch { /* nächste Datei */ }
  }
  names.forEach((n) => state.selected.delete(n));
  await refresh();
  return done;
}

async function deleteSelection() {
  const names = [...state.selected];
  if (!names.length) return;
  const ok = await confirmDialog('Endgültig löschen?', `${plural(names.length, 'Datei wird', 'Dateien werden')} aus dem Sammelordner gelöscht.`, 'Löschen', 'danger');
  if (!ok) return;
  const n = await deleteFiles(names);
  setStatus(`${plural(n, 'Datei', 'Dateien')} gelöscht.`, 'ok');
}

// ---------------------------------------------------------------- Hochladen

/** Datei(en) in den Sammelordner legen (Fotos vom Handy, Scans). */
export async function uploadFiles(files, { quiet = false } = {}) {
  const list = [...files];
  if (!list.length) return 0;
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!quiet) setStatus(`Datei ${i + 1}/${list.length} wird abgelegt …`);
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
  if (!quiet) {
    setStatus(done === list.length
      ? `${plural(done, 'Datei', 'Dateien')} im Sammelordner abgelegt.`
      : `${done} von ${list.length} abgelegt – Rest fehlgeschlagen.`, done === list.length ? 'ok' : 'err');
  }
  return done;
}

// ---------------------------------------------------------------- Verdrahtung

function wire() {
  state.wired = true;
  $('#rawRefreshBtn').addEventListener('click', () => { refresh(); toast('Neu eingelesen', 'ok', 1400); });
  $('#rawOpenBtn').addEventListener('click', openSelection);
  $('#rawDeleteBtn').addEventListener('click', deleteSelection);
  $('#rawSelectAll').addEventListener('change', (e) => {
    state.selected = e.target.checked ? new Set(state.files.map((f) => f.name)) : new Set();
    render();
  });
  const grid = $('#rawGrid');
  grid.addEventListener('click', (e) => {
    const item = e.target.closest('.raw-item');
    if (item) toggle(item.dataset.name);
  });
  grid.addEventListener('keydown', (e) => {
    const item = e.target.closest('.raw-item');
    if (item && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(item.dataset.name); }
  });
  const up = $('#rawUploadInput');
  $('#rawUploadBtn').addEventListener('click', () => up.click());
  up.addEventListener('change', (e) => {
    const files = [...e.target.files];   // lebende Liste – erst kopieren
    e.target.value = '';
    uploadFiles(files);
  });
  $('#rawScanBtn').addEventListener('click', () => state.deps?.scanIntoRaw?.());
}

// Für Tests
window.__pdfprepare = { state, refresh, uploadFiles, deleteFiles };
