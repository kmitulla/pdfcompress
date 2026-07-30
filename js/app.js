// UI-Logik: Dateiverwaltung, Einstellungen, Vorschau, Simulation,
// Zielordner/Import-Ordner (File System Access API), Teilen, Downloads.

import { compressPdf, previewPage, simulatePdf, PRESETS } from './compressor.js';
import { disposeOcr } from './ocr.js';
import { openEditor, setScanProvider } from './editor.js';
import {
  exportAllData, importAllData, loadSettings, saveSettings, requestPersistence,
  enableServerProfile, pullServerProfile, onSyncStatus,
} from './store.js';
import { icon, hydrateIcons } from './icons.js';

const $ = (sel) => document.querySelector(sel);

// Icons in der Grundoberfläche einsetzen (Scanner/Editor machen das selbst).
hydrateIcons();

// ---------------------------------------------------------------- Rückmeldung (Toast)

const toastHost = $('#toastHost');

/**
 * Kurze Rückmeldung am unteren Rand. `kind`: 'ok' | 'err' | 'busy'.
 * Gibt eine Funktion zurück, mit der sich der Toast aktualisieren/schließen lässt.
 */
function toast(text, kind = 'ok', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  const ic = kind === 'err' ? 'info' : kind === 'busy' ? 'spinner' : 'check';
  el.innerHTML = `${icon(ic, { size: 18 })}<span></span>`;
  el.querySelector('span').textContent = text;
  toastHost.appendChild(el);

  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  };
  if (ms) timer = setTimeout(close, ms);

  return {
    update(newText, newKind = kind, newMs = 3200) {
      el.className = `toast toast-${newKind}`;
      const ni = newKind === 'err' ? 'info' : newKind === 'busy' ? 'spinner' : 'check';
      el.innerHTML = `${icon(ni, { size: 18 })}<span></span>`;
      el.querySelector('span').textContent = newText;
      clearTimeout(timer);
      if (newMs) timer = setTimeout(close, newMs);
    },
    close,
  };
}

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

// Backend-Funktionen (nur aktiv, wenn die App über den mitgelieferten Server
// läuft – z. B. im Docker-Container auf dem Mini-PC. Auf GitHub Pages: aus.)
const backend = { scanner: false, consume: false, profile: false };

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
  if (preset.startsWith('extrem')) {
    const dpiOverride = parseInt($('#extremeDpi').value, 10);
    if (dpiOverride) opts.dpi = dpiOverride;
  }
  if (opts.colorMode === 'bw' || opts.colorMode === 'indexed') {
    opts.bias = parseInt($('#bwBias').value, 10) || 0;
  }
  if (opts.colorMode === 'bw') {
    opts.contrast = parseInt($('#bwContrast').value, 10) || 0;
    opts.darkAreas = $('#darkAreas').value || 'auto';
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
  // Kontrast und Umgang mit dunklen Flächen betreffen nur die 1-Bit-Ausgabe
  $('#contrastField').classList.toggle('hidden', opts.colorMode !== 'bw');
  $('#darkAreasField').classList.toggle('hidden', opts.colorMode !== 'bw');
  $('#extremeDpiField').classList.toggle('hidden', !preset.startsWith('extrem'));
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
$('#bwContrast').addEventListener('input', () => { $('#bwContrastOut').value = $('#bwContrast').value; schedulePreviewRefresh(); });
$('#darkAreas').addEventListener('change', schedulePreviewRefresh);
$('#extremeDpi').addEventListener('change', schedulePreviewRefresh);

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
        <button class="btn btn-small btn-edit">${icon('pen', { size: 15 })} Bearbeiten</button>
        <button class="btn btn-small btn-download hidden">${icon('download', { size: 15 })} Herunterladen</button>
        <button class="btn btn-small btn-save-dir hidden">${icon('folder', { size: 15 })} In Zielordner</button>
        <button class="btn btn-small btn-paperless hidden">${icon('upload', { size: 15 })} An Paperless</button>
        <button class="btn btn-small btn-share hidden">${icon('share', { size: 15 })} Teilen</button>
        <button class="btn btn-small btn-simulate">${icon('chart', { size: 15 })} Simulation</button>
        <button class="btn btn-small btn-ghost btn-remove">${icon('trash', { size: 15 })} Entfernen</button>
      </div>`;
    li.querySelector('.file-name').textContent = file.name;
    fileListEl.appendChild(li);
    const item = { file, el: li, result: null, pageOverrides: {}, outName: file.name.replace(/\.pdf$/i, '') + '_komprimiert.pdf' };
    li.querySelector('.btn-remove').addEventListener('click', () => {
      if (running) return;
      items.splice(items.indexOf(item), 1);
      li.remove();
      updateActions();
    });
    li.querySelector('.btn-edit').addEventListener('click', () => {
      if (running) return;
      openEditor(item, (editedBytes) => {
        item.editedBytes = editedBytes;
        item.result = null;
        refreshItemButtons(item);
        setStatus(item, `Bearbeitet (${fmtSize(editedBytes.length)}) – jetzt komprimieren`, 'ok');
        item.el.querySelector('.file-meta').innerHTML = `Original: ${fmtSize(item.file.size)} · <strong>bearbeitet</strong>`;
        updateActions();
      });
    });
    li.querySelector('.btn-download').addEventListener('click', () => downloadItem(item));
    li.querySelector('.btn-save-dir').addEventListener('click', () => saveItemToDir(item));
    li.querySelector('.btn-paperless').addEventListener('click', () => saveItemToPaperless(item));
    li.querySelector('.btn-share').addEventListener('click', () => shareItem(item));
    li.querySelector('.btn-simulate').addEventListener('click', () => runSimulation(item));
    items.push(item);
  }
  updateActions();
}

function updateActions() {
  actionsEl.classList.toggle('hidden', items.length === 0);
  $('#mergeBtn').classList.toggle('hidden', items.length < 2);
  const anyResult = items.some((it) => it.result);
  downloadAllBtn.disabled = !anyResult;
  $('#sendAllBtn').classList.toggle('hidden', !backend.consume || items.length < 2);
  $('#sendAllBtn').disabled = !anyResult;
  const allDone = items.length > 0 && items.every((it) => it.result);
  startBtn.innerHTML = `${icon('archive', { size: 17 })} ${allDone ? 'Erneut komprimieren' : 'Komprimieren'}`;
  if (items.length === 0) closePreview();
}

function refreshItemButtons(item) {
  const has = !!item.result;
  item.el.querySelector('.btn-download').classList.toggle('hidden', !has);
  item.el.querySelector('.btn-save-dir').classList.toggle('hidden', !has || !outputDirHandle);
  item.el.querySelector('.btn-paperless').classList.toggle('hidden', !has || !backend.consume);
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

// ---------------------------------------------------------------- Scanner

const scanBtn = $('#scanBtn');
const scanHint = $('#scanHint');
const netScanBtn = $('#netScanBtn');

// Rückmeldung, wenn der Scanner ein fertiges PDF liefert.
function onScanDone(pdfFile) {
  addFiles([pdfFile]);
  scanHint.classList.remove('hidden');
  scanHint.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const settings = document.querySelector('.settings');
  settings.classList.remove('flash-accent');
  void settings.offsetWidth; // Animation neu starten
  settings.classList.add('flash-accent');
}

async function launchScanner() {
  // Modul erst bei Bedarf laden (steckt trotzdem im Offline-Precache)
  const { openScanner } = await import('./scanner.js');
  openScanner(onScanDone);
}

scanBtn.addEventListener('click', launchScanner);
scanBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launchScanner(); }
});

// ------------------------------------------------ Netzwerk-Scanner (Epson via Backend)

let netScanBusy = false;

/**
 * Holt genau eine Seite vom Netzwerk-Scanner. Wirft bei Fehlern.
 * Wird sowohl von der Startkachel als auch aus dem Scanner heraus benutzt,
 * damit man Seite für Seite in dieselbe PDF sammeln kann.
 */
async function fetchScannedPage() {
  const dpi = parseInt($('#scanDpi').value, 10) || 300;
  const color = $('#scanColor').value || 'color';
  const res = await fetch(`/api/scanner/scan?color=${encodeURIComponent(color)}&dpi=${dpi}`, { method: 'POST' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const type = blob.type || 'image/jpeg';
  const ext = type.includes('png') ? 'png' : 'jpg';
  const file = new File([blob], `scan_${Date.now()}.${ext}`, { type });
  // Auflösung merken – daraus errechnet der Scanner die echte Größe der
  // Glasfläche in Millimetern und damit den A4-Ausschnitt.
  file.scanDpi = parseInt(res.headers.get('X-Scan-Dpi'), 10) || dpi;
  return file;
}

// Läuft ein Stapel-Scan? Erlaubt Abbrechen zwischen zwei Seiten.
let batchCancel = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Wachhalten
//
// Beim Stapel-Scan darf das Gerät nicht in den Ruhezustand fallen, sonst hält
// das System die Seite an und die restlichen Seiten werden nie gescannt.
// Zwei Ebenen, weil keine allein überall greift:
//   1. Wake Lock – hält den Bildschirm an. Gibt es nur in „sicherem Kontext“,
//      also über HTTPS (oder localhost). Über http:// im LAN nicht verfügbar.
//   2. Stille Tonspur in Dauerschleife – hält auf iOS die Seite am Leben, auch
//      wenn der Bildschirm ausgeht. Funktioniert auch ohne HTTPS.
// Zusätzlich wird nach dem Aufwachen weitergemacht (siehe batchWait).

let wakeLock = null;
let silentAudio = null;

function silentWavUrl() {
  // Eine Sekunde Stille als WAV – klein genug, um sie hier zu erzeugen.
  const rate = 8000;
  const samples = rate;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

async function keepAwakeStart() {
  try {
    if (navigator.wakeLock?.request) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }   // z. B. verweigert oder nicht verfügbar

  try {
    if (!silentAudio) {
      silentAudio = new Audio(silentWavUrl());
      silentAudio.loop = true;
      silentAudio.volume = 0;
      silentAudio.setAttribute('playsinline', '');
    }
    // Muss aus der Nutzergeste heraus starten – der Tipp auf „Scannen“ zählt.
    await silentAudio.play();
  } catch { /* Tonspur nicht erlaubt: dann greift nur der Wake Lock */ }
}

function keepAwakeStop() {
  try { wakeLock?.release?.(); } catch { /* egal */ }
  wakeLock = null;
  try { silentAudio?.pause(); } catch { /* egal */ }
}

// Nach dem Zurückkehren aus dem Hintergrund den Wake Lock erneuern – das
// System gibt ihn beim Sperren frei.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !netScanBusy) return;
  try {
    if (navigator.wakeLock?.request && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* egal */ }
});

/** Hinweis, falls das Wachhalten des Bildschirms nicht möglich ist. */
function wakeLockHint() {
  return (navigator.wakeLock?.request)
    ? ''
    : ' · Bildschirm bitte an lassen (Wachhalten geht nur über HTTPS)';
}

/**
 * Wartet mit sichtbarem Countdown; bricht sofort ab, wenn abgebrochen wurde.
 *
 * Gerechnet wird gegen die Uhr, nicht über gezählte Sekunden: War das Gerät
 * zwischendurch im Ruhezustand, ist die Pause nach dem Aufwachen sofort vorbei
 * und der Stapel läuft weiter, statt die verlorene Zeit nachzuholen.
 */
async function batchWait(seconds, page, total, setStatus) {
  const until = Date.now() + seconds * 1000;
  while (!batchCancel) {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) return;
    setStatus(`Seite ${page}/${total} – nächster Scan in ${left} s … Vorlage wechseln`);
    await sleep(Math.min(1000, Math.max(120, until - Date.now())));
  }
}

async function launchNetworkScan() {
  if (netScanBusy) return;
  const total = Math.max(1, Math.min(99, parseInt($('#scanPages').value, 10) || 1));
  const delay = Math.max(0, Math.min(120, parseInt($('#scanDelay').value, 10) || 0));

  netScanBusy = true;
  batchCancel = false;
  netScanBtn.classList.add('scanning');
  // Bei mehreren Seiten das Gerät wach halten – sonst hält das System die
  // Seite im Ruhezustand an und der Rest wird nie gescannt.
  if (total > 1) await keepAwakeStart();
  const t = toast(total > 1 ? `Scanne Seite 1 von ${total} …${wakeLockHint()}` : 'Scanne … bitte Vorlage auflegen', 'busy', 0);

  let scanner = null;
  try {
    const file = await fetchScannedPage();
    const mod = await import('./scanner.js');
    scanner = mod;

    if (total === 1) {
      t.close();
      // Einzelscan wie gehabt: direkt in den Zuschnitt-Editor
      mod.openScanner(onScanDone, { initialFiles: [file], netScan: fetchScannedPage, onCancelBatch: cancelBatchScan });
      return;
    }

    // Stapel: alle Seiten am Stück einlesen, Zuschnitt automatisch setzen.
    // Nachjustieren geht anschließend in der Seitenübersicht.
    mod.openScanner(onScanDone, { netScan: fetchScannedPage, onCancelBatch: cancelBatchScan });
    const status = (s) => { mod.setScanStatus(s); t.update(s, 'busy', 0); };
    await mod.addPageDirect(file);
    status(`Seite 1/${total} eingelesen`);

    for (let n = 2; n <= total; n++) {
      if (batchCancel) break;
      if (delay > 0) await batchWait(delay, n - 1, total, status);
      if (batchCancel) break;
      status(`Seite ${n}/${total} wird gescannt …`);
      // Ein Fehlversuch (Gerät belegt, Aufwachen aus dem Ruhezustand) beendet
      // den Stapel nicht mehr: kurz warten und noch zwei Mal versuchen.
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok && !batchCancel; attempt++) {
        try {
          await mod.addPageDirect(await fetchScannedPage());
          ok = true;
        } catch (e) {
          if (attempt === 3) {
            t.update(`Seite ${n} fehlgeschlagen: ${e?.message || e}`, 'err', 6000);
          } else {
            status(`Seite ${n}/${total} – neuer Versuch (${attempt + 1}/3) …`);
            await sleep(2500);
          }
        }
      }
      if (!ok) break;
      status(`Seite ${n}/${total} eingelesen`);
    }

    mod.setScanStatus('');
    mod.showPages();
    const done = mod.pageCount();
    t.update(
      batchCancel ? `Abgebrochen – ${done} Seite${done === 1 ? '' : 'n'} eingelesen`
        : `${done} Seite${done === 1 ? '' : 'n'} eingelesen – jetzt prüfen und übernehmen`,
      'ok', 5000,
    );
  } catch (e) {
    t.update(`Netzwerk-Scan fehlgeschlagen: ${e?.message || e}`, 'err', 6000);
    scanner?.setScanStatus('');
  } finally {
    keepAwakeStop();
    netScanBusy = false;
    batchCancel = false;
    netScanBtn.classList.remove('scanning');
  }
}

/** Vom Scanner aufgerufen, wenn der Benutzer den Stapel abbricht. */
function cancelBatchScan() {
  batchCancel = true;
}

// Beschriftung und Pausenfeld an die eingestellte Seitenzahl anpassen
function syncScanBatchUi() {
  const n = Math.max(1, parseInt($('#scanPages').value, 10) || 1);
  $('#scanDelayWrap').classList.toggle('hidden', n < 2);
  $('#netScanSub').textContent = n > 1
    ? `${n} Seiten automatisch nacheinander scannen – dazwischen bleibt Zeit zum Wechseln`
    : 'Seite von der Glasfläche einlesen – mehrere Seiten sammeln, zuschneiden & bearbeiten';
}
$('#scanPages').addEventListener('input', syncScanBatchUi);

netScanBtn.addEventListener('click', launchNetworkScan);
netScanBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launchNetworkScan(); }
});

// ---------------------------------------------------------------- Komprimieren

async function itemBytes(item) {
  if (item.editedBytes) return item.editedBytes.buffer.slice(item.editedBytes.byteOffset, item.editedBytes.byteOffset + item.editedBytes.byteLength);
  return item.file.arrayBuffer();
}

async function processItem(item, opts) {
  item.result = null;
  refreshItemButtons(item);
  setStatus(item, 'Wird gelesen …');
  const buf = await itemBytes(item);
  const originalSize = buf.byteLength;

  // Seiten-individuelle Einstellungen aus der Vorschau anwenden
  const pageOv = opts.mode !== 'lossless' ? buildPageOverrides(item) : null;
  if (pageOv) opts = { ...opts, pageOverrides: pageOv };

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
  const editedNote = item.editedBytes ? ' (bearbeitet)' : '';
  metaEl.innerHTML = `Vorher: ${fmtSize(originalSize)}${editedNote} → Nachher: <strong>${fmtSize(newSize)}</strong> · ${presetLabel()}`;
  if (newSize < originalSize) {
    setStatus(item, `Fertig – ${(saved * 100).toFixed(1)} % gespart`, 'ok');
  } else {
    setStatus(item, 'Fertig – Ergebnis nicht kleiner als das Original (andere Stufe probieren)', 'warn');
  }
  refreshItemButtons(item);

  if (outputDirHandle && $('#autoSave').checked) {
    await saveItemToDir(item);
  }
  // Direkt weiterreichen, wenn gewünscht – spart am Handy einen Extra-Tipp.
  if (backend.consume && $('#autoPaperless').checked) {
    await saveItemToPaperless(item, { quiet: true });
  }
}

startBtn.addEventListener('click', async () => {
  if (running || items.length === 0) return;
  scanHint.classList.add('hidden');
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

$('#sendAllBtn').addEventListener('click', async () => {
  const ready = items.filter((it) => it.result && !it.sentToPaperless);
  if (ready.length === 0) return;
  const t = toast(`Sende ${ready.length} PDF${ready.length === 1 ? '' : 's'} an Paperless …`, 'busy', 0);
  let ok = 0;
  for (const it of ready) {
    if (await saveItemToPaperless(it, { quiet: true })) ok++;
  }
  t.update(
    ok === ready.length ? `${ok} PDF${ok === 1 ? '' : 's'} an Paperless übergeben` : `${ok} von ${ready.length} übergeben – Rest siehe Liste`,
    ok === ready.length ? 'ok' : 'err',
  );
});

$('#mergeBtn').addEventListener('click', async () => {
  if (running || items.length < 2) return;
  const btn = $('#mergeBtn');
  btn.disabled = true;
  btn.textContent = 'Führe zusammen …';
  try {
    const { PDFDocument } = window.PDFLib;
    const merged = await PDFDocument.create();
    merged.setProducer('PDF Presser (lokal im Browser)');
    for (const it of items) {
      const doc = await PDFDocument.load(await itemBytes(it));
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }
    const bytes = await merged.save({ useObjectStreams: true });
    addFiles([new File([bytes], 'zusammengefuehrt.pdf', { type: 'application/pdf' })]);
  } catch (e) {
    alert(`Zusammenführen fehlgeschlagen: ${e?.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Zu einer PDF zusammenführen';
  }
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
let previewPageNum = 1;
let previewNumPages = 1;

function closePreview() {
  previewCard.classList.add('hidden');
}

// Seiten-individuelle Einstellungen: {seitennummer: {preset, bias}} pro Datei.
// Die Vorschau bearbeitet immer die erste Datei der Liste.
function pageOverrideOpts(item, pageNum) {
  const ov = item?.pageOverrides?.[pageNum];
  if (!ov || !PRESETS[ov.preset]) return null;
  const o = { ...PRESETS[ov.preset] };
  delete o.mode;
  if (o.colorMode === 'bw' || o.colorMode === 'indexed') o.bias = ov.bias || 0;
  // Kontrast und Umgang mit dunklen Flächen gelten global weiter, damit eine
  // Seiten-Ausnahme nicht plötzlich mit anderen Grundeinstellungen rechnet.
  if (o.colorMode === 'bw') {
    o.contrast = parseInt($('#bwContrast').value, 10) || 0;
    o.darkAreas = $('#darkAreas').value || 'auto';
  }
  return o;
}

function buildPageOverrides(item) {
  const map = {};
  for (const n of Object.keys(item.pageOverrides || {})) {
    const o = pageOverrideOpts(item, n);
    if (o) map[n] = o;
  }
  return Object.keys(map).length ? map : null;
}

function syncOverrideUi() {
  const item = items[0];
  const ov = item?.pageOverrides?.[previewPageNum];
  $('#pageOverrideSel').value = ov?.preset || '';
  const isBiased = ov && ['extrem-sw', 'extrem-farbe'].includes(ov.preset);
  $('#pageBiasWrap').classList.toggle('hidden', !isBiased);
  $('#pageBias').value = ov?.bias || 0;
  $('#pageBiasOut').value = ov?.bias || 0;
  const count = Object.keys(item?.pageOverrides || {}).length;
  let summary = count > 0 ? `${count} Seite${count === 1 ? '' : 'n'} mit eigenen Einstellungen` : '';
  if (count > 0 && currentPreset() === 'verlustfrei') {
    summary += ' – wird bei „Verlustfrei“ nicht angewendet';
  }
  $('#overrideSummary').textContent = summary;
}

function syncPreviewNav() {
  previewPageNum = Math.min(Math.max(1, previewPageNum), previewNumPages);
  $('#previewPageInfo').textContent = `${previewPageNum}/${previewNumPages}`;
  $('#prevPageBtn').disabled = previewPageNum <= 1;
  $('#nextPageBtn').disabled = previewPageNum >= previewNumPages;
}

async function refreshPreview() {
  if (previewCard.classList.contains('hidden') || items.length === 0) return;
  if (previewBusy) {
    previewPending = true;
    return;
  }
  previewBusy = true;
  try {
    let opts = currentOptions();
    const lossless = opts.mode === 'lossless';
    if (lossless) {
      opts = { ...opts, mode: 'raster', colorMode: 'color', dpi: 120, quality: 0.9 };
    }
    const override = pageOverrideOpts(items[0], previewPageNum);
    if (override && !lossless) opts = { ...opts, ...override };
    previewInfo.textContent = 'Wird berechnet …';
    const { dataUrl, pageBytes, numPages } = await previewPage(await itemBytes(items[0]), opts, previewPageNum);
    previewNumPages = numPages;
    syncPreviewNav();
    syncOverrideUi();
    previewImg.src = dataUrl;
    if (lossless) {
      previewInfo.textContent = 'Verlustfrei ändert das Aussehen nicht – Vorschau zeigt das Original.';
    } else {
      const label = override ? 'eigene Seiten-Einstellung' : presetLabel();
      previewInfo.textContent = `${items[0].file.name} · Seite ${previewPageNum}/${numPages} · ≈ ${fmtSize(pageBytes)} für diese Seite (${label})`;
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
$('#prevPageBtn').addEventListener('click', () => {
  if (previewPageNum > 1) { previewPageNum--; syncPreviewNav(); syncOverrideUi(); refreshPreview(); }
});
$('#nextPageBtn').addEventListener('click', () => {
  if (previewPageNum < previewNumPages) { previewPageNum++; syncPreviewNav(); syncOverrideUi(); refreshPreview(); }
});
$('#pageOverrideSel').addEventListener('change', () => {
  const item = items[0];
  if (!item) return;
  item.pageOverrides = item.pageOverrides || {};
  const preset = $('#pageOverrideSel').value;
  if (preset) {
    const prev = item.pageOverrides[previewPageNum];
    item.pageOverrides[previewPageNum] = { preset, bias: prev?.bias || 0 };
  } else {
    delete item.pageOverrides[previewPageNum];
  }
  syncOverrideUi();
  refreshPreview();
});
$('#pageBias').addEventListener('input', () => {
  const item = items[0];
  const ov = item?.pageOverrides?.[previewPageNum];
  if (!ov) return;
  ov.bias = parseInt($('#pageBias').value, 10) || 0;
  $('#pageBiasOut').value = ov.bias;
  schedulePreviewRefresh();
});

// ---------------------------------------------------------------- Simulation

async function runSimulation(item) {
  const box = item.el.querySelector('.sim-results');
  const btn = item.el.querySelector('.btn-simulate');
  box.classList.remove('hidden');
  btn.disabled = true;
  box.innerHTML = '<em>Simulation läuft …</em>';
  try {
    const buf = await itemBytes(item);
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
      st.textContent += ` · gespeichert in „${outputDirHandle.name}“`;
    }
  } catch (e) {
    setStatus(item, `Speichern im Zielordner fehlgeschlagen: ${e?.message || e}`, 'err');
  }
}

// ---------------------------------------------------------------- An Paperless/NAS senden (Backend)

async function saveItemToPaperless(item, { quiet = false } = {}) {
  if (!item.result || !backend.consume) return false;
  const btn = item.el.querySelector('.btn-paperless');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.innerHTML = `${icon('spinner', { size: 15 })} Sende …`;
  const t = quiet ? null : toast(`„${item.outName}“ wird übergeben …`, 'busy', 0);
  try {
    const res = await fetch(`/api/save?name=${encodeURIComponent(item.outName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: item.result,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    item.sentToPaperless = true;
    const st = item.el.querySelector('.file-status');
    if (!st.textContent.includes('Paperless')) {
      st.textContent += ' · an Paperless übergeben';
      st.classList.add('ok');
    }
    btn.classList.remove('busy');
    btn.innerHTML = `${icon('check', { size: 15 })} übergeben`;
    t?.update(`„${item.outName}“ an Paperless übergeben`, 'ok');
    return true;
  } catch (e) {
    const msg = `An Paperless senden fehlgeschlagen: ${e?.message || e}`;
    setStatus(item, msg, 'err');
    btn.classList.remove('busy');
    btn.innerHTML = `${icon('upload', { size: 15 })} An Paperless`;
    btn.disabled = false;
    t?.update(msg, 'err', 5000);
    if (quiet) toast(msg, 'err', 5000);
    return false;
  }
}

// Backend-Fähigkeiten abfragen und passende Bedienelemente einblenden.
async function detectBackend() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = await res.json();
    backend.scanner = !!cfg.scanner;
    backend.consume = !!cfg.consume;
    backend.profile = !!cfg.profile;
  } catch { /* kein Backend (z. B. GitHub Pages) – Funktionen bleiben aus */ }

  if (backend.scanner) {
    netScanBtn.classList.remove('hidden');
    $('#netScanSettings').classList.remove('hidden');
    syncScanBatchUi();
    // Auch im PDF-Editor lassen sich damit später Seiten nachscannen
    setScanProvider(fetchScannedPage);
    document.querySelector('.source-row')?.classList.add('has-net');
  }
  if (backend.consume) {
    $('#autoPaperlessField').classList.remove('hidden');
    items.forEach(refreshItemButtons);
  }
  if (backend.profile) {
    // Einstellungen & Unterschriften liegen zusätzlich auf dem eigenen Server.
    $('#syncRow').classList.remove('hidden');
    enableServerProfile(true);
    await pullServerProfile();
    await applyStoredSettings();
  }
  updateActions();
}

// Status des Server-Speichers in der Seitenleiste spiegeln
onSyncStatus((state, text) => {
  const row = $('#syncRow');
  if (!row || row.classList.contains('hidden')) return;
  row.classList.toggle('syncing', state === 'syncing');
  $('#syncInfo').textContent = text;
});

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

// ---------------------------------------------------------------- Meine Daten

$('#exportDataBtn').addEventListener('click', async () => {
  const blob = await exportAllData();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pdfpresser-daten.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('#importDataBtn').addEventListener('click', () => $('#importDataInput').click());
$('#importDataInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const info = $('#dataInfo');
  info.classList.remove('hidden');
  try {
    const res = await importAllData(await file.text());
    info.textContent = `Import erfolgreich: ${res.signatures} Unterschrift(en) übernommen.`;
    applyStoredSettings();
  } catch (err) {
    info.textContent = `Import fehlgeschlagen: ${err?.message || err}`;
  }
});

// Einstellungen dauerhaft lokal speichern & wiederherstellen
function collectSettings() {
  return {
    preset: currentPreset(),
    colorMode: $('#colorMode').value,
    dpi: $('#dpi').value,
    quality: $('#quality').value,
    bwBias: $('#bwBias').value,
    bwContrast: $('#bwContrast').value,
    darkAreas: $('#darkAreas').value,
    scanDpi: $('#scanDpi').value,
    scanColor: $('#scanColor').value,
    scanPages: $('#scanPages').value,
    scanDelay: $('#scanDelay').value,
    extremeDpi: $('#extremeDpi').value,
    ocr: ocrEnabled.checked,
    ocrLang: $('#ocrLang').value,
    autoSave: $('#autoSave').checked,
    autoPaperless: $('#autoPaperless').checked,
  };
}
let settingsReady = false;
function persistSettings() {
  if (settingsReady) saveSettings(collectSettings());
}
async function applyStoredSettings() {
  try {
    const s = await loadSettings();
    if (s.preset && document.querySelector(`input[name="preset"][value="${s.preset}"]`)) {
      document.querySelector(`input[name="preset"][value="${s.preset}"]`).checked = true;
    }
    if (s.colorMode) $('#colorMode').value = s.colorMode;
    if (s.dpi) { $('#dpi').value = s.dpi; $('#dpiOut').value = s.dpi; }
    if (s.quality) { $('#quality').value = s.quality; $('#qualityOut').value = s.quality; }
    if (s.bwBias != null) { $('#bwBias').value = s.bwBias; $('#bwBiasOut').value = s.bwBias; }
    if (s.bwContrast != null) { $('#bwContrast').value = s.bwContrast; $('#bwContrastOut').value = s.bwContrast; }
    if (s.darkAreas) $('#darkAreas').value = s.darkAreas;
    if (s.scanDpi) $('#scanDpi').value = s.scanDpi;
    if (s.scanColor) $('#scanColor').value = s.scanColor;
    if (s.scanPages) $('#scanPages').value = s.scanPages;
    if (s.scanDelay != null) $('#scanDelay').value = s.scanDelay;
    if (s.extremeDpi != null) $('#extremeDpi').value = s.extremeDpi;
    if (s.ocr != null) ocrEnabled.checked = s.ocr;
    if (s.ocrLang) $('#ocrLang').value = s.ocrLang;
    if (s.autoSave != null) $('#autoSave').checked = s.autoSave;
    if (s.autoPaperless != null) $('#autoPaperless').checked = s.autoPaperless;
  } catch { /* Erststart */ }
  settingsReady = true;
  syncSettingsUi();
}
document.querySelectorAll('input[name="preset"], #colorMode, #dpi, #quality, #bwBias, #bwContrast, #darkAreas, #scanDpi, #scanColor, #scanPages, #scanDelay, #extremeDpi, #ocrEnabled, #ocrLang, #autoSave, #autoPaperless')
  .forEach((el) => el.addEventListener('change', persistSettings));
applyStoredSettings();
requestPersistence();
// Backend erst danach abfragen: ein evtl. vorhandenes Serverprofil überschreibt
// die lokalen Einstellungen und wendet sie erneut an.
detectBackend();

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

  // Nach einem App-Update einmal automatisch neu laden, damit nie alte und
  // neue Dateien gemischt laufen (außer mitten in einer Kompression).
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !running && !window.__reloadedForUpdate) {
      window.__reloadedForUpdate = true;
      location.reload();
    }
    hadController = true;
  });
}

// Für die automatisierten Tests
window.__pdfpresser = {
  compressPdf, previewPage, simulatePdf, PRESETS, items,
  setOutputDir, saveItemToDir, importFromDirHandle,
  saveItemToPaperless, detectBackend, backend, toast, fetchScannedPage,
  exportAllData, importAllData, itemBytes,
};
