// UI-Logik: Dateiverwaltung, Einstellungen, Fortschritt, Downloads.

import { compressPdf, PRESETS } from './compressor.js';
import { disposeOcr } from './ocr.js';

const $ = (sel) => document.querySelector(sel);

const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const fileListEl = $('#fileList');
const actionsEl = $('#actions');
const startBtn = $('#startBtn');
const downloadAllBtn = $('#downloadAllBtn');
const clearBtn = $('#clearBtn');
const customPanel = $('#customPanel');
const qualityField = $('#qualityField');
const ocrEnabled = $('#ocrEnabled');
const ocrLangField = $('#ocrLangField');
const ocrLosslessHint = $('#ocrLosslessHint');

/** @type {{file: File, el: HTMLElement, status: string, result: Uint8Array|null, outName: string}[]} */
const items = [];
let running = false;

// ---------------------------------------------------------------- Einstellungen

function currentPreset() {
  return document.querySelector('input[name="preset"]:checked').value;
}

function currentOptions() {
  const preset = currentPreset();
  let opts;
  if (preset === 'custom') {
    const colorMode = $('#colorMode').value;
    opts = {
      mode: 'raster',
      colorMode,
      dpi: parseInt($('#dpi').value, 10),
      quality: parseInt($('#quality').value, 10) / 100,
    };
  } else {
    opts = { ...PRESETS[preset] };
  }
  if (opts.mode !== 'lossless' && ocrEnabled.checked) {
    opts.ocr = true;
    opts.ocrLang = $('#ocrLang').value;
  }
  return opts;
}

function syncSettingsUi() {
  const preset = currentPreset();
  customPanel.classList.toggle('hidden', preset !== 'custom');
  qualityField.classList.toggle('hidden', preset === 'custom' && $('#colorMode').value === 'bw');
  const lossless = preset === 'verlustfrei';
  ocrEnabled.disabled = lossless;
  ocrLosslessHint.classList.toggle('hidden', !lossless);
  ocrLangField.classList.toggle('hidden', !ocrEnabled.checked || lossless);
}

document.querySelectorAll('input[name="preset"]').forEach((r) => r.addEventListener('change', syncSettingsUi));
$('#colorMode').addEventListener('change', syncSettingsUi);
ocrEnabled.addEventListener('change', syncSettingsUi);
$('#dpi').addEventListener('input', () => { $('#dpiOut').value = $('#dpi').value; });
$('#quality').addEventListener('input', () => { $('#qualityOut').value = $('#quality').value; });
syncSettingsUi();

// ---------------------------------------------------------------- Dateiverwaltung

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

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
      <div class="file-actions">
        <button class="btn btn-small btn-download hidden">Herunterladen</button>
        <button class="btn btn-small btn-ghost btn-remove">Entfernen</button>
      </div>`;
    li.querySelector('.file-name').textContent = file.name;
    fileListEl.appendChild(li);
    const item = { file, el: li, status: 'ready', result: null, outName: file.name.replace(/\.pdf$/i, '') + '_komprimiert.pdf' };
    li.querySelector('.btn-remove').addEventListener('click', () => {
      if (running) return;
      items.splice(items.indexOf(item), 1);
      li.remove();
      updateActions();
    });
    li.querySelector('.btn-download').addEventListener('click', () => downloadItem(item));
    items.push(item);
  }
  updateActions();
}

function updateActions() {
  actionsEl.classList.toggle('hidden', items.length === 0);
  downloadAllBtn.disabled = !items.some((it) => it.result);
}

function setStatus(item, text, cls = '') {
  const el = item.el.querySelector('.file-status');
  el.textContent = text;
  el.className = `file-status ${cls}`;
}

function setProgress(item, frac) {
  item.el.querySelector('.progress > div').style.width = `${Math.round(frac * 100)}%`;
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
  metaEl.innerHTML = `Original: ${fmtSize(originalSize)} → Neu: <strong>${fmtSize(newSize)}</strong>`;
  if (newSize < originalSize) {
    setStatus(item, `Fertig – ${(saved * 100).toFixed(1)} % gespart ✓`, 'ok');
  } else {
    setStatus(item, 'Fertig – Datei war bereits stark optimiert (Ergebnis nicht kleiner)', 'warn');
  }
  item.el.querySelector('.btn-download').classList.remove('hidden');
}

startBtn.addEventListener('click', async () => {
  if (running || items.length === 0) return;
  running = true;
  startBtn.disabled = true;
  const opts = currentOptions();
  for (const item of items) {
    if (item.result) continue;
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
window.__pdfpresser = { compressPdf, PRESETS, items };
