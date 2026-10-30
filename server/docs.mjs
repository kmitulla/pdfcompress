// Dokumente auf dem Server: Damit alles, was gescannt oder hinzugefügt wird,
// auf jedem Gerät auftaucht (iPhone scannen, am Laptop weitermachen).
//
// Ablage je Dokument in DATA_DIR/docs/<id>/:
//   meta.json     Name, Profil, Optionen, Status, Miniatur, Zeitstempel …
//   original.pdf  das (ggf. bearbeitete) Ausgangs-PDF
//   result.pdf    das fertige, komprimierte PDF (falls vorhanden)
//
// Die App schreibt nur, was sich geändert hat; zuletzt geschrieben gewinnt.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

let dir = null;
const MAX_META = 2 * 1024 * 1024;   // Miniatur als Data-URL passt locker hinein

export const validId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const docDir = (id) => path.join(dir, id);

export function initDocs(dataDir) {
  dir = path.join(dataDir, 'docs');
  fs.mkdirSync(dir, { recursive: true });
}

async function writeAtomic(file, data) {
  await fsp.writeFile(`${file}.tmp`, data);
  await fsp.rename(`${file}.tmp`, file);
}

export async function listDocs() {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const id of names) {
    if (!validId(id)) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(docDir(id), 'meta.json'), 'utf8'));
      // Ohne Original ist das Dokument (noch) nicht vollständig hochgeladen
      const st = await fsp.stat(path.join(docDir(id), 'original.pdf')).catch(() => null);
      if (!st) continue;
      out.push({ ...meta, id, bytesLen: st.size });
    } catch { /* halb geschrieben – überspringen */ }
  }
  out.sort((a, b) => (a.created || 0) - (b.created || 0));
  return out;
}

export async function putMeta(id, meta) {
  const json = JSON.stringify({ ...meta, id });
  if (json.length > MAX_META) throw Object.assign(new Error('Metadaten zu groß'), { status: 413 });
  await fsp.mkdir(docDir(id), { recursive: true });
  await writeAtomic(path.join(docDir(id), 'meta.json'), json);
  if (!meta.hasResult) await fsp.rm(path.join(docDir(id), 'result.pdf'), { force: true });
}

export async function putFile(id, kind, data) {
  await fsp.mkdir(docDir(id), { recursive: true });
  await writeAtomic(path.join(docDir(id), `${kind}.pdf`), data);
}

export async function getFile(id, kind) {
  return fsp.readFile(path.join(docDir(id), `${kind}.pdf`));
}

export async function deleteDoc(id) {
  await fsp.rm(docDir(id), { recursive: true, force: true });
}
