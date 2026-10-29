// PDF Presser 2 – App-Logik.
//
// Ein Dokument ist hier die zentrale Einheit: Es kommt aus einer PDF, aus
// Fotos/Bildern (über das Scan-Studio) oder vom Netzwerk-Scanner, trägt sein
// eigenes Kompressionsprofil samt Feinabstimmung, und hat genau ein Ergebnis.
// Alles, was man mit dem Ergebnis tun kann (Vorschau, im Browser öffnen,
// teilen, herunterladen, an Paperless senden), hängt am Dokument.

import {
  compressPdf, previewPage, simulateVariants, simulatePdf, PRESETS, PRESET_INFO, presetName,
  countPages, renderPageImage,
} from './compressor.js';
import { openEditor, setScanProvider } from './editor.js';
import {
  exportAllData, importAllData, loadSettings, saveSettings, requestPersistence,
  enableServerProfile, pullServerProfile, onSyncStatus, kvGet, kvSet, kvDel,
} from './store.js';
import { hydrateIcons, icon } from './icons.js';
import {
  $, $$, toast, dialog, confirmDialog, fmtSize, fmtPct, escapeHtml, plural, sleep,
  downloadBytes, openInBrowser, canShareFiles, shareBytes,
} from './ui.js';
import { mergePdfs } from './pdfkit.js';

const APP_VERSION = '2.1.0';

hydrateIcons();

// ---------------------------------------------------------------- Zustand

const DEFAULTS = {
  v: 2,
  scanProfile: 'extrem-sw',
  pdfProfile: 'mittel',
  scanOcr: true,
  pdfOcr: false,
  ocrLang: 'deu',
  a4: true,
  autoCompress: false,
  autoPaperless: false,
  scanCorner: 'tl',
  scanOffX: 0,
  scanOffY: 0,
  scanDpi: '300',
  scanColor: 'color',
  scanPages: 1,
  scanDelay: 8,
  scanTarget: 'doc',
  scanRect: null,        // kalibrierter A4-Bereich in mm {x, y, w}
};

let settings = { ...DEFAULTS };
const backend = { scanner: false, consume: false, paperless: null, profile: false, raw: false, jobs: false, settings: false, version: null, appVersion: null };
const state = {
  docs: [],
  selectedId: null,
  view: 'docs',
  outDir: null,
  updateReady: false,
};
const isNarrow = () => matchMedia('(max-width: 1180px)').matches;
const isFinePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const hasFsAccess = typeof window.showDirectoryPicker === 'function';

let docSeq = 0;
const NEUTRAL_TUNE = { dpi: '', quality: '', bias: 0, contrast: 0, darkAreas: 'auto' };

// ---------------------------------------------------------------- Optionen je Dokument

/** Vollständige Kompressionsoptionen eines Dokuments (optional für ein anderes Profil). */
function optsFor(doc, key = doc.profile) {
  const preset = PRESETS[key] || PRESETS.mittel;
  if (preset.mode === 'lossless') return { mode: 'lossless', a4: !!doc.a4 };
  const o = { ...preset, a4: !!doc.a4 };
  const t = doc.tune;
  // Auflösung/Qualität gehören zum gewählten Profil – andere Profile rechnen
  // mit ihren eigenen Standardwerten (so stimmt auch die Simulation).
  if (key === doc.profile) {
    if (t.dpi) o.dpi = parseInt(t.dpi, 10);
    if (t.quality && (o.colorMode === 'color' || o.colorMode === 'gray')) o.quality = parseInt(t.quality, 10) / 100;
  }
  const tuneFor = (x) => {
    if (x.colorMode === 'bw' || x.colorMode === 'indexed') x.bias = t.bias | 0;
    if (x.colorMode === 'bw') { x.contrast = t.contrast | 0; x.darkAreas = t.darkAreas || 'auto'; }
    return x;
  };
  tuneFor(o);
  const ov = {};
  for (const [n, k] of Object.entries(doc.pageProfiles || {})) {
    const p = PRESETS[k];
    if (!p || p.mode === 'lossless') continue;
    const { mode, ...rest } = p;
    ov[n] = tuneFor({ ...rest });
  }
  if (Object.keys(ov).length) o.pageOverrides = ov;
  if (doc.ocr) { o.ocr = true; o.ocrLang = settings.ocrLang || 'deu'; }
  return o;
}

const sigFor = (doc) => `${doc.rev}|${JSON.stringify(optsFor(doc))}`;
const simSigFor = (doc) => `${doc.rev}|${doc.a4}|${doc.profile}|${JSON.stringify(doc.tune)}|${JSON.stringify(doc.pageProfiles)}`;
const hasFresh = (doc) => !!doc.result && doc.resultSig === sigFor(doc);
const isStale = (doc) => !!doc.result && doc.resultSig !== sigFor(doc);
const outName = (doc) => `${doc.name || 'Dokument'}.pdf`;

function cleanName(name) {
  return String(name || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || 'Dokument';
}

function stampName(prefix = 'Scan') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

function newDoc(bytes, name, { kind = 'pdf', rawSources = null } = {}) {
  const isScan = kind === 'scan';
  return {
    id: `d${++docSeq}`,
    name: cleanName(name),
    bytes,
    rev: 1,
    kind,
    edited: false,
    rawSources,
    pages: 0,
    thumb: null,
    profile: isScan ? settings.scanProfile : settings.pdfProfile,
    ocr: isScan ? !!settings.scanOcr : !!settings.pdfOcr,
    a4: !!settings.a4,
    tune: { ...NEUTRAL_TUNE },
    pageProfiles: {},
    result: null,
    resultSig: null,
    status: 'idle',
    progress: 0,
    message: '',
    sim: null,
    sent: false,
    savedDir: false,
    delivered: false,
  };
}

const docById = (id) => state.docs.find((d) => d.id === id);
const selected = () => docById(state.selectedId);

// ---------------------------------------------------------------- Dokumente merken
//
// Die Liste überlebt Schließen, Neuladen und Updates: jedes Dokument liegt mit
// Original und Ergebnis in IndexedDB (nur auf diesem Gerät). Geschrieben wird
// nur, was sich geändert hat.

const PERSIST_FIELDS = ['id', 'name', 'kind', 'edited', 'rawSources', 'pages', 'thumb', 'profile', 'ocr', 'ocrAuto', 'a4',
  'tune', 'pageProfiles', 'resultSig', 'sent', 'savedDir', 'delivered', 'rev', 'rawCleaned'];
const savedSig = new Map();   // id -> Signatur des gespeicherten Stands
let saveTimer = null;
let docsRestored = false;

const persistSig = (d) => JSON.stringify([...PERSIST_FIELDS.filter((k) => k !== 'thumb').map((k) => d[k]), d.bytes.length, d.result?.length || 0, !!d.thumb]);

function scheduleSaveDocs() {
  if (!docsRestored) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDocsNow().catch((e) => console.warn('Dokumente nicht gespeichert:', e)), 700);
}

async function saveDocsNow() {
  if (!docsRestored) return;
  clearTimeout(saveTimer);
  const ids = state.docs.map((d) => d.id);
  for (const d of state.docs) {
    const sig = persistSig(d);
    if (savedSig.get(d.id) === sig) continue;
    const rec = Object.fromEntries(PERSIST_FIELDS.map((k) => [k, d[k]]));
    rec.bytes = d.bytes;
    rec.result = d.result || null;
    await kvSet(`doc:${d.id}`, rec);
    savedSig.set(d.id, sig);
  }
  for (const id of [...savedSig.keys()]) {
    if (!ids.includes(id)) {
      await kvDel(`doc:${id}`);
      savedSig.delete(id);
    }
  }
  await kvSet('docs', { ids, seq: docSeq, selected: state.selectedId });
}

async function restoreDocs() {
  try {
    const list = await kvGet('docs');
    if (!list?.ids?.length) return;
    docSeq = Math.max(docSeq, list.seq || 0);
    for (const id of list.ids) {
      const rec = await kvGet(`doc:${id}`);
      if (!rec?.bytes) continue;
      const d = newDoc(rec.bytes, rec.name, { kind: rec.kind });
      for (const k of PERSIST_FIELDS) if (rec[k] !== undefined) d[k] = rec[k];
      d.tune = { ...NEUTRAL_TUNE, ...(rec.tune || {}) };
      d.pageProfiles = rec.pageProfiles || {};
      d.result = rec.result || null;
      d.status = d.result ? 'done' : 'idle';
      d.message = '';
      d.progress = d.result ? 1 : 0;
      state.docs.push(d);
      savedSig.set(d.id, persistSig(d));
      const n = parseInt(String(d.id).slice(1), 10);
      if (n > docSeq) docSeq = n;
    }
    if (list.selected && docById(list.selected)) state.selectedId = list.selected;
  } catch (e) {
    console.warn('Gespeicherte Dokumente nicht lesbar:', e);
  } finally {
    docsRestored = true;
  }
}

// ---------------------------------------------------------------- Dokumente hinzufügen

const isPdfFile = (f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';
const isImageFile = (f) => /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/i.test(f.name || '');

/** Beliebige Dateien: PDFs werden Dokumente, Bilder gehen ins Scan-Studio. */
async function addFiles(fileList) {
  const files = [...fileList];
  const pdfs = files.filter(isPdfFile);
  const images = files.filter((f) => !isPdfFile(f) && isImageFile(f));
  const skipped = files.length - pdfs.length - images.length;
  for (const f of pdfs) {
    await addPdfDoc(new Uint8Array(await f.arrayBuffer()), f.name, { kind: 'pdf' });
  }
  if (images.length) await openStudio({ files: images });
  if (skipped) toast(`${plural(skipped, 'Datei', 'Dateien')} übersprungen – nur PDFs und Bilder`, 'info', 4000);
}

/** Fertiges PDF als neues Dokument in die Liste. */
async function addPdfDoc(bytes, name, opts = {}) {
  const doc = newDoc(bytes, name, opts);
  state.docs.push(doc);
  state.selectedId = doc.id;
  renderAll();
  try {
    doc.pages = await countPages(bytes);
    doc.thumb = (await renderPageImage(bytes, 1, 180)).url;
  } catch (e) {
    doc.status = 'error';
    doc.message = /password|encrypt/i.test(String(e?.name || e?.message || e))
      ? 'PDF ist passwortgeschützt – bitte erst entsperren'
      : `PDF nicht lesbar: ${e?.message || e}`;
  }
  renderDoc(doc);
  renderToolbar();
  if (state.selectedId === doc.id) renderInspector();
  if (doc.status !== 'error') {
    if (settings.autoCompress) enqueue(doc);
    else maybeAutoSimulate(doc);
  }
  return doc;
}

function removeDoc(doc) {
  if (doc.abort) doc.abort.aborted = true;
  if (doc.simAbort) doc.simAbort.aborted = true;
  const qi = queue.indexOf(doc);
  if (qi >= 0) queue.splice(qi, 1);
  state.docs.splice(state.docs.indexOf(doc), 1);
  if (state.selectedId === doc.id) {
    state.selectedId = state.docs[state.docs.length - 1]?.id || null;
    closeInspectorDrawer();
  }
  renderAll();
}

// ---------------------------------------------------------------- Komprimieren (Warteschlange)

const queue = [];
let working = null;

function enqueue(doc) {
  if (!doc || doc.status === 'working' || queue.includes(doc) || doc.status === 'error' && !doc.pages) return;
  if (doc.simAbort) doc.simAbort.aborted = true;   // Simulation weicht der echten Arbeit
  doc.status = 'queued';
  doc.message = working ? 'Wartet …' : '';
  doc.progress = 0;
  queue.push(doc);
  renderDoc(doc);
  if (doc.id === state.selectedId) renderInspector();
  pump();
}

function progressText(p) {
  if (p.phase === 'save') return 'PDF wird geschrieben …';
  if (p.phase === 'optimize') return 'Wird optimiert …';
  const parts = [];
  if (p.pages) parts.push(`Seite ${Math.min(p.pages, (p.rendered || 0) + (p.phase === 'render' && p.rendered < p.pages ? 1 : 0))}/${p.pages}`);
  if (p.recognized != null && p.recognized > 0) parts.push(`Text ${p.recognized}/${p.pages}`);
  return parts.join(' · ') || 'Wird verarbeitet …';
}

async function pump() {
  if (working) return;
  while (queue.length) {
    const doc = queue.shift();
    working = doc;
    doc.status = 'working';
    doc.progress = 0.02;
    doc.message = doc.ocr ? 'Startet – Texterkennung wird geladen …' : 'Startet …';
    doc.abort = { aborted: false };
    renderDoc(doc);
    if (doc.id === state.selectedId) renderInspector();
    const sig = sigFor(doc);
    const t0 = performance.now();
    try {
      const opts = optsFor(doc);
      let out = await compressPdf(doc.bytes, opts, (p) => {
        doc.progress = p.frac ?? doc.progress;
        doc.message = progressText(p);
        updateProgress(doc);
      }, doc.abort);
      // Reine Text-/Vektor-PDFs werden durchs Rastern oft größer. Ohne
      // Texterkennung lohnt sich dann die verlustfreie Optimierung mehr –
      // die kleinere Fassung gewinnt.
      let fellBack = false;
      if (opts.mode !== 'lossless' && !opts.ocr && out.length >= doc.bytes.length) {
        const alt = await compressPdf(doc.bytes, { mode: 'lossless', a4: opts.a4 });
        if (alt.length < out.length) { out = alt; fellBack = true; }
      }
      doc.result = out;
      doc.resultSig = sig;
      doc.status = 'done';
      doc.sent = false;
      doc.savedDir = false;
      doc.delivered = false;
      doc.progress = 1;
      const secs = (performance.now() - t0) / 1000;
      doc.message = fellBack
        ? 'Schon optimal: verlustfrei optimiert (Rastern wäre größer)'
        : out.length < doc.bytes.length
          ? `Fertig in ${secs.toFixed(secs < 10 ? 1 : 0).replace('.', ',')} s`
          : 'Fertig – nicht kleiner als vorher (anderes Profil probieren)';
      renderDoc(doc);
      if (doc.id === state.selectedId) renderInspector();
      if (state.outDir) await saveToDir(doc, { quiet: true });
      if (backend.consume && settings.autoPaperless) await sendToPaperless(doc, { quiet: true });
    } catch (e) {
      if (e?.name === 'AbortError') {
        doc.status = 'idle';
        doc.message = 'Abgebrochen';
      } else {
        console.error(e);
        doc.status = 'error';
        doc.message = /password|encrypt/i.test(String(e)) ? 'PDF ist passwortgeschützt/verschlüsselt' : `Fehler: ${e?.message || e}`;
      }
      doc.progress = 0;
    } finally {
      doc.abort = null;
      working = null;
    }
    if (state.docs.includes(doc)) {
      renderDoc(doc);
      if (doc.id === state.selectedId) renderInspector();
    }
  }
  renderToolbar();
}

function cancelDoc(doc) {
  const qi = queue.indexOf(doc);
  if (qi >= 0) {
    queue.splice(qi, 1);
    doc.status = 'idle';
    doc.message = '';
  }
  if (doc.abort) doc.abort.aborted = true;
  renderDoc(doc);
  if (doc.id === state.selectedId) renderInspector();
}

// ---------------------------------------------------------------- Ergebnis weitergeben

function resultOrToast(doc) {
  if (hasFresh(doc)) return doc.result;
  toast(doc.result ? 'Einstellungen geändert – bitte erneut komprimieren' : 'Bitte zuerst komprimieren', 'info');
  return null;
}

function downloadDoc(doc) {
  const bytes = resultOrToast(doc);
  if (!bytes) return;
  downloadBytes(bytes, outName(doc));
  doc.delivered = true;
}

function openDoc(doc, original = false) {
  const bytes = original ? doc.bytes : resultOrToast(doc);
  if (!bytes) return;
  openInBrowser(bytes, original ? `${doc.name} (Original).pdf` : outName(doc));
  if (!original) doc.delivered = true;
}

async function shareDoc(doc) {
  const bytes = resultOrToast(doc);
  if (!bytes) return;
  try {
    const r = await shareBytes(bytes, outName(doc));
    if (r === 'unsupported') {
      downloadBytes(bytes, outName(doc));
      toast('Teilen kann dieser Browser nicht – die Datei wurde heruntergeladen', 'info', 4500);
    }
    if (r !== 'aborted') doc.delivered = true;
  } catch (e) {
    toast(`Teilen fehlgeschlagen: ${e?.message || e}`, 'err', 5000);
  }
}

async function sendToPaperless(doc, { quiet = false } = {}) {
  if (!backend.consume) return false;
  const bytes = quiet ? (hasFresh(doc) ? doc.result : null) : resultOrToast(doc);
  if (!bytes) return false;
  doc.sending = true;
  renderDoc(doc);
  if (doc.id === state.selectedId) renderInspector();
  const t = quiet ? null : toast(`„${doc.name}“ wird an Paperless übergeben …`, 'busy', 0);
  try {
    const res = await fetch(`/api/save?name=${encodeURIComponent(outName(doc))}&title=${encodeURIComponent(doc.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    doc.sent = true;
    doc.delivered = true;
    const msg = data.warning ? `An Paperless übergeben (${data.warning})` : `„${doc.name}“ ist bei Paperless`;
    if (t) t.update(msg, data.warning ? 'info' : 'ok', 4000);
    else toast(msg, data.warning ? 'info' : 'ok', 3500);
    await offerRawCleanup(doc);
    return true;
  } catch (e) {
    const msg = `An Paperless senden fehlgeschlagen: ${e?.message || e}`;
    if (t) t.update(msg, 'err', 6000); else toast(msg, 'err', 6000);
    return false;
  } finally {
    doc.sending = false;
    if (state.docs.includes(doc)) {
      renderDoc(doc);
      if (doc.id === state.selectedId) renderInspector();
    }
  }
}

/** Kam das Dokument aus dem Sammelordner: Rohdateien nach der Übergabe aufräumen? */
async function offerRawCleanup(doc) {
  const sources = doc.rawSources;
  if (!backend.raw || !sources?.length || doc.rawCleaned) return;
  doc.rawCleaned = true;   // nur einmal fragen
  const what = sources.length === 1 ? `„${sources[0]}“` : plural(sources.length, 'Rohdatei', 'Rohdateien');
  const ok = await confirmDialog('Sammelordner aufräumen?', `„${doc.name}“ liegt jetzt bei Paperless.\n${what} im Sammelordner löschen?`, 'Löschen', 'danger');
  if (!ok) return;
  const prep = await import('./prepare.js');
  const n = await prep.deleteFiles(sources);
  toast(`${plural(n, 'Datei', 'Dateien')} aus dem Sammelordner gelöscht`, 'ok');
}

async function saveToDir(doc, { quiet = false } = {}) {
  if (!state.outDir || !hasFresh(doc)) return false;
  try {
    const fh = await state.outDir.getFileHandle(outName(doc), { create: true });
    const w = await fh.createWritable();
    await w.write(doc.result);
    await w.close();
    doc.savedDir = true;
    doc.delivered = true;
    if (!quiet) toast(`In „${state.outDir.name}“ gespeichert`, 'ok');
    renderDoc(doc);
    if (doc.id === state.selectedId) renderInspector();
    return true;
  } catch (e) {
    toast(`Speichern im Zielordner fehlgeschlagen: ${e?.message || e}`, 'err', 5000);
    return false;
  }
}

// ---------------------------------------------------------------- Simulation

function maybeAutoSimulate(doc) {
  // Am Rechner gleich im Hintergrund schätzen; am Handy nur auf Wunsch (Akku).
  if (!isFinePointer() || doc.status === 'working' || doc.status === 'queued' || !doc.pages) return;
  if (doc.sim && doc.sim.sig === simSigFor(doc)) return;
  clearTimeout(doc.simTimer);
  doc.simTimer = setTimeout(() => { if (state.docs.includes(doc) && !working) runSimulation(doc); }, 700);
}

async function runSimulation(doc) {
  if (!doc.pages || doc.sim?.running) return;
  const sig = simSigFor(doc);
  doc.sim = { sig, sizes: doc.sim?.sizes || {}, running: true, frac: 0, estimated: false };
  doc.simAbort = { aborted: false };
  if (doc.id === state.selectedId) renderInspector();
  const variants = PRESET_INFO.map(({ key }) => ({ key, opts: { ...optsFor(doc, key), ocr: false } }));
  try {
    const r = await simulateVariants(doc.bytes, variants, (p) => {
      doc.sim.frac = p.frac;
      const bar = doc.id === state.selectedId && $('#inspSimBar > div');
      if (bar) bar.style.width = `${Math.round(p.frac * 100)}%`;
    }, doc.simAbort);
    doc.sim = { sig, sizes: r.sizes, running: false, frac: 1, estimated: r.estimated, sampled: r.sampledPages };
  } catch (e) {
    doc.sim = e?.name === 'AbortError' ? null : { sig, sizes: {}, running: false, error: e?.message || String(e) };
  } finally {
    doc.simAbort = null;
  }
  if (doc.id === state.selectedId && state.docs.includes(doc)) renderInspector();
}

// ---------------------------------------------------------------- Darstellung: Liste

const docListEl = $('#docList');

function docTags(d) {
  const tags = [`<span class="chip chip-accent">${escapeHtml(presetName(d.profile))}</span>`];
  if (d.ocr && PRESETS[d.profile]?.mode !== 'lossless') tags.push(`<span class="chip">${icon('text_search', { size: 13 })}Text</span>`);
  if (d.a4) tags.push('<span class="chip">A4</span>');
  if (d.kind === 'scan') tags.push(`<span class="chip">${icon('scanFrame', { size: 13 })}Scan</span>`);
  if (d.edited) tags.push(`<span class="chip">${icon('pen', { size: 13 })}bearbeitet</span>`);
  if (Object.keys(d.pageProfiles).length) tags.push(`<span class="chip">${plural(Object.keys(d.pageProfiles).length, 'Seitenausnahme', 'Seitenausnahmen')}</span>`);
  if (isStale(d)) tags.push('<span class="chip chip-warn">geändert</span>');
  if (d.sent) tags.push(`<span class="chip chip-ok">${icon('check', { size: 13 })}Paperless</span>`);
  if (d.savedDir) tags.push(`<span class="chip chip-ok">${icon('folder', { size: 13 })}Ordner</span>`);
  return tags.join('');
}

function docMeta(d) {
  let s = d.pages ? `${plural(d.pages, 'Seite', 'Seiten')} · ` : '';
  s += fmtSize(d.bytes.length);
  if (hasFresh(d)) {
    const better = d.result.length < d.bytes.length;
    s += ` → <b>${fmtSize(d.result.length)}</b> <span class="${better ? 'save' : ''}">${fmtPct(d.bytes.length, d.result.length)}</span>`;
  }
  return s;
}

/** Der jeweils sinnvolle nächste Schritt als Knopf an der Karte. */
function primaryAction(d) {
  if (d.status === 'working' || d.status === 'queued') return { act: 'cancel', label: 'Stopp', icon: 'stop', cls: '' };
  if (d.status === 'error' && !d.pages) return null;
  if (!hasFresh(d)) return { act: 'compress', label: d.result ? 'Erneut' : 'Komprimieren', icon: 'archive', cls: 'btn-primary' };
  if (backend.consume && !d.sent) return { act: 'paperless', label: d.sending ? 'Sende …' : 'Paperless', icon: d.sending ? 'spinner' : 'send', cls: 'btn-primary', busy: d.sending };
  if (canShareFiles()) return { act: 'share', label: 'Teilen', icon: 'share', cls: '' };
  return { act: 'download', label: 'Laden', icon: 'download', cls: '' };
}

function docCardHtml(d) {
  const a = primaryAction(d);
  const busy = d.status === 'working' || d.status === 'queued';
  return `
    <div class="doc-thumb">${d.thumb ? `<img src="${d.thumb}" alt="">` : icon('doc', { size: 26 })}${d.pages ? `<span class="doc-badge">${d.pages}</span>` : ''}</div>
    <div class="doc-body">
      <div class="doc-title">${escapeHtml(outName(d))}</div>
      <div class="doc-meta">${docMeta(d)}</div>
      <div class="doc-tags">${docTags(d)}</div>
      <div class="progress ${busy ? '' : 'hidden'}"><div style="width:${Math.round(d.progress * 100)}%"></div></div>
      <div class="doc-status ${d.status === 'error' ? 'err' : ''}">${escapeHtml(d.message)}</div>
    </div>
    <div class="doc-actions">${a ? `<button class="btn btn-small ${a.cls} ${a.busy ? 'busy' : ''}" data-act="${a.act}">${icon(a.icon, { size: 16 })}<span>${a.label}</span></button>` : ''}</div>`;
}

function renderDoc(d) {
  let el = docListEl.querySelector(`[data-id="${d.id}"]`);
  if (!state.docs.includes(d)) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('article');
    el.className = 'doc';
    el.dataset.id = d.id;
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;
    docListEl.appendChild(el);
  }
  el.innerHTML = docCardHtml(d);
  el.classList.toggle('selected', d.id === state.selectedId);
  scheduleSaveDocs();
}

function updateProgress(d) {
  const el = docListEl.querySelector(`[data-id="${d.id}"]`);
  if (el) {
    const bar = el.querySelector('.progress');
    bar?.classList.remove('hidden');
    const fill = el.querySelector('.progress > div');
    if (fill) fill.style.width = `${Math.round(d.progress * 100)}%`;
    const st = el.querySelector('.doc-status');
    if (st) st.textContent = d.message;
  }
  if (d.id === state.selectedId) {
    const f = $('#inspProgress > div');
    if (f) f.style.width = `${Math.round(d.progress * 100)}%`;
    const st = $('#inspStatus');
    if (st) st.textContent = d.message;
  }
}

function renderList() {
  scheduleSaveDocs();
  // Reihenfolge der Karten an die Liste anpassen, Überzählige entfernen
  const ids = new Set(state.docs.map((d) => d.id));
  docListEl.querySelectorAll('.doc').forEach((el) => { if (!ids.has(el.dataset.id)) el.remove(); });
  state.docs.forEach((d) => {
    renderDoc(d);
    docListEl.appendChild(docListEl.querySelector(`[data-id="${d.id}"]`));
  });
  $('#emptyState').classList.toggle('hidden', state.docs.length > 0);
  $('#navDocCount').textContent = state.docs.length || '';
  const n = state.docs.length;
  const done = state.docs.filter(hasFresh);
  $('#docsSub').textContent = n === 0
    ? 'Komprimieren · DIN A4 · Texterkennung · Paperless'
    : `${plural(n, 'Dokument', 'Dokumente')}${done.length ? ` · ${done.length} fertig` : ''}`;
}

function renderToolbar() {
  const n = state.docs.length;
  const todo = state.docs.filter((d) => !hasFresh(d) && d.status !== 'working' && d.status !== 'queued' && d.pages);
  $('#compressAllBtn').classList.toggle('hidden', todo.length < (n > 1 ? 1 : 2));
  $('#compressAllBtn span').textContent = todo.length === n ? 'Alle komprimieren' : `${todo.length} komprimieren`;
  $('#moreBtn').classList.toggle('hidden', n === 0);
  // Button-Gruppe: sichtbare Ränder neu setzen
  const btns = $$('.add-group .btn').filter((b) => !b.classList.contains('hidden') && getComputedStyle(b).display !== 'none');
  $$('.add-group .btn').forEach((b) => b.classList.remove('first-visible', 'last-visible'));
  btns[0]?.classList.add('first-visible');
  btns[btns.length - 1]?.classList.add('last-visible');
}

function renderAll() {
  renderList();
  renderToolbar();
  renderInspector();
}

// Klicks in der Liste
docListEl.addEventListener('click', (e) => {
  const card = e.target.closest('.doc');
  if (!card) return;
  const doc = docById(card.dataset.id);
  if (!doc) return;
  const btn = e.target.closest('[data-act]');
  if (btn) {
    e.stopPropagation();
    runAction(doc, btn.dataset.act);
    return;
  }
  selectDoc(doc, true);
});
docListEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.doc');
  if (!card || e.target !== card) return;
  e.preventDefault();
  selectDoc(docById(card.dataset.id), true);
});

function selectDoc(doc, openDrawer = false) {
  if (!doc) return;
  const changed = state.selectedId !== doc.id;
  state.selectedId = doc.id;
  docListEl.querySelectorAll('.doc').forEach((el) => el.classList.toggle('selected', el.dataset.id === doc.id));
  if (changed) $('#inspector').scrollTop = 0;
  renderInspector();
  if (openDrawer && isNarrow()) openInspectorDrawer();
  maybeAutoSimulate(doc);
}

function runAction(doc, act) {
  switch (act) {
    case 'compress': enqueue(doc); break;
    case 'cancel': cancelDoc(doc); break;
    case 'paperless': sendToPaperless(doc); break;
    case 'share': shareDoc(doc); break;
    case 'download': downloadDoc(doc); break;
    case 'open': openDoc(doc); break;
    case 'openOriginal': openDoc(doc, true); break;
    case 'folder': saveToDir(doc); break;
    case 'preview': openViewer(doc, hasFresh(doc) ? 'result' : 'preview'); break;
    case 'previewOriginal': openViewer(doc, 'original'); break;
    case 'edit': editDoc(doc); break;
    case 'remove': confirmRemove(doc); break;
    case 'simulate': runSimulation(doc); break;
    case 'makeDefault': makeDefault(doc); break;
    case 'resetTune': doc.tune = { ...NEUTRAL_TUNE }; afterDocChange(doc, true); break;
    default: break;
  }
}

async function confirmRemove(doc) {
  if (hasFresh(doc) && !doc.delivered) {
    const ok = await confirmDialog('Dokument entfernen?', 'Das Ergebnis wurde noch nicht gespeichert, geteilt oder gesendet.', 'Entfernen', 'danger');
    if (!ok) return;
  }
  removeDoc(doc);
}

async function makeDefault(doc) {
  const key = doc.kind === 'scan' ? 'scan' : 'pdf';
  settings[`${key}Profile`] = doc.profile;
  settings[`${key}Ocr`] = !!doc.ocr;
  settings.a4 = !!doc.a4;
  persistSettings();
  syncSettingsUi();
  toast(`Standard für ${key === 'scan' ? 'Scans & Fotos' : 'PDFs'}: ${presetName(doc.profile)}${doc.ocr ? ' + Text' : ''}`, 'ok');
}

// ---------------------------------------------------------------- Darstellung: Inspektor

const inspector = $('#inspector');

function profileSizeHtml(doc, key) {
  const sim = doc.sim;
  if (!sim) return '';
  if (sim.running && sim.sizes[key] == null) return '<span class="faint">…</span>';
  const size = sim.sizes[key];
  if (size == null) return '';
  const before = doc.bytes.length;
  const better = size < before;
  const stale = sim.sig !== simSigFor(doc);
  return `<b style="${stale ? 'opacity:.5' : ''}">${sim.estimated && key !== 'verlustfrei' ? '≈ ' : ''}${fmtSize(size)}</b><span class="${better ? 'good' : 'bad'}">${fmtPct(before, size)}</span>`;
}

function inspectorHtml(d) {
  const fresh = hasFresh(d);
  const busy = d.status === 'working' || d.status === 'queued';
  const lossless = PRESETS[d.profile]?.mode === 'lossless';
  const preset = PRESETS[d.profile] || {};
  const cm = preset.colorMode;
  const sim = d.sim;
  const simStale = sim && !sim.running && sim.sig !== simSigFor(d);

  const resultCard = fresh ? `
    <div class="insp-section">
      <div class="result-card">
        <div class="result-nums">
          <span class="from">${fmtSize(d.bytes.length)}</span>
          <span class="to">${fmtSize(d.result.length)}</span>
          <span class="pct ${d.result.length < d.bytes.length ? '' : 'bad'}">${fmtPct(d.bytes.length, d.result.length)}</span>
        </div>
        <div class="result-note">${escapeHtml(presetName(d.profile))}${d.ocr && !lossless ? ' · durchsuchbar' : ''}${d.a4 ? ' · DIN A4' : ''}</div>
        <div class="action-grid">
          <button class="action" data-act="preview">${icon('eye')}Vorschau</button>
          <button class="action" data-act="open">${icon('external')}Öffnen</button>
          <button class="action" data-act="share">${icon('share')}Teilen</button>
          <button class="action" data-act="download">${icon('download')}Laden</button>
          ${backend.consume ? `<button class="action ${d.sent ? 'done' : ''}" data-act="paperless" ${d.sending ? 'disabled' : ''}>${icon(d.sent ? 'checkCircle' : d.sending ? 'spinner' : 'send')}${d.sent ? 'Gesendet' : 'Paperless'}</button>` : ''}
          ${state.outDir ? `<button class="action ${d.savedDir ? 'done' : ''}" data-act="folder">${icon('folder')}Ordner</button>` : ''}
        </div>
      </div>
    </div>` : '';

  const profiles = PRESET_INFO.map((p) => `
    <label class="profile ${p.key === d.profile ? 'active' : ''}">
      <input type="radio" name="inspProfile" value="${p.key}" ${p.key === d.profile ? 'checked' : ''}>
      <span><span class="profile-name">${p.name}</span><br><span class="profile-desc">${p.desc}</span></span>
      <span class="profile-size">${profileSizeHtml(d, p.key)}</span>
    </label>`).join('');

  let simLine = '';
  if (sim?.running) simLine = `<div class="sim-bar"><div class="progress" id="inspSimBar"><div style="width:${Math.round((sim.frac || 0) * 100)}%"></div></div><span>schätze …</span></div>`;
  else if (sim?.error) simLine = `<div class="sim-bar"><span class="err">Simulation fehlgeschlagen: ${escapeHtml(sim.error)}</span></div>`;
  else if (sim && !simStale) simLine = `<div class="sim-bar"><span>${sim.estimated ? `Hochgerechnet aus ${sim.sampled} Beispielseiten` : 'Alle Seiten berechnet'} · ohne Textlayer</span></div>`;

  const dpiOpts = ['', '100', '150', '200', '300', '400', '600']
    .map((v) => `<option value="${v}" ${String(d.tune.dpi) === v ? 'selected' : ''}>${v ? `${v} dpi` : `Standard (${preset.dpi || '–'} dpi)`}</option>`).join('');
  const qOpts = ['', '35', '45', '55', '65', '75', '85', '92']
    .map((v) => `<option value="${v}" ${String(d.tune.quality) === v ? 'selected' : ''}>${v ? `${v} %` : `Standard (${Math.round((preset.quality || 0.6) * 100)} %)`}</option>`).join('');
  const tuneBody = lossless ? '<small>„Verlustfrei“ hat nichts einzustellen.</small>' : `
    <label><span class="lab">Auflösung</span><select data-tune="dpi">${dpiOpts}</select></label>
    ${cm === 'color' || cm === 'gray' ? `<label><span class="lab">JPEG-Qualität</span><select data-tune="quality">${qOpts}</select></label>` : ''}
    ${cm === 'bw' || cm === 'indexed' ? `<label><span class="lab">Helligkeit <output>${d.tune.bias}</output></span><input type="range" min="-40" max="40" step="1" value="${d.tune.bias}" data-tune="bias"><small>+ heller/mehr Weiß · − dunkler/mehr Details</small></label>` : ''}
    ${cm === 'bw' ? `<label><span class="lab">Kontrast <output>${d.tune.contrast}</output></span><input type="range" min="-50" max="50" step="1" value="${d.tune.contrast}" data-tune="contrast"><small>+ nimmt blassen Text mit · − nur kräftige Tinte</small></label>
      <label><span class="lab">Dunkle Flächen</span><select data-tune="darkAreas">
        <option value="auto" ${d.tune.darkAreas === 'auto' ? 'selected' : ''}>Automatisch</option>
        <option value="invert" ${d.tune.darkAreas === 'invert' ? 'selected' : ''}>Als Farbbalken (weiße Schrift lesbar)</option>
        <option value="ignore" ${d.tune.darkAreas === 'ignore' ? 'selected' : ''}>Ignorieren (Rand läuft nicht zu)</option>
      </select></label>` : ''}
    <div><button class="link-btn" data-act="resetTune">Zurücksetzen</button></div>`;

  const foot = (() => {
    if (busy) return `<button class="btn btn-large" data-act="cancel">${icon('stop')}<span>Abbrechen</span></button>`;
    if (!fresh) return `<button class="btn btn-primary btn-large" data-act="compress" ${d.pages ? '' : 'disabled'}>${icon('archive')}<span>${d.result ? 'Erneut komprimieren' : 'Komprimieren'}</span></button>`;
    if (backend.consume && !d.sent) return `<button class="btn btn-primary btn-large" data-act="paperless" ${d.sending ? 'disabled' : ''}>${icon(d.sending ? 'spinner' : 'send')}<span>${d.sending ? 'Wird gesendet …' : 'An Paperless senden'}</span></button>`;
    return `<button class="btn btn-primary btn-large" data-act="${canShareFiles() ? 'share' : 'download'}">${icon(canShareFiles() ? 'share' : 'download')}<span>${canShareFiles() ? 'Teilen' : 'Herunterladen'}</span></button>`;
  })();

  return `
    <div class="insp-head">
      <button class="btn btn-icon btn-ghost insp-close" data-act="closeInspector" aria-label="Schließen">${icon('close')}</button>
      <div class="doc-thumb" data-act="previewOriginal" title="Original ansehen">${d.thumb ? `<img src="${d.thumb}" alt="">` : icon('doc', { size: 28 })}</div>
      <div>
        <label class="sr-only" for="inspName">Name</label>
        <input class="insp-name" id="inspName" value="${escapeHtml(d.name)}" spellcheck="false" autocomplete="off" title="Name ändern">
        <div class="insp-meta">${d.pages ? `${plural(d.pages, 'Seite', 'Seiten')} · ` : ''}${fmtSize(d.bytes.length)} · ${d.kind === 'scan' ? 'Scan' : 'PDF'}${d.edited ? ' · bearbeitet' : ''}</div>
        <div class="doc-tags">${docTags(d)}</div>
        <div class="progress ${busy ? '' : 'hidden'}" id="inspProgress"><div style="width:${Math.round(d.progress * 100)}%"></div></div>
        <div class="insp-status ${d.status === 'error' ? 'err' : ''}" id="inspStatus">${escapeHtml(d.message)}</div>
      </div>
    </div>
    ${resultCard}
    <div class="insp-section">
      <h3>Profil <button class="btn btn-small" data-act="simulate" ${sim?.running || !d.pages ? 'disabled' : ''}>${icon('chart', { size: 16 })}<span>${sim && !sim.running && !simStale ? 'Neu schätzen' : 'Größen schätzen'}</span></button></h3>
      <div class="profiles">${profiles}</div>
      ${simLine}
    </div>
    <div class="insp-section">
      <h3>Optionen</h3>
      <div class="opt-row">
        <div class="row-text"><strong>Texterkennung (OCR)</strong><small>${lossless ? 'nur mit Bild-Profilen' : 'macht das PDF durchsuchbar'}</small></div>
        <label class="switch"><input type="checkbox" id="inspOcr" ${d.ocr ? 'checked' : ''} ${lossless ? 'disabled' : ''}><span></span></label>
      </div>
      <div class="opt-row">
        <div class="row-text"><strong>Auf DIN A4 bringen</strong><small>hoch oder quer, unverzerrt</small></div>
        <label class="switch"><input type="checkbox" id="inspA4" ${d.a4 ? 'checked' : ''}><span></span></label>
      </div>
      <details class="tune" ${d.tuneOpen ? 'open' : ''}>
        <summary>${icon('sliders', { size: 17 })}Feinabstimmung</summary>
        <div class="tune-body">${tuneBody}</div>
      </details>
    </div>
    <div class="insp-section">
      <h3>Dokument</h3>
      <div class="insp-links">
        <button class="btn btn-small" data-act="preview">${icon('eye', { size: 16 })}<span>Vorschau</span></button>
        <button class="btn btn-small" data-act="edit" ${busy ? 'disabled' : ''}>${icon('pen', { size: 16 })}<span>Bearbeiten</span></button>
        <button class="btn btn-small" data-act="openOriginal">${icon('external', { size: 16 })}<span>Original</span></button>
        <button class="btn btn-small btn-danger-ghost" data-act="remove">${icon('trash', { size: 16 })}<span>Entfernen</span></button>
      </div>
      <p class="card-note"><button class="link-btn" data-act="makeDefault">Profil &amp; Optionen als Standard für ${d.kind === 'scan' ? 'Scans' : 'PDFs'} merken</button></p>
    </div>
    <div class="insp-foot">${foot}</div>`;
}

function renderInspector() {
  const d = selected();
  $('#inspEmpty').classList.toggle('hidden', !!d);
  const body = $('#inspBody');
  body.classList.toggle('hidden', !d);
  if (!d) { body.innerHTML = ''; return; }
  // Während jemand den Namen tippt, nicht dazwischenfunken
  const nameFocused = document.activeElement?.id === 'inspName';
  const nameSel = nameFocused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scroll = inspector.scrollTop;
  body.innerHTML = inspectorHtml(d);
  inspector.scrollTop = scroll;
  if (nameFocused) {
    const n = $('#inspName');
    n.focus();
    n.setSelectionRange(...nameSel);
  }
  body.querySelectorAll('input[type="range"]').forEach(syncRangeFill);
}

/** Einstellungsänderung am Dokument: Ergebnis gilt dann als veraltet. */
function afterDocChange(doc, full = true) {
  renderDoc(doc);
  if (full) renderInspector();
  renderToolbar();
  maybeAutoSimulate(doc);
  if (viewer.doc === doc && viewer.mode === 'preview') renderViewer();
}

inspector.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const d = selected();
  if (!btn || !d) return;
  if (btn.dataset.act === 'closeInspector') { closeInspectorDrawer(); return; }
  runAction(d, btn.dataset.act);
});

inspector.addEventListener('change', (e) => {
  const d = selected();
  if (!d) return;
  const t = e.target;
  if (t.name === 'inspProfile') {
    const wasLossless = PRESETS[d.profile]?.mode === 'lossless';
    d.profile = t.value;
    d.tune.dpi = '';
    d.tune.quality = '';
    // „Verlustfrei“ kennt keine Texterkennung; beim Zurückwechseln gilt wieder
    // der Standard – außer man hat den Schalter selbst umgelegt.
    if (PRESETS[d.profile]?.mode === 'lossless') d.ocr = false;
    else if (wasLossless && d.ocrAuto !== false) d.ocr = !!(d.kind === 'scan' ? settings.scanOcr : settings.pdfOcr);
    afterDocChange(d);
  } else if (t.id === 'inspOcr') {
    d.ocr = t.checked;
    d.ocrAuto = false;
    afterDocChange(d);
  } else if (t.id === 'inspA4') {
    d.a4 = t.checked;
    afterDocChange(d);
  } else if (t.dataset.tune) {
    const k = t.dataset.tune;
    d.tune[k] = t.type === 'range' ? parseInt(t.value, 10) : t.value;
    afterDocChange(d);
  } else if (t.id === 'inspName') {
    d.name = cleanName(t.value);
    t.value = d.name;
    renderDoc(d);
  }
});

inspector.addEventListener('input', (e) => {
  const d = selected();
  const t = e.target;
  if (!d) return;
  if (t.id === 'inspName') {
    d.name = cleanName(t.value);
    const title = docListEl.querySelector(`[data-id="${d.id}"] .doc-title`);
    if (title) title.textContent = outName(d);
  } else if (t.type === 'range' && t.dataset.tune) {
    d.tune[t.dataset.tune] = parseInt(t.value, 10);
    const out = t.closest('label')?.querySelector('output');
    if (out) out.textContent = t.value;
    syncRangeFill(t);
    if (viewer.doc === d && viewer.mode === 'preview') scheduleViewer();
  }
});

inspector.addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('tune')) {
    const d = selected();
    if (d) d.tuneOpen = e.target.open;
  }
}, true);

inspector.addEventListener('keydown', (e) => {
  if (e.target.id === 'inspName' && e.key === 'Enter') e.target.blur();
});

function openInspectorDrawer() {
  inspector.classList.add('open');
  showScrim(true, closeInspectorDrawer);
}
function closeInspectorDrawer() {
  inspector.classList.remove('open');
  showScrim(false);
}

function syncRangeFill(el) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  el.style.setProperty('--fill', `${((parseFloat(el.value) - min) / (max - min)) * 100}%`);
}

// ---------------------------------------------------------------- Bearbeiten (Editor)

async function editDoc(doc) {
  if (doc.status === 'working') return;
  const pseudo = { file: new File([doc.bytes], outName(doc), { type: 'application/pdf' }), editedBytes: doc.bytes };
  try {
    await openEditor(pseudo, async (edited) => {
      doc.bytes = edited;
      doc.rev++;
      doc.edited = true;
      doc.sim = null;
      doc.message = 'Bearbeitet – bitte komprimieren';
      doc.pageProfiles = {};
      try {
        doc.pages = await countPages(edited);
        doc.thumb = (await renderPageImage(edited, 1, 180)).url;
      } catch { /* Miniatur egal */ }
      renderDoc(doc);
      if (doc.id === state.selectedId) renderInspector();
      renderToolbar();
      if (settings.autoCompress) enqueue(doc);
      else maybeAutoSimulate(doc);
    });
  } catch (e) {
    toast(`Editor konnte nicht starten: ${e?.message || e}`, 'err', 5000);
  }
}

// ---------------------------------------------------------------- Betrachter (Vorschau)

const viewer = { doc: null, page: 1, mode: 'preview', zoom: 1, pages: 1, token: 0, timer: null };
const viewerEl = $('#viewer');

function openViewer(doc, mode = 'preview') {
  viewer.page = Math.min(viewer.doc === doc ? viewer.page : 1, doc.pages || 1);
  viewer.doc = doc;
  viewer.mode = mode;
  viewer.zoom = 1;
  viewer.pages = doc.pages || 1;
  viewerEl.hidden = false;
  document.addEventListener('keydown', onViewerKey);
  renderViewer();
}

function closeViewer() {
  viewerEl.hidden = true;
  viewer.token++;
  viewer.doc = null;
  document.removeEventListener('keydown', onViewerKey);
}

function onViewerKey(e) {
  if (e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); viewerGo(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); viewerGo(-1); }
}

function viewerGo(delta) {
  const n = viewer.page + delta;
  if (n < 1 || n > viewer.pages) return;
  viewer.page = n;
  renderViewer();
}

function scheduleViewer() {
  clearTimeout(viewer.timer);
  viewer.timer = setTimeout(renderViewer, 260);
}

async function renderViewer() {
  const d = viewer.doc;
  if (!d) return;
  const token = ++viewer.token;
  const fresh = hasFresh(d);
  if (viewer.mode === 'result' && !fresh) viewer.mode = 'preview';
  $$('#viewerMode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === viewer.mode);
    b.setAttribute('aria-checked', String(b.dataset.v === viewer.mode));
    if (b.dataset.v === 'result') b.disabled = !fresh;
  });
  $('#viewerTitle').textContent = outName(d);
  $('#viewerSub').textContent = viewer.mode === 'original' ? 'Original' : viewer.mode === 'result' ? `Ergebnis · ${fmtSize(d.result.length)}` : `Vorschau · ${presetName(d.pageProfiles[viewer.page] || d.profile)}`;
  $('#viewerPage').textContent = `${viewer.page} / ${viewer.pages}`;
  $('#viewerPrev').disabled = viewer.page <= 1;
  $('#viewerNext').disabled = viewer.page >= viewer.pages;

  // Seiten-Ausnahme nur in der Vorschau einstellbar
  const ovWrap = $('#viewerOverrideWrap');
  ovWrap.classList.toggle('hidden', viewer.mode !== 'preview' || PRESETS[d.profile]?.mode === 'lossless' || viewer.pages < 2);
  const sel = $('#viewerOverride');
  sel.innerHTML = `<option value="">Wie Dokument (${escapeHtml(presetName(d.profile))})</option>`
    + PRESET_INFO.filter((p) => p.key !== 'verlustfrei').map((p) => `<option value="${p.key}">${p.name}</option>`).join('');
  sel.value = d.pageProfiles[viewer.page] || '';

  const stage = $('#viewerStage');
  stage.classList.toggle('zoomed', viewer.zoom > 1);
  stage.classList.add('loading');
  $('#viewerBusy').classList.remove('hidden');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.min(2400, Math.round(Math.max(600, stage.clientWidth - 48) * dpr * viewer.zoom));
  try {
    let url;
    let info = '';
    if (viewer.mode === 'original') {
      ({ url } = await renderPageImage(d.bytes, viewer.page, width));
      info = `Original · ${fmtSize(d.bytes.length)} gesamt`;
    } else if (viewer.mode === 'result') {
      ({ url } = await renderPageImage(d.result, viewer.page, width));
      info = `So sieht das fertige PDF aus · ${fmtPct(d.bytes.length, d.result.length)}`;
    } else {
      const o = { ...optsFor(d), ocr: false };
      const r = await previewPage(d.bytes, o, viewer.page, width);
      url = r.dataUrl;
      info = o.mode === 'lossless'
        ? 'Verlustfrei ändert das Aussehen nicht'
        : `≈ ${fmtSize(r.pageBytes)} für diese Seite · ${presetName(d.pageProfiles[viewer.page] || d.profile)}`;
    }
    if (token !== viewer.token) return;
    const img = $('#viewerImg');
    img.src = url;
    img.style.width = viewer.zoom > 1 ? `${Math.round(width / dpr)}px` : '';
    $('#viewerInfo').textContent = info;
    renderViewerSize(d);
  } catch (e) {
    if (token === viewer.token) $('#viewerInfo').textContent = `Vorschau nicht möglich: ${e?.message || e}`;
  } finally {
    if (token === viewer.token) {
      stage.classList.remove('loading');
      $('#viewerBusy').classList.add('hidden');
    }
  }
}

/** Größe vorher → nachher fürs ganze Dokument (geschätzt oder echt). */
function sizeLine(before, after, approx) {
  const better = after < before;
  return `<span class="vs-label">Dokument</span><span class="vs-from">${fmtSize(before)}</span><span class="vs-arrow">→</span>`
    + `<b class="vs-to">${approx ? '≈ ' : ''}${fmtSize(after)}</b><span class="vs-pct ${better ? 'good' : 'bad'}">${fmtPct(before, after)}</span>`;
}

async function renderViewerSize(d) {
  const el = $('#viewerSize');
  const before = d.bytes.length;
  if (viewer.mode === 'original') {
    el.innerHTML = hasFresh(d) ? sizeLine(before, d.result.length, false) : `<span class="vs-label">Original</span><b class="vs-to">${fmtSize(before)}</b>`;
    return;
  }
  if (viewer.mode === 'result' && hasFresh(d)) {
    el.innerHTML = sizeLine(before, d.result.length, false);
    return;
  }
  if (PRESETS[d.profile]?.mode === 'lossless' && !d.sim?.sizes?.verlustfrei) {
    el.innerHTML = `<span class="vs-label">Dokument</span><span class="vs-from">${fmtSize(before)}</span><span class="vs-arrow">→</span><span class="faint">„Größen schätzen“ rechnet es aus</span>`;
    return;
  }
  // Schätzung: aus der Simulation, sonst nur für das aktuelle Profil rechnen
  const sig = simSigFor(d);
  const known = d.sim && d.sim.sig === sig ? d.sim.sizes?.[d.profile] : null;
  if (known != null) {
    el.innerHTML = sizeLine(before, known, d.sim.estimated);
    return;
  }
  if (d.estimate?.sig === sig) {
    if (d.estimate.size != null) el.innerHTML = sizeLine(before, d.estimate.size, d.estimate.approx);
    return;
  }
  el.innerHTML = `<span class="vs-label">Dokument</span><span class="vs-from">${fmtSize(before)}</span><span class="vs-arrow">→</span><span class="faint">wird geschätzt …</span>`;
  const token = viewer.token;
  d.estimate = { sig, size: null };
  try {
    const r = await simulateVariants(d.bytes, [{ key: d.profile, opts: { ...optsFor(d), ocr: false } }]);
    d.estimate = { sig, size: r.sizes[d.profile], approx: r.estimated || true };
  } catch {
    d.estimate = null;
  }
  if (viewer.doc === d && token === viewer.token && d.estimate) el.innerHTML = sizeLine(before, d.estimate.size, true);
}

$('#viewerClose').addEventListener('click', closeViewer);
$('#viewerPrev').addEventListener('click', () => viewerGo(-1));
$('#viewerNext').addEventListener('click', () => viewerGo(1));
$('#viewerZoomIn').addEventListener('click', () => { viewer.zoom = Math.min(3, viewer.zoom * 1.5); renderViewer(); });
$('#viewerZoomOut').addEventListener('click', () => { viewer.zoom = Math.max(1, viewer.zoom / 1.5); renderViewer(); });
$('#viewerImg').addEventListener('dblclick', () => { viewer.zoom = viewer.zoom > 1 ? 1 : 2; renderViewer(); });
$('#viewerMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b || b.disabled) return;
  viewer.mode = b.dataset.v;
  renderViewer();
});
$('#viewerOverride').addEventListener('change', (e) => {
  const d = viewer.doc;
  if (!d) return;
  if (e.target.value) d.pageProfiles[viewer.page] = e.target.value;
  else delete d.pageProfiles[viewer.page];
  afterDocChange(d);
  renderViewer();
});
// Wischen am Handy
{
  let x0 = null;
  const stage = $('#viewerStage');
  stage.addEventListener('touchstart', (e) => { x0 = viewer.zoom === 1 && e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 60) viewerGo(dx < 0 ? 1 : -1);
    x0 = null;
  });
}

// ---------------------------------------------------------------- Blätter, Menü, Scrim

const scrim = $('#scrim');
let scrimClose = null;
function showScrim(on, onClose = null) {
  scrim.classList.toggle('show', on);
  scrimClose = on ? onClose : null;
}
scrim.addEventListener('click', () => scrimClose?.());

function openSheet(id) {
  closeSheets();
  $(id).classList.add('open');
  showScrim(true, closeSheets);
}
function closeSheets() {
  $$('.sheet.open').forEach((s) => s.classList.remove('open'));
  if (!inspector.classList.contains('open')) showScrim(false);
  else showScrim(true, closeInspectorDrawer);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !viewerEl.hidden || document.querySelector('.dlg-wrap')) return;
  if (!$('#moreMenu').hidden) { closeMenu(); return; }
  if ($('.sheet.open')) { closeSheets(); return; }
  if (inspector.classList.contains('open')) closeInspectorDrawer();
});

const moreMenu = $('#moreMenu');
function closeMenu() {
  moreMenu.hidden = true;
  document.removeEventListener('pointerdown', onMenuOutside, true);
}
function onMenuOutside(e) {
  if (!moreMenu.contains(e.target) && !e.target.closest('#moreBtn')) closeMenu();
}
$('#moreBtn').addEventListener('click', () => {
  if (!moreMenu.hidden) { closeMenu(); return; }
  const r = $('#moreBtn').getBoundingClientRect();
  const done = state.docs.filter(hasFresh);
  moreMenu.querySelector('[data-more="sendAll"]').disabled = !done.some((d) => !d.sent);
  moreMenu.querySelector('[data-more="downloadAll"]').disabled = done.length === 0;
  moreMenu.querySelector('[data-more="merge"]').disabled = state.docs.length < 2 || !!working;
  moreMenu.hidden = false;
  const w = moreMenu.offsetWidth;
  moreMenu.style.top = `${r.bottom + 6}px`;
  moreMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  document.addEventListener('pointerdown', onMenuOutside, true);
});
moreMenu.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-more]');
  if (!b) return;
  closeMenu();
  const act = b.dataset.more;
  if (act === 'sendAll') sendAll();
  if (act === 'downloadAll') state.docs.filter(hasFresh).forEach((d, i) => setTimeout(() => downloadDoc(d), i * 350));
  if (act === 'merge') mergeAll();
  if (act === 'clear') clearAll();
});

async function sendAll() {
  const ready = state.docs.filter((d) => hasFresh(d) && !d.sent);
  if (!ready.length) return;
  const t = toast(`Sende ${plural(ready.length, 'Dokument', 'Dokumente')} an Paperless …`, 'busy', 0);
  let ok = 0;
  for (const d of ready) if (await sendToPaperless(d, { quiet: true })) ok++;
  t.update(ok === ready.length ? `${plural(ok, 'Dokument', 'Dokumente')} an Paperless übergeben` : `${ok} von ${ready.length} übergeben`, ok === ready.length ? 'ok' : 'err');
}

async function mergeAll() {
  if (state.docs.length < 2 || working) return;
  const ok = await confirmDialog(
    'Zu einem Dokument zusammenführen?',
    `Alle ${state.docs.length} Dokumente werden in der Reihenfolge der Liste zu einer PDF verbunden und ersetzen die Einzeldokumente.`,
    'Zusammenführen',
  );
  if (!ok) return;
  const t = toast('Führe zusammen …', 'busy', 0);
  try {
    const parts = [...state.docs];
    const bytes = await mergePdfs(parts.map((d) => d.bytes));
    const raw = parts.flatMap((d) => d.rawSources || []);
    const kind = parts.some((d) => d.kind === 'scan') ? 'scan' : 'pdf';
    parts.forEach((d) => removeDoc(d));
    await addPdfDoc(new Uint8Array(bytes), `${parts[0].name} (zusammengeführt)`, { kind, rawSources: raw.length ? raw : null });
    t.update('Zusammengeführt', 'ok');
  } catch (e) {
    t.update(`Zusammenführen fehlgeschlagen: ${e?.message || e}`, 'err', 6000);
  }
}

async function clearAll() {
  const open = state.docs.filter((d) => hasFresh(d) && !d.delivered).length;
  const ok = await confirmDialog('Liste leeren?', open ? `${plural(open, 'Ergebnis wurde', 'Ergebnisse wurden')} noch nicht gespeichert oder gesendet.` : 'Alle Dokumente werden aus der Liste entfernt.', 'Leeren', 'danger');
  if (!ok) return;
  [...state.docs].forEach(removeDoc);
}

$('#compressAllBtn').addEventListener('click', () => {
  state.docs.filter((d) => !hasFresh(d) && d.pages).forEach(enqueue);
});

// ---------------------------------------------------------------- Hinzufügen

const fileInput = $('#fileInput');
const cameraInput = $('#cameraInput');

function onAdd(kind) {
  closeSheets();
  if (kind === 'files') fileInput.click();
  else if (kind === 'camera') cameraInput.click();
  else if (kind === 'scanner') openScanSheet();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (b) onAdd(b.dataset.add);
});
$('#tabAdd').addEventListener('click', () => openSheet('#addSheet'));
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  addFiles(files);
});
cameraInput.addEventListener('change', () => {
  const files = [...cameraInput.files];
  cameraInput.value = '';
  if (files.length) openStudio({ files, camera: true });
});

// Ziehen & Ablegen im ganzen Fenster
{
  let depth = 0;
  const overlay = $('#dropOverlay');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const editorOpen = $('#editorRoot') && !$('#editorRoot').classList.contains('hidden');
    if (document.getElementById('scannerRoot') || editorOpen) return;
    if (e.dataTransfer.files.length) {
      showView('docs');
      addFiles(e.dataTransfer.files);
    }
  });
}

// Bilder/PDFs aus der Zwischenablage (Strg+V)
document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// ---------------------------------------------------------------- Scan-Studio

let studioMod = null;
async function studio() {
  if (!studioMod) studioMod = await import('./scanner.js');
  return studioMod;
}

/** Studio öffnen: Bilder werden zu A4-Seiten, am Ende entsteht ein Dokument. */
async function openStudio({ files = [], camera = false, rawSources = null, scanNow = false } = {}) {
  const m = await studio();
  m.openScanner((pdfFile) => onStudioDone(pdfFile, rawSources), {
    initialFiles: files,
    netScan: backend.scanner ? () => startStudioScan() : null,
    onCancelBatch: cancelScan,
    onDiscard: dropStudioJob,
    geometry: scanGeometry,
    setCorner: (c) => { settings.scanCorner = c; persistSettings(); syncSettingsUi(); syncScanSheet(); },
    a4: () => !!settings.a4,
    camera,
  });
  if (scanNow) startStudioScan();
}

async function onStudioDone(pdfFile, rawSources) {
  showView('docs');
  const name = pdfFile.name && !/^Scan_\d/.test(pdfFile.name) ? pdfFile.name : stampName('Scan');
  const doc = await addPdfDoc(new Uint8Array(await pdfFile.arrayBuffer()), name, { kind: 'scan', rawSources });
  // Erst wenn das Dokument sicher gespeichert ist, den Auftrag wegräumen
  await saveDocsNow().catch(() => {});
  if (studioJob) dropStudioJob();
  return doc;
}

/** A4-Lage auf der Glasfläche: kalibriertes Rechteck oder Ecke + Versatz. */
function scanGeometry() {
  return {
    corner: settings.scanCorner,
    offX: +settings.scanOffX || 0,
    offY: +settings.scanOffY || 0,
    rect: settings.scanRect && settings.scanRect.w > 0 ? settings.scanRect : null,
  };
}

// ---------------------------------------------------------------- Netzwerk-Scanner
//
// Scans laufen als Auftrag auf dem Server: Er spricht den Scanner an, wartet
// die Pausen ab und legt jede Seite sofort auf der Platte ab. Die App holt die
// Seiten nur ab. Wird die App geschlossen oder das Handy gesperrt, läuft der
// Auftrag weiter – beim nächsten Öffnen liegen die Seiten bereit. Gelöscht
// wird ein Auftrag erst, wenn daraus ein Dokument geworden ist.

const batch = { running: false, cancel: false, jobId: null };
const scanCaps = { resolutions: null, gray: true };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Farbscan in Graustufen umrechnen (falls das Gerät kein Grau liefert). */
async function toGrayJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  c.width = 1;
  return out || blob;
}

/** Seite eines Auftrags als Datei holen (mit Auflösung für den A4-Ausschnitt). */
async function fetchJobPage(jobId, page) {
  const res = await fetch(`/api/scan-jobs/${jobId}/pages/${page.n}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Seite ${page.n} nicht abrufbar (HTTP ${res.status})`);
  let blob = await res.blob();
  const dpi = parseInt(res.headers.get('X-Scan-Dpi'), 10) || page.dpi || 300;
  const got = res.headers.get('X-Scan-Color') || page.colorMode;
  const wanted = res.headers.get('X-Scan-Wanted') || page.wanted;
  if (wanted && wanted !== 'color' && /RGB/i.test(got || '')) blob = await toGrayJpeg(blob);
  const file = new File([blob], `Scan_${Date.now()}_S${String(page.n).padStart(2, '0')}_${dpi}dpi.jpg`, { type: 'image/jpeg' });
  // Auflösung merken – daraus ergibt sich die echte Größe der Glasfläche in mm
  // und damit der feste A4-Ausschnitt.
  file.scanDpi = dpi;
  file.scanWanted = wanted;
  return file;
}

function jobStatusText(job) {
  const n = job.pages.length;
  if (job.status === 'waiting' && job.nextAt) {
    const left = Math.max(0, Math.ceil((job.nextAt - Date.now()) / 1000));
    return `Seite ${n}/${job.total} fertig – nächste in ${left} s · Vorlage wechseln`;
  }
  if (job.status === 'running' || job.status === 'queued') return job.total > 1 ? `Seite ${n + 1}/${job.total} wird gescannt …` : 'Seite wird gescannt …';
  return job.message || '';
}

/**
 * Auftrag verfolgen, bis er fertig ist. Neue Seiten gehen an onPage (einmal
 * je Seite), der Zustand an onStatus. Verträgt Ruhezustand/Netzwerkaussetzer.
 */
async function followJob(jobId, { onPage, onStatus, seen = new Set() } = {}) {
  batch.running = true;
  batch.cancel = false;
  batch.jobId = jobId;
  let job = null;
  let misses = 0;
  try {
    for (;;) {
      try {
        job = await api(`/api/scan-jobs/${jobId}`);
        misses = 0;
      } catch (e) {
        if (e.status === 404) throw new Error('Scan-Auftrag ist auf dem Server nicht mehr vorhanden.');
        if (++misses > 20) throw e;
        await sleep(1500);
        continue;
      }
      for (const p of job.pages) {
        if (seen.has(p.n)) continue;
        seen.add(p.n);
        if (p.file && onPage) await onPage(await fetchJobPage(jobId, p), p, job);
        else if (onPage && p.raw) await onPage(null, p, job);
      }
      if (!job.live) break;
      onStatus?.(jobStatusText(job), job);
      await sleep(job.status === 'waiting' ? 400 : 800);
    }
  } finally {
    batch.running = false;
    batch.jobId = null;
  }
  return job;
}

async function createScanJob({ pages, delay, target = 'doc', dpi }) {
  try {
    return await api('/api/scan-jobs', {
      method: 'POST',
      body: { pages, delay, dpi: dpi || settings.scanDpi, color: settings.scanColor, target },
    });
  } catch (e) {
    if (e.status === 409 && e.data?.job) throw new Error('Es läuft bereits ein Scan (evtl. von einem anderen Gerät).');
    throw e;
  }
}

/** Genau eine Seite vom Netzwerk-Scanner holen (z. B. für den Editor). */
async function fetchScannedPage({ dpi } = {}) {
  const job = await createScanJob({ pages: 1, delay: 0, dpi });
  let file = null;
  try {
    const end = await followJob(job.id, { onPage: async (f) => { file = f; } });
    if (!file) throw new Error(end?.error || end?.message || 'Keine Seite erhalten');
  } finally {
    api(`/api/scan-jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
  }
  return file;
}

// Auftrag, der zum offenen Studio gehört (wird gelöscht, sobald das Dokument steht)
let studioJob = null;

/** Auftrag ins Studio holen: vorhandene Seiten sofort, weitere live. */
async function attachJobToStudio(jobId, { seen = new Set() } = {}) {
  const m = await studio();
  studioJob = { id: jobId, seen };
  m.setScanStatus('Verbinde mit Scan-Auftrag …', true);
  try {
    const end = await followJob(jobId, {
      seen,
      onPage: (file) => (file ? m.addPageDirect(file) : null),
      onStatus: (s) => m.setScanStatus(s, true),
    });
    m.setScanStatus('');
    m.showPages();
    const n = end.pages.length;
    if (end.status === 'error') toast(`Scan fehlgeschlagen: ${end.error}${n ? ` – ${plural(n, 'Seite bleibt', 'Seiten bleiben')} erhalten` : ''}`, 'err', 8000);
    else if (end.status === 'cancelled') toast(`Gestoppt – ${plural(n, 'Seite', 'Seiten')} eingelesen`, 'ok', 4000);
    else if (end.total > 1) toast(`${plural(n, 'Seite', 'Seiten')} eingelesen – prüfen und „Fertig“`, 'ok', 4000);
  } catch (e) {
    m.setScanStatus('');
    m.showPages();
    toast(`Scan fehlgeschlagen: ${e?.message || e}`, 'err', 7000);
  }
}

async function startStudioScan() {
  if (batch.running) return;
  const m = await studio();
  const total = clampInt(settings.scanPages, 1, 50, 1);
  const delay = clampInt(settings.scanDelay, 0, 120, 8);
  m.setScanStatus(total > 1 ? `Stapel: ${total} Seiten` : 'Scanne …', true);
  try {
    // Gehört schon ein Auftrag zum Studio, wird er verlängert – so liegen alle
    // Seiten des Dokuments gemeinsam sicher auf dem Server.
    if (studioJob) {
      try {
        await api(`/api/scan-jobs/${studioJob.id}/resume`, { method: 'POST', body: { more: total } });
        await attachJobToStudio(studioJob.id, { seen: studioJob.seen });
        return;
      } catch (e) {
        if (e.status !== 404) throw e;
        studioJob = null;
      }
    }
    const job = await createScanJob({ pages: total, delay });
    await attachJobToStudio(job.id);
  } catch (e) {
    m.setScanStatus('');
    m.showPages();
    toast(`Scan fehlgeschlagen: ${e?.message || e}`, 'err', 7000);
  }
}

function cancelScan() {
  batch.cancel = true;
  if (batch.jobId) api(`/api/scan-jobs/${batch.jobId}/cancel`, { method: 'POST' }).catch(() => {});
}

function dropStudioJob() {
  if (!studioJob) return;
  const id = studioJob.id;
  studioJob = null;
  api(`/api/scan-jobs/${id}`, { method: 'DELETE' }).catch(() => {});
  refreshJobBanner();
}

/** Direkt in den Sammelordner scannen – die Rohbilder bleiben unverändert. */
async function scanIntoRaw() {
  if (batch.running) return;
  const prep = await import('./prepare.js');
  showView('inbox');
  const total = clampInt(settings.scanPages, 1, 50, 1);
  const delay = clampInt(settings.scanDelay, 0, 120, 8);
  const t = toast('Scanne in den Sammelordner …', 'busy', 0, { onClick: null });
  try {
    const job = await createScanJob({ pages: total, delay, target: 'raw' });
    const end = await followJob(job.id, {
      onStatus: (s) => { t.update(`${s} · läuft auch ohne App weiter`, 'busy', 0); prep.setStatus(s); },
      onPage: () => prep.refresh(),
    });
    const n = end.pages.length;
    const msg = end.status === 'error'
      ? `Scan fehlgeschlagen: ${end.error}`
      : end.status === 'cancelled' ? `Gestoppt – ${plural(n, 'Seite', 'Seiten')} abgelegt` : `${plural(n, 'Seite', 'Seiten')} im Sammelordner abgelegt`;
    t.update(msg, end.status === 'error' ? 'err' : 'ok', end.status === 'error' ? 8000 : 4000);
    prep.setStatus(msg, end.status === 'error' ? 'err' : 'ok');
  } catch (e) {
    t.update(`Scan fehlgeschlagen: ${e?.message || e}`, 'err', 7000);
    prep.setStatus(`Scan fehlgeschlagen: ${e?.message || e}`, 'err');
  }
  await prep.refresh();
}

// Offene Aufträge (App war zu, anderes Gerät, Server-Neustart) als Hinweis zeigen
let bannerJobs = [];
async function refreshJobBanner() {
  const el = $('#jobBanner');
  if (!backend.jobs || !el) return;
  let jobs = [];
  try { jobs = (await api('/api/scan-jobs')).jobs || []; } catch { return; }
  bannerJobs = jobs.filter((j) => j.target === 'doc' && j.id !== studioJob?.id && j.id !== batch.jobId && (j.pages.length || j.live));
  el.classList.toggle('hidden', !bannerJobs.length);
  el.innerHTML = bannerJobs.map((j) => {
    const when = new Date(j.created).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const state = j.live ? 'läuft gerade' : { done: 'fertig', cancelled: 'gestoppt', error: 'mit Fehler beendet', interrupted: 'unterbrochen' }[j.status] || j.status;
    return `<div class="job-card" data-job="${j.id}">
      <span class="job-icon">${icon(j.live ? 'spinner' : 'scanner', { size: 22 })}</span>
      <span class="job-text"><strong>Scan vom ${when} · ${plural(j.pages.length, 'Seite', 'Seiten')}</strong><small>${escapeHtml(state)}${j.error ? ` – ${escapeHtml(j.error)}` : ''} · liegt sicher auf dem Server</small></span>
      <span class="job-actions">
        <button class="btn btn-small btn-danger-ghost" data-job-act="drop">${icon('trash', { size: 15 })}<span>Verwerfen</span></button>
        <button class="btn btn-small btn-primary" data-job-act="open">${icon('scanFrame', { size: 15 })}<span>Öffnen</span></button>
      </span>
    </div>`;
  }).join('');
}

$('#jobBanner')?.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-job-act]');
  if (!b) return;
  const id = b.closest('[data-job]').dataset.job;
  const job = bannerJobs.find((j) => j.id === id);
  if (!job) return;
  if (b.dataset.jobAct === 'drop') {
    const ok = await confirmDialog('Scan verwerfen?', `${plural(job.pages.length, 'eingelesene Seite wird', 'eingelesene Seiten werden')} gelöscht.`, 'Verwerfen', 'danger');
    if (!ok) return;
    if (job.live) await api(`/api/scan-jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
    await api(`/api/scan-jobs/${id}`, { method: 'DELETE' }).catch(() => {});
    refreshJobBanner();
    return;
  }
  if (studioMod?.isOpen()) { toast('Das Scan-Studio ist schon offen', 'info'); return; }
  await openStudio({});
  attachJobToStudio(id);
  $('#jobBanner').classList.add('hidden');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshJobBanner();
});

const clampInt = (v, lo, hi, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

const CORNER_TEXT = { tl: 'oben links', tr: 'oben rechts', bl: 'unten links', br: 'unten rechts' };

/** Auflösungen, die das Gerät kann (Auswahl für das Scan-Blatt). */
function dpiChoices() {
  const fromCaps = (scanCaps.resolutions || []).filter((d) => d >= 100 && d <= 600);
  const list = fromCaps.length ? fromCaps : [200, 300, 600];
  // höchstens vier Knöpfe: die üblichen bevorzugen
  const pref = [150, 200, 300, 600, 100, 400];
  return list.length <= 4 ? list : pref.filter((d) => list.includes(d)).slice(0, 4).sort((a, b) => a - b);
}

function nearestDpi(v, list) {
  const n = parseInt(v, 10) || 300;
  return list.reduce((b, d) => (Math.abs(d - n) < Math.abs(b - n) ? d : b), list[0]);
}

function a4AreaText() {
  const r = settings.scanRect;
  if (r?.w) {
    const h = r.w * 297 / 210;
    const exact = Math.abs(r.w - 210) < 0.05;
    return `Eingerichtet: X ${fmtMm(r.x)} · Y ${fmtMm(r.y)} mm · ${fmtMm(r.w)} × ${fmtMm(h)} mm${exact ? ' (exakt A4)' : ''}`;
  }
  const off = (+settings.scanOffX || +settings.scanOffY) ? ` · Versatz ${fmtMm(+settings.scanOffX || 0)}/${fmtMm(+settings.scanOffY || 0)} mm` : '';
  return `Ecke ${CORNER_TEXT[settings.scanCorner] || 'oben links'} · exakt 210 × 297 mm${off}`;
}
const fmtMm = (v) => String(Math.round((Number(v) || 0) * 10) / 10).replace('.', ',');

function syncScanSheet() {
  $('#scanPages').value = settings.scanPages;
  $('#scanDelay').value = settings.scanDelay;
  const n = clampInt(settings.scanPages, 1, 50, 1);
  $('#scanDelayRow').classList.toggle('hidden', n < 2);
  $('#scanPagesHint').textContent = n > 1 ? `${n} Seiten nacheinander – ohne weiteres Tippen` : 'Ab 2 Seiten scannt der Stapel von selbst weiter';
  // Auflösungen nach den Fähigkeiten des Geräts
  const dpis = dpiChoices();
  const seg = $('#scanDpiSeg');
  const want = String(nearestDpi(settings.scanDpi, dpis));
  if (seg.dataset.list !== dpis.join(',')) {
    seg.innerHTML = dpis.map((d) => `<button data-v="${d}" role="radio">${d}</button>`).join('');
    seg.dataset.list = dpis.join(',');
  }
  const setSeg = (id, v) => $$(`${id} button`).forEach((b) => {
    b.classList.toggle('active', b.dataset.v === String(v));
    b.setAttribute('aria-checked', String(b.dataset.v === String(v)));
  });
  setSeg('#scanDpiSeg', want);
  setSeg('#scanColorSeg', settings.scanColor);
  setSeg('#scanTargetSeg', backend.raw ? settings.scanTarget : 'doc');
  $('#scanTargetRow').classList.toggle('hidden', !backend.raw);
  const toRaw = backend.raw && settings.scanTarget === 'raw';
  $('#scanCornerHint').textContent = toRaw
    ? 'Die Rohbilder landen unverändert im Sammelordner – Zuschnitt und A4 passieren beim Übernehmen.'
    : settings.scanRect?.w
      ? 'Vorlage wie beim Einrichten auflegen – der Ausschnitt ist der eingerichtete A4-Bereich.'
      : `Vorlage bündig an die Ecke ${CORNER_TEXT[settings.scanCorner] || 'oben links'} legen – der Ausschnitt ist exakt DIN A4.`;
  $('#scanStartBtn span').textContent = n > 1 ? `${n} Seiten scannen` : 'Scannen';
  const info = $('#a4AreaInfo');
  if (info) info.textContent = a4AreaText();
}

async function openScanSheet(target = null) {
  if (target) settings.scanTarget = target;
  syncScanSheet();
  openSheet('#scanSheet');
  checkScanner();
}

function setScannerPills(cls, text, detail = text) {
  const pill = $('#scanSheetState');
  pill.querySelector('.dot').className = `dot ${cls}`;
  pill.querySelector('span:last-child').textContent = text;
  $('#scannerState').textContent = detail;
  const side = $('#statusScanner');
  side.querySelector('.dot').className = `dot ${cls}`;
  side.querySelector('span:last-child').textContent = cls === 'on' ? (backend.scannerModel || 'Scanner bereit') : 'Scanner nicht erreichbar';
}

async function checkScanner() {
  if (!backend.scanner) {
    setScannerPills('off', 'nicht eingerichtet', 'Keine Adresse – unten eintragen oder suchen');
    $('#scannerModel').textContent = 'Scanner';
    return false;
  }
  setScannerPills('busy', 'wird geprüft …');
  try {
    const data = await api('/api/scanner/status');
    if (!data.ok) throw new Error(data.error || 'nicht erreichbar');
    backend.scannerModel = data.model;
    scanCaps.resolutions = data.resolutions || null;
    scanCaps.gray = data.gray !== false;
    scanCaps.bed = data.bed || null;
    $('#scannerModel').textContent = data.model || 'Scanner';
    const dpis = data.resolutions?.length ? ` · ${data.resolutions.filter((d) => d <= 1200).join('/')} dpi` : '';
    setScannerPills('on', `${data.model || 'Scanner'} · ${data.busy ? 'scannt gerade' : 'bereit'}`, `${data.busy ? 'scannt gerade' : 'bereit'}${dpis}${data.gray ? ' · Farbe/Grau' : ' · Farbe (Grau per App)'}`);
    syncScanSheet();
    return true;
  } catch (e) {
    setScannerPills('off', 'nicht erreichbar', `nicht erreichbar – ${String(e?.message || e).slice(0, 90)}`);
    return false;
  }
}

$('#scanSheet').addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  if (step) {
    const input = step.parentElement.querySelector('input');
    const isPages = input.id === 'scanPages';
    const v = clampInt(input.value, isPages ? 1 : 0, isPages ? 50 : 120, isPages ? 1 : 8) + parseInt(step.dataset.step, 10);
    settings[isPages ? 'scanPages' : 'scanDelay'] = clampInt(v, isPages ? 1 : 0, isPages ? 50 : 120, 1);
    persistSettings();
    syncScanSheet();
    return;
  }
  const seg = e.target.closest('.seg button[data-v]');
  if (seg) {
    const id = seg.parentElement.id;
    const key = { scanDpiSeg: 'scanDpi', scanColorSeg: 'scanColor', scanTargetSeg: 'scanTarget' }[id];
    if (key) {
      settings[key] = seg.dataset.v;
      persistSettings();
      syncScanSheet();
    }
  }
});
['#scanPages', '#scanDelay'].forEach((id) => $(id).addEventListener('change', (e) => {
  const isPages = id === '#scanPages';
  settings[isPages ? 'scanPages' : 'scanDelay'] = clampInt(e.target.value, isPages ? 1 : 0, isPages ? 50 : 120, isPages ? 1 : 8);
  persistSettings();
  syncScanSheet();
}));
$('#scanStartBtn').addEventListener('click', () => {
  closeSheets();
  if (backend.raw && settings.scanTarget === 'raw') scanIntoRaw();
  else openStudio({ scanNow: true });
});
$('#scannerTestBtn').addEventListener('click', checkScanner);

// ---------------------------------------------------------------- Ansichten

function showView(name) {
  if (name === 'inbox' && !backend.raw) name = 'docs';
  state.view = name;
  $('#viewDocs').classList.toggle('hidden', name !== 'docs');
  $('#viewInbox').classList.toggle('hidden', name !== 'inbox');
  $('#viewSettings').classList.toggle('hidden', name !== 'settings');
  $$('[data-view]').forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#main').scrollTop = 0;
  if (name === 'inbox') import('./prepare.js').then((p) => p.refresh());
}
$$('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------------------------------------------------------------- Einstellungen

function fillProfileSelect(sel) {
  sel.innerHTML = PRESET_INFO.map((p) => `<option value="${p.key}">${p.name}</option>`).join('');
}
fillProfileSelect($('#setScanProfile'));
fillProfileSelect($('#setPdfProfile'));

const SETTING_FIELDS = {
  setScanProfile: 'scanProfile',
  setPdfProfile: 'pdfProfile',
  setScanOcr: 'scanOcr',
  setPdfOcr: 'pdfOcr',
  setOcrLang: 'ocrLang',
  setA4: 'a4',
  setAutoCompress: 'autoCompress',
  setAutoPaperless: 'autoPaperless',
};

function syncSettingsUi() {
  for (const [id, key] of Object.entries(SETTING_FIELDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key] ?? '';
  }
}

for (const [id, key] of Object.entries(SETTING_FIELDS)) {
  document.getElementById(id)?.addEventListener('change', (e) => {
    const el = e.target;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = Math.max(-20, Math.min(20, parseFloat(String(v).replace(',', '.')) || 0));
    settings[key] = v;
    if (el.type === 'number') el.value = v;
    persistSettings();
    if (key === 'ocrLang') state.docs.forEach((d) => { if (d.ocr) afterDocChange(d, false); });
  });
}

let settingsReady = false;
function persistSettings() {
  if (settingsReady) saveSettings({ ...settings }).catch(() => { /* lokal egal */ });
}

/** Alte Einstellungen (Version 1) übernehmen. */
function migrate(s) {
  if (!s || s.v === 2) return s || {};
  const m = {};
  const valid = (k) => (k && PRESETS[k] ? k : null);
  m.pdfProfile = valid(s.preset) || 'mittel';
  m.scanProfile = valid(s.prepPreset) || 'extrem-sw';
  if (s.prepOcr != null) m.scanOcr = !!s.prepOcr;
  if (s.ocr != null) m.pdfOcr = !!s.ocr;
  for (const k of ['ocrLang', 'scanDpi', 'scanColor', 'scanPages', 'scanDelay', 'autoPaperless']) if (s[k] != null) m[k] = s[k];
  if (m.scanDpi && !['100', '150', '200', '300', '600'].includes(String(m.scanDpi))) m.scanDpi = '300';
  return m;
}

async function applyStoredSettings() {
  try {
    const s = migrate(await loadSettings());
    settings = { ...DEFAULTS, ...s, v: 2 };
    if (!PRESETS[settings.scanProfile]) settings.scanProfile = DEFAULTS.scanProfile;
    if (!PRESETS[settings.pdfProfile]) settings.pdfProfile = DEFAULTS.pdfProfile;
  } catch { /* Erststart */ }
  settingsReady = true;
  syncSettingsUi();
  syncScanSheet();
}

if (hasFsAccess) {
  $$('.fs-only').forEach((el) => el.classList.remove('hidden'));
  $('#pickOutDirBtn').addEventListener('click', async () => {
    try {
      state.outDir = await window.showDirectoryPicker({ mode: 'readwrite' });
      $('#outDirInfo').textContent = `Fertige PDFs landen automatisch in „${state.outDir.name}“`;
      renderInspector();
      for (const d of state.docs) if (hasFresh(d) && !d.savedDir) await saveToDir(d, { quiet: true });
    } catch (e) {
      if (e?.name !== 'AbortError') toast(`Ordner nicht verfügbar: ${e?.message || e}`, 'err');
    }
  });
}

$('#exportDataBtn').addEventListener('click', async () => {
  const blob = await exportAllData();
  downloadBytes(new Uint8Array(await blob.arrayBuffer()), 'pdfpresser-daten.json', 'application/json');
});
$('#importDataBtn').addEventListener('click', () => $('#importDataInput').click());
$('#importDataInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const res = await importAllData(await file.text());
    $('#dataInfo').textContent = `Import erfolgreich: ${plural(res.signatures, 'Unterschrift', 'Unterschriften')} übernommen`;
    await applyStoredSettings();
    toast('Daten übernommen', 'ok');
  } catch (err) {
    toast(`Import fehlgeschlagen: ${err?.message || err}`, 'err', 5000);
  }
});

onSyncStatus((st, text) => {
  const row = $('#syncRow');
  if (!row || row.classList.contains('hidden')) return;
  $('#syncInfo').textContent = text;
});

// ---------------------------------------------------------------- Backend

let backendInit = { profile: false, raw: false };

async function fetchConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return false;
    const cfg = await res.json();
    Object.assign(backend, {
      scanner: !!cfg.scanner,
      consume: !!cfg.consume,
      paperless: cfg.paperless || (cfg.consume ? 'folder' : null),
      profile: !!cfg.profile,
      raw: !!cfg.raw,
      jobs: !!cfg.jobs,
      settings: !!cfg.settings,
      version: cfg.version || null,
      appVersion: cfg.appVersion || null,
      server: true,
    });
    return true;
  } catch {
    return false;   // kein Backend (z. B. GitHub Pages) – Funktionen bleiben aus
  }
}

/** Sichtbarkeit aller Server-Funktionen an den aktuellen Stand anpassen. */
function applyBackendUi() {
  const ver = backend.appVersion || APP_VERSION;
  $('#versionInfo').textContent = backend.server
    ? `${ver} (${backend.version}) · selbst gehostet`
    : `${APP_VERSION} · Web-Version (ohne Server-Funktionen)`;
  $$('.needs-server').forEach((el) => el.classList.toggle('hidden', !backend.settings));
  $$('[data-add="scanner"]').forEach((b) => b.classList.toggle('hidden', !backend.scanner));
  $$('.needs-scanner').forEach((el) => el.classList.toggle('hidden', !backend.scanner));
  $('#statusScanner').classList.toggle('hidden', !backend.scanner);
  $('#rawScanBtn').classList.toggle('hidden', !(backend.raw && backend.scanner));
  $$('.needs-paperless').forEach((el) => el.classList.toggle('hidden', !backend.consume));
  $('#statusPaperless').classList.toggle('hidden', !backend.consume);
  $('#statusPaperless span:last-child').textContent = backend.paperless === 'api' ? 'Paperless (API)' : 'Paperless (Ordner)';
  setScanProvider(backend.scanner ? () => fetchScannedPage() : null);
  syncScanSheet();
  renderAll();
}

async function detectBackend() {
  await fetchConfig();
  applyBackendUi();
  if (backend.scanner) checkScanner();
  if (backend.settings) loadServerSettings();
  if (backend.profile && !backendInit.profile) {
    backendInit.profile = true;
    $('#syncRow').classList.remove('hidden');
    enableServerProfile(true);
    await pullServerProfile();
    await applyStoredSettings();
  }
  if (backend.raw && !backendInit.raw) {
    backendInit.raw = true;
    $('#navInbox').classList.remove('hidden');
    $('#tabInbox').classList.remove('hidden');
    const prep = await import('./prepare.js');
    prep.initPrepare({
      openStudio,
      addPdfDoc,
      showView,
      scanIntoRaw: () => openScanSheet('raw'),
      scannerAvailable: () => backend.scanner,
      onCount: (n) => { $('#navRawCount').textContent = n || ''; },
    });
  }
  syncScanSheet();
  renderAll();
}

// ---------------------------------------------------------------- Server-Einstellungen (Scanner, Paperless)

let serverCfg = null;

async function loadServerSettings() {
  try {
    serverCfg = await api('/api/settings');
  } catch {
    return;
  }
  fillServerSettings();
}

function fillServerSettings() {
  const c = serverCfg;
  if (!c) return;
  const setVal = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v || ''; };
  setVal('#setScannerHost', c.scannerHost);
  $('#scannerHostHint').textContent = c.env.scannerHost
    ? `Aus der docker-compose.yml: ${c.env.scannerHost}${c.overridden.includes('scannerHost') ? ' – hier überschrieben' : ''}`
    : 'Leer lassen = kein Scanner. „Suchen“ findet AirScan/eSCL-Geräte im Netz.';
  setVal('#setPaperlessUrl', c.paperlessUrl);
  const tok = $('#setPaperlessToken');
  tok.value = '';
  tok.placeholder = c.tokenSet ? `gespeichert (${c.tokenFrom === 'env' ? 'aus der Compose' : 'in der App'}) – leer lassen zum Behalten` : 'Token einfügen';
  $('#paperlessTokenClear').classList.toggle('hidden', c.tokenFrom !== 'app');
  setVal('#setConsumeDir', c.consumeDir);
  $('#mountList').innerHTML = (c.mounts || []).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  const mounts = (c.mounts || []).filter((m) => m !== c.rawDir);
  $('#consumeHint').innerHTML = mounts.length
    ? `Eingebundene Ordner im Container: ${mounts.map((m) => `<code>${escapeHtml(m)}</code>`).join(', ')} – nur diese (und Unterordner) kommen auf dem ThinkCentre an.`
    : 'Pfad im Container. Er muss in der docker-compose.yml als Volume eingebunden sein.';
  const mode = c.paperless;
  $('#paperlessModeInfo').textContent = mode === 'api'
    ? `per API an ${c.paperlessUrl}${c.consumeDir ? ` · Rückfall: ${c.consumeDir}` : ''}`
    : mode === 'folder' ? `in den Ordner ${c.consumeDir}` : 'nicht eingerichtet';
  const pill = $('#paperlessPill');
  pill.querySelector('.dot').className = `dot ${mode ? 'on' : 'off'}`;
  pill.querySelector('span:last-child').textContent = mode === 'api' ? 'API' : mode === 'folder' ? 'Ordner' : 'aus';
}

async function saveServerSettings(patch, okText) {
  try {
    serverCfg = await api('/api/settings', { method: 'PUT', body: patch });
    fillServerSettings();
    await fetchConfig();
    applyBackendUi();
    if (backend.scanner) checkScanner();
    toast(okText, 'ok');
    return true;
  } catch (e) {
    toast(`Nicht gespeichert: ${e?.message || e}`, 'err', 6000);
    return false;
  }
}

$('#scannerSaveBtn').addEventListener('click', async () => {
  const host = $('#setScannerHost').value.trim();
  scanCaps.resolutions = null;
  await saveServerSettings({ scannerHost: host }, host ? 'Scanner-Adresse gespeichert' : 'Scanner-Adresse zurückgesetzt');
});

$('#scannerSearchBtn').addEventListener('click', async () => {
  const btn = $('#scannerSearchBtn');
  const box = $('#scannerFound');
  btn.disabled = true;
  btn.classList.add('busy');
  box.classList.remove('hidden');
  box.innerHTML = '<p class="faint">Suche im Netzwerk … (bis zu 20 s)</p>';
  try {
    // Das Netz, in dem das Handy/der Rechner die App geöffnet hat, ist meist auch das des Scanners
    const near = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : '';
    const r = await api(`/api/scanner/discover?near=${encodeURIComponent(near)}`);
    if (!r.found?.length) {
      box.innerHTML = `<p class="faint">Kein Scanner gefunden${r.nets?.length ? ` (gesucht in ${r.nets.map((n) => `${n}.x`).join(', ')})` : ''}. ${r.hint || 'Ist das Gerät an und im selben Netz? Adresse sonst von Hand eintragen.'}</p>`;
      return;
    }
    box.innerHTML = r.found.map((f) => `
      <div class="found-item">
        <span class="found-text"><strong>${escapeHtml(f.model)}</strong><small>${escapeHtml(f.host)}${f.resolutions?.length ? ` · ${f.resolutions.join('/')} dpi` : ''}</small></span>
        <button class="btn btn-small btn-primary" data-use-host="${escapeHtml(f.host)}">Übernehmen</button>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="err">Suche fehlgeschlagen: ${escapeHtml(e?.message || String(e))}</p>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
});

$('#scannerFound').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-use-host]');
  if (!b) return;
  $('#setScannerHost').value = b.dataset.useHost;
  if (await saveServerSettings({ scannerHost: b.dataset.useHost }, 'Scanner übernommen')) $('#scannerFound').classList.add('hidden');
});

function paperlessPatch() {
  const patch = { paperlessUrl: $('#setPaperlessUrl').value.trim() };
  const tok = $('#setPaperlessToken').value.trim();
  if (tok) patch.paperlessToken = tok;
  return patch;
}

$('#paperlessSaveBtn').addEventListener('click', () => saveServerSettings(paperlessPatch(), 'Paperless-Zugang gespeichert'));
$('#paperlessTokenClear').addEventListener('click', async () => {
  if (!(await confirmDialog('Token entfernen?', 'Der in der App gespeicherte API-Token wird gelöscht.', 'Entfernen', 'danger'))) return;
  saveServerSettings({ paperlessToken: null }, 'Token entfernt');
});
$('#paperlessTestBtn').addEventListener('click', async () => {
  const info = $('#paperlessTestInfo');
  const btn = $('#paperlessTestBtn');
  btn.classList.add('busy');
  btn.disabled = true;
  info.className = 'field-hint';
  info.textContent = 'Teste …';
  try {
    const p = paperlessPatch();
    const r = await api('/api/paperless/test', { method: 'POST', body: { url: p.paperlessUrl, token: p.paperlessToken } });
    if (!r.ok) throw new Error(r.error);
    info.className = 'field-hint ok';
    info.textContent = `Verbunden${r.version ? ` mit Paperless ${r.version}` : ''}${r.documents != null ? ` · ${r.documents} Dokumente` : ''}. Jetzt „Speichern“.`;
  } catch (e) {
    info.className = 'field-hint err';
    info.textContent = e?.message || String(e);
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
});
$('#consumeSaveBtn').addEventListener('click', () => {
  const v = $('#setConsumeDir').value.trim();
  saveServerSettings({ consumeDir: v }, v ? `consume-Ordner: ${v}` : 'consume-Ordner aus der Compose');
});

// A4-Bereich einrichten
$('#calibOpenBtn').addEventListener('click', async () => {
  const { openCalibration } = await import('./calibrate.js');
  openCalibration({
    rect: settings.scanRect,
    corner: settings.scanCorner,
    offX: settings.scanOffX,
    offY: settings.scanOffY,
    bed: scanCaps.bed,
    // Testscan in mittlerer Auflösung – geht schnell und reicht zum Ausrichten
    scan: () => fetchScannedPage({ dpi: '150' }),
    save: (rect, corner) => {
      settings.scanRect = rect;
      settings.scanCorner = corner;
      persistSettings();
      syncScanSheet();
      toast('A4-Bereich gespeichert – gilt für alle neuen Scans', 'ok');
    },
  });
});

// ---------------------------------------------------------------- PWA

async function registerSw() {
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    // Sobald ein Service Worker aktiv ist, liegt alles offline bereit
    navigator.serviceWorker.ready.then(() => $('#statusOffline').classList.remove('hidden'));
    // Regelmäßig nach Updates schauen, solange die App offen ist
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  } catch (e) {
    console.warn('Service-Worker-Registrierung fehlgeschlagen:', e);
  }
}

const busyForReload = () => !!working || batch.running
  || !!document.getElementById('scannerRoot') || ($('#editorRoot') && !$('#editorRoot').classList.contains('hidden'));

if ('serviceWorker' in navigator) {
  if (document.readyState === 'complete') registerSw();
  else window.addEventListener('load', registerSw);
  // Neue Version aktiv: sofort neu laden, wenn gerade nichts offen ist – sonst
  // freundlich anbieten (nie mitten in der Arbeit Dokumente verlieren).
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (window.__reloadedForUpdate) return;
    if (!busyForReload()) {
      window.__reloadedForUpdate = true;
      // Dokumente sind gespeichert – vorher noch ausstehende Änderungen sichern
      saveDocsNow().catch(() => {}).finally(() => location.reload());
    } else if (!state.updateReady) {
      state.updateReady = true;
      toast('Neue Version bereit – zum Neuladen hier tippen', 'info', 0, {
        onClick: () => { window.__reloadedForUpdate = true; location.reload(); },
      });
    }
  });
}

// Dokumente sind gespeichert – warnen nur, solange gerade gerechnet wird.
window.addEventListener('pagehide', () => { saveDocsNow().catch(() => {}); });
window.addEventListener('beforeunload', (e) => {
  if (working) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------- Start

const booted = applyStoredSettings()
  .then(() => restoreDocs())
  .then(() => { renderAll(); return detectBackend(); })
  .then(() => refreshJobBanner())
  .catch((e) => console.warn(e));
requestPersistence();
renderAll();
window.addEventListener('resize', renderToolbar);
// Trennlinie unter dem klebenden Kopf (Handy), sobald gescrollt wird
$('#main').addEventListener('scroll', (e) => e.currentTarget.classList.toggle('scrolled', e.currentTarget.scrollTop > 4), { passive: true });

// Für die automatisierten Tests
window.__pdfpresser = {
  state, backend, get settings() { return settings; },
  compressPdf, previewPage, simulateVariants, simulatePdf, PRESETS, PRESET_INFO,
  addFiles, addPdfDoc, enqueue, optsFor, hasFresh, sendToPaperless, openViewer, selectDoc,
  fetchScannedPage, followJob, refreshJobBanner, saveDocsNow, openStudio, toast, exportAllData, importAllData, persistSettings,
  applyStoredSettings, detectBackend, batch, booted,
  /** Für Tests: alle Einstellungen auf Werkszustand (auch im Serverprofil). */
  resetSettings(over = {}) {
    settings = { ...DEFAULTS, ...over };
    syncSettingsUi();
    syncScanSheet();
    persistSettings();
  },
};
