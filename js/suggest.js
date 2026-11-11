// Vorschläge aus dem erkannten Text eines Dokuments: Datum und Name.
// Bewusst einfache, nachvollziehbare Regeln – lieber kein Vorschlag als ein
// falscher.

const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
const pad = (n) => String(n).padStart(2, '0');

function valid(y, m, d) {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Alle Datumsangaben im Text, in Reihenfolge des Auftretens (ohne Doppelte). */
export function findDates(text) {
  const out = [];
  const add = (iso, at) => { if (iso && !out.some((x) => x.iso === iso)) out.push({ iso, at }); };
  const t = String(text || '');
  for (const m of t.matchAll(/\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b/g)) add(valid(+m[3], +m[2], +m[1]), m.index);
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(valid(+m[1], +m[2], +m[3]), m.index);
  const re = new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'gi');
  for (const m of t.matchAll(re)) add(valid(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]), m.index);
  return out.sort((a, b) => a.at - b.at).map((x) => x.iso);
}

// Dokumentarten, nach Häufigkeit in einem Privathaushalt
const KINDS = [
  ['Mahnung', /\bmahnung\b/i],
  ['Rechnung', /\b(rechnung|invoice)\b/i],
  ['Gutschrift', /\bgutschrift\b/i],
  ['Kündigung', /\bkündigung\b/i],
  ['Vertrag', /\b(vertrag|vereinbarung)\b/i],
  ['Bescheid', /\b(bescheid|steuerbescheid)\b/i],
  ['Lohnabrechnung', /\b(lohnabrechnung|gehaltsabrechnung|entgeltabrechnung|verdienstabrechnung)\b/i],
  ['Kontoauszug', /\bkontoauszug\b/i],
  ['Jahresabrechnung', /\b(jahresabrechnung|nebenkostenabrechnung|betriebskostenabrechnung)\b/i],
  ['Angebot', /\bangebot\b/i],
  ['Auftragsbestätigung', /\bauftragsbestätigung\b/i],
  ['Quittung', /\b(quittung|kassenbon|beleg)\b/i],
  ['Lieferschein', /\blieferschein\b/i],
  ['Versicherungsschein', /\b(versicherungsschein|police)\b/i],
  ['Bestätigung', /\bbestätigung\b/i],
  ['Kostenvoranschlag', /\bkostenvoranschlag\b/i],
  ['Attest', /\b(attest|arbeitsunfähigkeit)\b/i],
  ['Zeugnis', /\bzeugnis\b/i],
];

/**
 * Namensvorschlag, z. B. „Rechnung 2026-114 – 2026-10-03“.
 * Nur wenn eine Dokumentart erkennbar ist.
 */
export function suggestTitle(text) {
  const t = String(text || '');
  if (t.replace(/\s+/g, '').length < 20) return null;
  // Die Art, die zuerst im Text steht (Überschriften stehen oben)
  let kind = null;
  let at = Infinity;
  for (const [name, re] of KINDS) {
    const m = re.exec(t);
    if (m && m.index < at) { kind = name; at = m.index; }
  }
  if (!kind) return null;
  let title = kind;
  // Nummer direkt hinter „Rechnung Nr.“, „Rechnungsnummer:“ …
  const num = /\b(?:rechnungs?|kunden|vertrags|beleg|auftrags)?(?:-?nr\.?|-?nummer)\s*[:.#]?\s*([A-Z0-9][\w/.-]{2,20})/i.exec(t)
    || new RegExp(`${kind}\\s+(?:nr\\.?\\s*)?([0-9][\\w/.-]{2,20})`, 'i').exec(t);
  if (num && /\d/.test(num[1])) title += ` ${num[1].replace(/[.,:]+$/, '')}`;
  const date = findDates(t)[0];
  if (date) title += ` – ${date}`;
  return title.slice(0, 80);
}

/** Ist das ein automatisch vergebener Name (lohnt sich ein Vorschlag)? */
export const isGenericName = (name) => /^(Scan|Foto|Dokument|IMG|image|scan)[\s_-]?[\d\s_.:-]*(\(\d+\))?$/i.test(String(name || '').trim())
  || /^Scan \d{4}-\d{2}-\d{2}/.test(String(name || ''));
