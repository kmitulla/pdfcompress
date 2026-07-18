// UI-Logik: Dateiverwaltung, Einstellungen, Vorschau, Simulation,
// Zielordner/Import-Ordner (File System Access API), Teilen, Downloads.

import { compressPdf, previewPage, simulatePdf, PRESETS } from './compressor.js';
import { disposeOcr } from './ocr.js';

const $ = (sel) => document.querySelector(sel);

const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const fileListEl = $('#fileList');
const actionsEl = $('#actions');
const startBtn = $('#startBtn');
const previewBtn = $('#previewBtn');
const downloadAllBtn = $('#downloadAllBtn');
const clearBtn = $('#clearBtn');
const customPanel = $('#customPanel');
const qualityField = $('#qualityField');
const biasField = $('#biasField');
const ocrEnabled = $('#ocrEnabled');
const ocrLangField = $('#ocrLangField');
const ocrLosslessHint = $('#ocrLosslessHint');
const previewCard = $('#previewCard');
const previewImg = $('#previewImg');
const previewInfo = $('#previewInfo');

/** @type {{file: File, el: HTMLElement, result: Uint8Array|null, outName: string}[]} */
const items = [];
let running = false;
let outputDirHandle = null;
let importDirHandle = null;

const canShareFiles = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
const hasFsAccess = typeof window.showDirectoryPicker === 'function';

// ---------------------------------------------------------------- Einstellungen

function currentPreset() {
  return document.querySelector('input[name="preset"]:checked').value;
}

function currentOptions() {
  const preset = currentPreset();
  let opts;
  if (preset === 'custom') {
    opts = {
      mode: 'raster',
      colorMode: $('#colorMode').value,
      dpi: parseInt($('#dpi').value, 10),
      quality: parseInt($('#quality').value, 10) / 100,
      colors: 16,
    };
  } else {
    opts = { ...PRESETS[preset] };
  }
  if (opts.colorMode === 'bw' || opts.colorMode === 'indexed') {
    opts.bias = parseInt($('#bwBias').value, 10) || 0;
  }
  if (opts.mode !== 'lossless' && ocrEnabled.checked) {
    opts.ocr = true;
    opts.ocrLang = $('#ocrLang').value;
  }
  return opts;
}

function presetLabel() {
  const preset = currentPreset();
  if (preset === 'custom') return 'Benutzerdefiniert';
  return document.querySelector(`input[name="preset"][value="${preset}"]`)
    .closest('.preset').querySelector('.preset-name').textContent.trim();
}

function syncSettingsUi() {
  const preset = currentPreset();
  const opts = currentOptions();
  customPanel.classList.toggle('hidden', preset !== 'custom');
  qualityField.classList.toggle('hidden', preset === 'custom' && ['bw', 'indexed'].includes($('#colorMode').value));
  biasField.classList.toggle('hidden', !['bw', 'indexed'].includes(opts.colorMode));
  const lossless = preset === 'verlustfrei';
  ocrEnabled.disabled = lossless;
  ocrLosslessHint.classList.toggle('hidden', !lossless);
  ocrLangField.classList.toggle('hidden', !ocrEnabled.checked || lossless);
  schedulePreviewRefresh();
}

document.querySelectorAll('input[name="preset"]').forEach((r) => r.addEventListener('change', syncSettingsUi));
$('#colorMode').addEventListener('change', syncSettingsUi);
ocrEnabled.addEventListener('change', syncSettingsUi);
$('#dpi').addEventListener('input', () => { $('#dpiOut').value = $('#dpi').value; schedulePreviewRefresh(); });
$('#quality').addEventListener('input', () => { $('#qualityOut').value = $('#quality').value; schedulePreviewRefresh(); });
$('#bwBias').addEventListener('input', () => { $('#bwBiasOut').value = $('#bwBias').value; schedulePreviewRefresh(); });

// ---------------------------------------------------------------- Hilfen

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function setStatus(item, text, cls = '') {
  const el = item.el.querySelector('.file-status');
  el.textContent = text;
  el.className = `file-status ${cls}`;
}

function setProgress(item, frac) {
  item.el.querySelector('.progress > div').style.width = `${Math.round(frac * 100)}%`;
}

// ---------------------------------------------------------------- Dateiverwaltung

function addFiles(fileList) {
  for (const file of fileList) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') continue;
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <div class="file-name"></div>
      <div class="file-meta">Original: ${fmtSize(file.size)}</div>
      <div class="file-status">Bereit</div>
      <div class="progress"><div></div></div>
      <div class="sim-results hidden"></div>
      <div class="file-actions">
        <button class="btn btn-small btn-download hidden">Herunterladen</button>
        <button class="btn btn-small btn-save-dir hidden">In Zielordner speichern</button>
        <button class="btn btn-small btn-share hidden">Teilen</button>
        <button class="btn btn-small btn-simulate">Simulation</button>
        <button class="btn btn-small btn-ghost btn-remove">Entfernen</button>
      </div>`;
    li.querySelector('.file-name').textContent = file.name;
    fileListEl.appendChild(li);
    const item = { file, el: li, result: null, outName: file.name.replace(/\.pdf$/i, '') + '_komprimiert.pdf' };
    li.querySelector('.btn-remove').addEventListener('click', () => {
      if (running) return;
      items.splice(items.indexOf(item), 1);
      li.remove();
      updateActions();
    });
    li.querySelector('.btn-download').addEventListener('click', () => downloadItem(item));
    li.querySelector('.btn-save-dir').addEventListener('click', () => saveItemToDir(item));
    li.querySelector('.btn-share').addEventListener('click', () => shareItem(item));
    li.querySelector('.btn-simulate').addEventListener('click', () => runSimulation(item));
    items.push(item);
  }
  updateActions();
}

function updateActions() {
  actionsEl.classList.toggle('hidden', items.length === 0);
  downloadAllBtn.disabled = !items.some((it) => it.result);
  const allDone = items.length > 0 && items.every((it) => it.result);
  startBtn.textContent = allDone ? 'Erneut komprimieren' : 'Komprimieren';
  if (items.length === 0) closePreview();
}

function refreshItemButtons(item) {
  const has = !!item.result;
  item.el.querySelector('.btn-download').classList.toggle('hidden', !has);
  item.el.querySelector('.btn-save-dir').classList.toggle('hidden', !has || !outputDirHandle);
  item.el.querySelector('.btn-share').classList.toggle('hidden', !has || !canShareFiles);
}

function downloadItem(item) {
  if (!item.result) return;
  const blob = new Blob([item.result], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = item.outName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function shareItem(item) {
  if (!item.result || !canShareFiles) return;
  const file = new File([item.result], item.outName, { type: 'application/pdf' });
  try {
    if (navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: item.outName });
    } else {
      await navigator.share({ title: item.outName, text: 'Komprimiert mit PDF Presser', url: location.href });
    }
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn('Teilen fehlgeschlagen:', e);
  }
}

// Drag & Drop + Auswahl
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
}));
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- Komprimieren

async function processItem(item, opts) {
  item.result = null;
  refreshItemButtons(item);
  setStatus(item, 'Wird gelesen …');
  const buf = await item.file.arrayBuffer();
  const originalSize = buf.byteLength;

  const result = await compressPdf(buf, opts, (p) => {
    if (p.phase === 'render') {
      setStatus(item, `Seite ${p.page}/${p.pages} wird verarbeitet …`);
      setProgress(item, (p.page - 1) / p.pages);
    } else if (p.phase === 'ocr') {
      const pct = p.detail != null ? ` ${Math.round(p.detail * 100)} %` : '';
      setStatus(item, `OCR Seite ${p.page}/${p.pages}${pct} …`);
      setProgress(item, (p.page - 0.5) / p.pages);
    } else if (p.phase === 'save' || p.phase === 'optimize') {
      setStatus(item, 'PDF wird geschrieben …');
      setProgress(item, 0.98);
    }
  });

  item.result = result;
  setProgress(item, 1);
  const newSize = result.byteLength;
  const saved = 1 - newSize / originalSize;
  const metaEl = item.el.querySelector('.file-meta');
  metaEl.innerHTML = `Vorher: ${fmtSize(originalSize)} → Nachher: <strong>${fmtSize(newSize)}</strong> · ${presetLabel()}`;
  if (newSize < originalSize) {
    setStatus(item, `Fertig – ${(saved * 100).toFixed(1)} % gespart ✓`, 'ok');
  } else {
    setStatus(item, 'Fertig – Ergebnis nicht kleiner als das Original (andere Stufe probieren)', 'warn');
  }
  refreshItemButtons(item);

  if (outputDirHandle && $('#autoSave').checked) {
    await saveItemToDir(item);
  }
}

startBtn.addEventListener('click', async () => {
  if (running || items.length === 0) return;
  running = true;
  startBtn.disabled = true;
  const opts = currentOptions();
  for (const item of items) {
    try {
      await processItem(item, opts);
    } catch (err) {
      console.error(err);
      const msg = /password|encrypt/i.test(String(err))
        ? 'Fehler: PDF ist passwortgeschützt/verschlüsselt'
        : `Fehler: ${err?.message || err}`;
      setStatus(item, msg, 'err');
      setProgress(item, 0);
    }
  }
  await disposeOcr();
  running = false;
  startBtn.disabled = false;
  updateActions();
});

downloadAllBtn.addEventListener('click', () => {
  items.filter((it) => it.result).forEach((it, i) => setTimeout(() => downloadItem(it), i * 300));
});

clearBtn.addEventListener('click', () => {
  if (running) return;
  items.length = 0;
  fileListEl.innerHTML = '';
  updateActions();
});

// ---------------------------------------------------------------- Vorschau

let previewTimer = null;
let previewBusy = false;
let previewPending = false;

function closePreview() {
  previewCard.classList.add('hidden');
}

async function refreshPreview() {
  if (previewCard.classList.contains('hidden') || items.length === 0) return;
  if (previewBusy) {
    previewPending = true;
    return;
  }
  previewBusy = true;
  try {
    const opts = currentOptions();
    if (opts.mode === 'lossless') {
      previewInfo.textContent = 'Verlustfrei ändert das Aussehen nicht – Vorschau zeigt das Original.';
      opts.mode = 'raster';
      opts.colorMode = 'color';
      opts.dpi = 120;
      opts.quality = 0.9;
      const { dataUrl } = await previewPage(await items[0].file.arrayBuffer(), opts);
      previewImg.src = dataUrl;
    } else {
      previewInfo.textContent = 'Wird berechnet …';
      const { dataUrl, pageBytes, numPages } = await previewPage(await items[0].file.arrayBuffer(), opts);
      previewImg.src = dataUrl;
      previewInfo.textContent = `${items[0].file.name} · Seite 1/${numPages} · ≈ ${fmtSize(pageBytes)} pro Seite (${presetLabel()})`;
    }
  } catch (e) {
    previewInfo.textContent = `Vorschau-Fehler: ${e?.message || e}`;
  } finally {
    previewBusy = false;
    if (previewPending) {
      previewPending = false;
      refreshPreview();
    }
  }
}

function schedulePreviewRefresh() {
  if (previewCard.classList.contains('hidden')) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 350);
}

previewBtn.addEventListener('click', () => {
  if (items.length === 0) return;
  previewCard.classList.remove('hidden');
  refreshPreview();
  previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('#closePreviewBtn').addEventListener('click', closePreview);

// ---------------------------------------------------------------- Simulation

async function runSimulation(item) {
  const box = item.el.querySelector('.sim-results');
  const btn = item.el.querySelector('.btn-simulate');
  box.classList.remove('hidden');
  btn.disabled = true;
  box.innerHTML = '<em>Simulation läuft …</em>';
  try {
    const buf = await item.file.arrayBuffer();
    const { results, totalPages, sampledPages } = await simulatePdf(buf, ({ label }) => {
      box.innerHTML = `<em>Simuliere: ${label} …</em>`;
    });
    const orig = item.file.size;
    const rows = results.map(({ label, size, estimated }) => {
      const pct = (1 - size / orig) * 100;
      const cls = size < orig ? 'sim-good' : 'sim-bad';
      return `<tr><td>${label}</td><td>${fmtSize(size)}${estimated ? '&nbsp;*' : ''}</td><td class="${cls}">${pct >= 0 ? '−' : '+'}${Math.abs(pct).toFixed(1)} %</td></tr>`;
    }).join('');
    const note = sampledPages < totalPages
      ? `<p class="sim-note">* hochgerechnet aus ${sampledPages} Beispielseiten von ${totalPages} (ohne OCR)</p>`
      : '<p class="sim-note">Alle Seiten berechnet (ohne OCR)</p>';
    box.innerHTML = `
      <table class="sim-table">
        <thead><tr><th>Stufe</th><th>Nachher</th><th>Ersparnis</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="sim-note">Vorher: ${fmtSize(orig)}</p>${note}`;
  } catch (e) {
    box.innerHTML = `<span class="file-status err">Simulation fehlgeschlagen: ${e?.message || e}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- Zielordner (File System Access API)

async function setOutputDir(handle) {
  outputDirHandle = handle;
  $('#outDirInfo').textContent = `Zielordner: ${handle.name}`;
  $('#outDirInfo').classList.remove('hidden');
  $('#autoSaveField').classList.remove('hidden');
  items.forEach(refreshItemButtons);
}

async function saveItemToDir(item) {
  if (!item.result || !outputDirHandle) return;
  try {
    const fileHandle = await outputDirHandle.getFileHandle(item.outName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(item.result);
    await writable.close();
    const st = item.el.querySelector('.file-status');
    if (!st.textContent.includes('gespeichert')) {
      st.textContent += ` · gespeichert in „${outputDirHandle.name}“ ✓`;
    }
  } catch (e) {
    setStatus(item, `Speichern im Zielordner fehlgeschlagen: ${e?.message || e}`, 'err');
  }
}

if (hasFsAccess) {
  $('#pickOutDirBtn').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await setOutputDir(handle);
    } catch (e) {
      if (e?.name !== 'AbortError') console.warn(e);
    }
  });
} else {
  $('#pickOutDirBtn').classList.add('hidden');
  $('#fsUnsupportedHint').classList.remove('hidden');
}

// ---------------------------------------------------------------- Import-Ordner

async function scanDirForPdfs(dirHandle, depth = 0) {
  const found = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && /\.pdf$/i.test(entry.name)) {
      found.push(entry);
    } else if (entry.kind === 'directory' && depth < 2) {
      found.push(...await scanDirForPdfs(entry, depth + 1));
    }
  }
  return found;
}

async function importFromDirHandle(handle) {
  importDirHandle = handle;
  const listEl = $('#importList');
  listEl.classList.remove('hidden');
  $('#rescanImportBtn').classList.remove('hidden');
  listEl.innerHTML = `<em>Scanne „${handle.name}“ …</em>`;
  try {
    const entries = await scanDirForPdfs(handle);
    if (entries.length === 0) {
      listEl.innerHTML = `<p>In „${handle.name}“ wurden keine PDFs gefunden.</p>`;
      return 0;
    }
    const files = [];
    for (const entry of entries) files.push(await entry.getFile());
    listEl.innerHTML = `
      <p><strong>${files.length} PDF${files.length === 1 ? '' : 's'}</strong> in „${handle.name}“ gefunden:</p>
      <ul class="import-found"></ul>
      <button class="btn btn-small btn-primary" id="importAllBtn">Alle zur Liste hinzufügen</button>`;
    const ul = listEl.querySelector('.import-found');
    for (const file of files) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'btn btn-small';
      btn.textContent = '+';
      btn.title = 'Zur Liste hinzufügen';
      btn.addEventListener('click', () => { addFiles([file]); btn.disabled = true; });
      const span = document.createElement('span');
      span.textContent = ` ${file.name} (${fmtSize(file.size)})`;
      li.append(btn, span);
      ul.appendChild(li);
    }
    listEl.querySelector('#importAllBtn').addEventListener('click', () => {
      addFiles(files);
      ul.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    });
    return files.length;
  } catch (e) {
    listEl.innerHTML = `<span class="file-status err">Scan fehlgeschlagen: ${e?.message || e}</span>`;
    return -1;
  }
}

if (hasFsAccess) {
  $('#pickImportDirBtn').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await importFromDirHandle(handle);
    } catch (e) {
      if (e?.name !== 'AbortError') console.warn(e);
    }
  });
  $('#rescanImportBtn').addEventListener('click', () => {
    if (importDirHandle) importFromDirHandle(importDirHandle);
  });
} else {
  $('#pickImportDirBtn').classList.add('hidden');
}

syncSettingsUi();

// ---------------------------------------------------------------- PWA

async function registerSw() {
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    const showReady = () => $('#offlineReadyBadge').classList.remove('hidden');
    if (reg.active && !reg.installing) showReady();
    reg.addEventListener('updatefound', () => {
      reg.installing?.addEventListener('statechange', function () {
        if (this.state === 'activated') showReady();
      });
    });
    if (navigator.serviceWorker.controller) showReady();
  } catch (e) {
    console.warn('Service-Worker-Registrierung fehlgeschlagen:', e);
  }
}
if ('serviceWorker' in navigator) {
  // app.js lädt durch Top-Level-await evtl. erst nach dem load-Event
  if (document.readyState === 'complete') registerSw();
  else window.addEventListener('load', registerSw);
}

// Für die automatisierten Tests
window.__pdfpresser = {
  compressPdf, previewPage, simulatePdf, PRESETS, items,
  setOutputDir, saveItemToDir, importFromDirHandle,
};
