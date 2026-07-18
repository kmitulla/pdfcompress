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

export const kvGet = (key) => idb('readonly', (s) => s.get(key));
export const kvSet = (key, value) => idb('readwrite', (s) => s.put(value, key));
export const kvDel = (key) => idb('readwrite', (s) => s.delete(key));

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
  await kvSet('settings', data.settings || {});
  return { signatures: data.signatures.length };
}
