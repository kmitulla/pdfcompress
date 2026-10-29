// Einstellungen des Servers, die sich in der App ändern lassen (Scanner,
// Paperless-Ordner, Paperless-API). Gespeichert in DATA_DIR/config.json – was
// dort steht, hat Vorrang vor den Umgebungsvariablen der docker-compose.yml.
// Ein leerer Eintrag in der App heißt: wieder den Wert aus der Compose nehmen.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const env = (k) => (process.env[k] || '').trim();

export const ENV = {
  scannerHost: env('SCANNER_HOST'),
  consumeDir: env('CONSUME_DIR'),
  paperlessUrl: env('PAPERLESS_URL').replace(/\/+$/, ''),
  paperlessToken: env('PAPERLESS_TOKEN'),
};

const KEYS = Object.keys(ENV);
let file = null;
let saved = {};

export function loadConfig(dataDir) {
  file = path.join(dataDir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved = Object.fromEntries(KEYS.filter((k) => typeof raw[k] === 'string').map((k) => [k, raw[k]]));
  } catch {
    saved = {};
  }
}

/** Aktuell gültiger Wert: App-Einstellung, sonst Umgebungsvariable. */
export function get(key) {
  const v = saved[key];
  if (key === 'paperlessToken' && !v && saved.paperlessUrl && saved.paperlessUrl !== ENV.paperlessUrl) {
    // Der Token aus der Compose gehört zu deren Adresse – nie an eine in der
    // App geänderte Adresse schicken.
    return '';
  }
  return v !== undefined && v !== '' ? v : ENV[key];
}

export const current = () => Object.fromEntries(KEYS.map((k) => [k, get(k)]));

export function paperlessMode() {
  if (get('paperlessUrl') && get('paperlessToken')) return 'api';
  return get('consumeDir') ? 'folder' : null;
}

/** Ansicht für die App – der Token wird nie zurückgegeben, nur ob er gesetzt ist. */
export function publicView() {
  const c = current();
  return {
    scannerHost: c.scannerHost,
    consumeDir: c.consumeDir,
    paperlessUrl: c.paperlessUrl,
    tokenSet: !!c.paperlessToken,
    tokenFrom: saved.paperlessToken ? 'app' : (ENV.paperlessToken ? 'env' : null),
    paperless: paperlessMode(),
    // Was in der docker-compose.yml steht (zum Anzeigen „Standard: …“)
    env: { scannerHost: ENV.scannerHost, consumeDir: ENV.consumeDir, paperlessUrl: ENV.paperlessUrl, tokenSet: !!ENV.paperlessToken },
    overridden: KEYS.filter((k) => saved[k]),
  };
}

function normalize(key, value) {
  let v = String(value ?? '').trim();
  if (key === 'paperlessUrl') {
    v = v.replace(/\/+$/, '').replace(/\/api$/i, '');
    if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`;
    if (v) new URL(v);   // wirft bei Unsinn
  }
  if (key === 'consumeDir' && v) {
    if (!path.isAbsolute(v)) throw new Error('Der Ordner muss ein absoluter Pfad sein (z. B. /data/consume).');
    v = path.resolve(v);
  }
  if (key === 'scannerHost' && v && /\s/.test(v)) throw new Error('Ungültige Scanner-Adresse.');
  return v;
}

/** Teil-Update; null oder '' entfernt den App-Wert (zurück zur Compose). */
export async function update(patch) {
  const next = { ...saved };
  for (const k of KEYS) {
    if (!(k in patch)) continue;
    // Token: undefined = unverändert lassen; null/'' = löschen
    const v = patch[k] === null ? '' : normalize(k, patch[k]);
    if (v) next[k] = v; else delete next[k];
  }
  // Neue Paperless-Adresse ohne neuen Token: alten Token verwerfen, damit er
  // nicht an eine andere Gegenstelle geht.
  if ('paperlessUrl' in patch && !('paperlessToken' in patch) && (next.paperlessUrl || '') !== (saved.paperlessUrl || '')) {
    delete next.paperlessToken;
  }
  if (next.consumeDir && next.consumeDir !== saved.consumeDir) {
    await fsp.mkdir(next.consumeDir, { recursive: true });
    await fsp.access(next.consumeDir, fs.constants.W_OK);
  }
  saved = next;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(saved, null, 2));
  await fsp.rename(`${file}.tmp`, file);
  return publicView();
}

/**
 * Eingebundene Ordner des Containers (aus /proc/self/mountinfo) – das sind
 * die Orte, die auch außerhalb des Containers ankommen.
 */
export function mountedFolders() {
  let text = '';
  try { text = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return []; }
  const skip = /^\/(proc|sys|dev|run|etc|usr|lib|bin|sbin|var\/lib|app|tmp|opt|mnt\/sandboxing)(\/|$)|^\/$/;
  const out = new Set();
  for (const line of text.split('\n')) {
    const mp = line.split(' ')[4];
    if (!mp || skip.test(mp)) continue;
    try {
      if (fs.statSync(mp).isDirectory()) out.add(mp.replace(/\\040/g, ' '));
    } catch { /* weg */ }
  }
  return [...out].sort();
}
