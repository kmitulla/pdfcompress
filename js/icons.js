// Icon-Set: schlanke SVG-Strichsymbole im SF-Symbols-Stil (iOS).
// Bewusst inline statt Icon-Font/Sprite-Datei – so bleibt alles offline-fähig
// und die Icons erben Farbe (currentColor) und Strichstärke vom Kontext.

const P = {
  // Navigation & Status
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4.5 12.75l5 5 10-10.5"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronDown: '<path d="M5 9l7 7 7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.75v.01"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/>',
  offline: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  spinner: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',

  // Dokumente & Dateien
  doc: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  docPlus: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  docStack: '<rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 7v12a2 2 0 002 2h10"/>',
  download: '<path d="M12 3v13M7 11l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 21V8M7 13l5-5 5 5M4 4h16"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  trash: '<path d="M4 7h16M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7M6 7l1 12.5A1.5 1.5 0 008.5 21h7a1.5 1.5 0 001.5-1.5L18 7"/>',
  share: '<path d="M12 15V4M8 7.5L12 3.5l4 4M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 002 2h10a2 2 0 002-2V9M10 13h4"/>',
  duplicate: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0012.5 3h-7A2.5 2.5 0 003 5.5v7A2.5 2.5 0 005.5 15"/>',

  // Scannen & Kamera
  camera: '<path d="M4 8.5a2 2 0 012-2h1.8l1.3-2h7.8l1.3 2H20a2 2 0 012 2V18a2 2 0 01-2 2H6a2 2 0 01-2-2z" transform="translate(-1 0)"/><circle cx="11" cy="13" r="3.4"/>',
  scanner: '<rect x="3" y="4" width="18" height="7" rx="2"/><path d="M6.5 15h11a2 2 0 012 2v2a2 2 0 01-2 2h-11a2 2 0 01-2-2v-2a2 2 0 012-2zM7 7.5h6"/>',
  scanFrame: '<path d="M4 9V6a2 2 0 012-2h3M15 4h3a2 2 0 012 2v3M20 15v3a2 2 0 01-2 2h-3M9 20H6a2 2 0 01-2-2v-3M4 12h16"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l4.5-4.5 3.5 3.5 3-3L20 17"/>',
  bolt: '<path d="M13 3L5.5 13.5H11l-1 7.5 8-11H12z"/>',
  rotate: '<path d="M20 12a8 8 0 11-2.6-5.9M20 4v4.5h-4.5"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14M18 22V8a2 2 0 00-2-2H2"/>',
  wand: '<path d="M4 20L15 9M17.5 6.5l-2-2M18 3v3M21 6h-3M13 4.5l1.5 1.5M20 11l-1.5-1.5"/>',
  square: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/>',
  eraser: '<path d="M8 20l-4-4a2 2 0 010-2.8l8-8a2 2 0 012.8 0l4.2 4.2a2 2 0 010 2.8L13 20zM10 20h10"/>',
  undo: '<path d="M4 9h11a5 5 0 010 10h-6M4 9l4-4M4 9l4 4"/>',
  redo: '<path d="M20 9H9a5 5 0 000 10h6M20 9l-4-4M20 9l-4 4"/>',

  // Bearbeiten
  pen: '<path d="M4 20l4-1 11-11a2.1 2.1 0 00-3-3L5 16z"/><path d="M14.5 6.5l3 3"/>',
  signature: '<path d="M3 17c3-6 5 3 7-1s3-8 5-4 2 5 6 5"/><path d="M3 21h18"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  marker: '<path d="M9 15l-3 5 5-2 9-9a2.5 2.5 0 00-3.5-3.5z"/><path d="M6.5 20H3"/>',
  stamp: '<path d="M8 10.5a4 4 0 118 0c0 2-1.5 2.5-1.5 4h-5C9.5 13 8 12.5 8 10.5z"/><path d="M5 18.5h14M4 21.5h16"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  text_search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8.5 9h5M8.5 13h3"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5l1.2 2.4 2.6-.5.4 2.6 2.4 1.2-1.4 2.3 1.4 2.3-2.4 1.2-.4 2.6-2.6-.5L12 21.5l-1.2-2.4-2.6.5-.4-2.6-2.4-1.2L6.8 13 5.4 10.7l2.4-1.2.4-2.6 2.6.5z"/>',
  cloud: '<path d="M7 18a4 4 0 01-.6-7.95A5.5 5.5 0 0117.5 10 3.75 3.75 0 0117 18z"/>',
  device: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 5.5h3"/>',
};

const SIZE_DEFAULT = 20;

/** SVG-Markup für ein Icon. `cls` landet als zusätzliche Klasse am <svg>. */
export function icon(name, { size = SIZE_DEFAULT, cls = '', stroke = 1.7 } = {}) {
  const path = P[name];
  if (!path) return '';
  return `<svg class="icn ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${path}</svg>`;
}

/**
 * Ersetzt alle `<i data-icon="name">`-Platzhalter im Baum durch echte SVGs.
 * So bleibt das HTML lesbar und die Icons stehen an einer Stelle.
 */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]:not([data-icon-done])').forEach((el) => {
    const name = el.dataset.icon;
    const size = parseInt(el.dataset.iconSize, 10) || SIZE_DEFAULT;
    const svg = icon(name, { size });
    if (!svg) return;
    el.innerHTML = svg;
    el.setAttribute('data-icon-done', '');
  });
}

export const ICON_NAMES = Object.keys(P);
