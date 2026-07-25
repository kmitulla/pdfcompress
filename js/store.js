// Lokale Datenhaltung: IndexedDB für Unterschriften & Einstellungen.
// Alles bleibt auf dem Gerät; Export/Import als JSON-Datei für den Umzug
// in einen anderen Browser.

const DB_NAME = 'pdfpresser';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = fn(store);
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const kvGetLocal = (key) => idb('readonly', (s) => s.get(key));
const kvSetLocal = (key, value) => idb('readwrite', (s) => s.put(value, key));

export const kvGet = kvGetLocal;
export const kvDel = (key) => idb('readwrite', (s) => s.delete(key));

// ---------------------------------------------------------------- Server-Profil
//
// Nur in der selbst gehosteten Variante: Einstellungen, Unterschriften und
// Stempel liegen zusätzlich auf dem eigenen Server, damit iPhone und Laptop
// denselben Stand sehen. Ohne Backend (z. B. GitHub Pages) bleibt alles rein
// lokal in IndexedDB – dort wird nie etwas nach außen geschickt.

const SYNC_KEYS = ['signatures', 'stamps', 'settings'];
let serverProfile = false;      // Backend bietet Profilspeicher an?
let syncTimer = null;
let syncListener = null;
// Schlüssel, die seit dem Start lokal geändert wurden. Der (asynchron
// eintreffende) Serverstand darf sie nicht überschreiben – sonst geht eine
// Änderung verloren, die man direkt nach dem Öffnen macht, während das Profil
// noch geladen wird.
const locallyChanged = new Set();

/** Wird von der App aufgerufen, sobald /api/config bekannt ist. */
export function enableServerProfile(on) {
  serverProfile = !!on;
}
export const hasServerProfile = () => serverProfile;

/** Callback für die Statusanzeige: ('syncing' | 'ok' | 'error', text). */
export function onSyncStatus(fn) {
  syncListener = fn;
}
function status(state, text) {
  if (syncListener) syncListener(state, text);
}

/** Lokalen Stand zum Server schieben (gebündelt, damit nicht jeder Tastendruck sendet). */
function scheduleUpload() {
  if (!serverProfile) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      status('syncing', 'Wird auf dem Server gespeichert …');
      const payload = {};
      for (const k of SYNC_KEYS) payload[k] = (await kvGetLocal(k)) ?? (k === 'settings' ? {} : []);
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status('ok', 'Auf dem Server gespeichert – gilt auf allen deinen Geräten.');
    } catch (e) {
      status('error', `Server-Speicher nicht erreichbar: ${e?.message || e}`);
    }
  }, 800);
}

/** Beim Start: Serverstand holen und lokal übernehmen. */
export async function pullServerProfile() {
  if (!serverProfile) return false;
  try {
    const res = await fetch('/api/profile', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let got = false;
    for (const k of SYNC_KEYS) {
      if (data[k] === undefined) continue;
      if (locallyChanged.has(k)) continue;   // frische lokale Änderung hat Vorrang
      await kvSetLocal(k, data[k]);
      got = true;
    }
    status('ok', 'Server-Speicher aktiv – Unterschriften & Einstellungen gelten auf allen deinen Geräten.');
    return got;
  } catch (e) {
    status('error', `Server-Speicher nicht erreichbar: ${e?.message || e}`);
    return false;
  }
}

// Schreiben geht immer zuerst lokal (offline-fähig) und wird dann hochgeschoben.
export async function kvSet(key, value) {
  await kvSetLocal(key, value);
  if (SYNC_KEYS.includes(key)) {
    locallyChanged.add(key);
    scheduleUpload();
  }
}

// Browser bitten, die Daten dauerhaft zu behalten (nicht bei Platzmangel löschen)
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* optional */ }
  return false;
}

// ---------------------------------------------------------------- Unterschriften

export async function listSignatures() {
  return (await kvGet('signatures')) || [];
}

export async function saveSignature(sig) {
  const sigs = await listSignatures();
  sig.id = sig.id || `sig${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  sig.created = sig.created || Date.now();
  sigs.push(sig);
  await kvSet('signatures', sigs);
  return sig.id;
}

export async function deleteSignature(id) {
  const sigs = (await listSignatures()).filter((s) => s.id !== id);
  await kvSet('signatures', sigs);
}

// ---------------------------------------------------------------- Stempel-Vorlagen

export async function listStamps() {
  return (await kvGet('stamps')) || [];
}

export async function saveStamp(stamp) {
  const stamps = await listStamps();
  stamp.id = stamp.id || `st${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  stamps.push(stamp);
  await kvSet('stamps', stamps);
  return stamp.id;
}

export async function deleteStamp(id) {
  await kvSet('stamps', (await listStamps()).filter((s) => s.id !== id));
}

// ---------------------------------------------------------------- Einstellungen

export async function loadSettings() {
  return (await kvGet('settings')) || {};
}

export async function saveSettings(settings) {
  await kvSet('settings', settings);
}

// ---------------------------------------------------------------- Export/Import

export async function exportAllData() {
  const data = {
    app: 'pdfpresser',
    version: 1,
    exported: new Date().toISOString(),
    signatures: await listSignatures(),
    stamps: await listStamps(),
    settings: await loadSettings(),
  };
  return new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
}

// Ersetzt die lokalen Daten 1:1 durch den Inhalt der Export-Datei
export async function importAllData(jsonText) {
  const data = JSON.parse(jsonText);
  if (data.app !== 'pdfpresser' || !Array.isArray(data.signatures)) {
    throw new Error('Keine gültige PDF-Presser-Datendatei');
  }
  await kvSet('signatures', data.signatures);
  await kvSet('stamps', data.stamps || []);
  await kvSet('settings', data.settings || {});
  return { signatures: data.signatures.length };
}
