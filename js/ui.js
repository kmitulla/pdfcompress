// Gemeinsame Oberflächen-Bausteine: Rückmeldungen (Toast), Dialoge statt
// alert/confirm, Formatierung. Wird von App, Scan-Studio, Editor und
// Sammelordner gleichermaßen benutzt.

import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2).replace('.', ',')} MB`;
}

export function fmtPct(before, after) {
  if (!before || after == null) return '';
  const p = (1 - after / before) * 100;
  return `${p >= 0 ? '−' : '+'}${Math.abs(p).toFixed(0)} %`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- Toast

function toastHost() {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

const TOAST_ICON = { ok: 'check', err: 'info', busy: 'spinner', info: 'info' };

/**
 * Kurze Rückmeldung. `kind`: 'ok' | 'err' | 'busy' | 'info'.
 * Liefert {update(text, kind, ms), close()}.
 */
export function toast(text, kind = 'ok', ms = 3200, { onClick = null } = {}) {
  const el = document.createElement('div');
  const paint = (t, k) => {
    el.className = `toast toast-${k}`;
    el.innerHTML = `${icon(TOAST_ICON[k] || 'info', { size: 18 })}<span></span>`;
    el.querySelector('span').textContent = t;
  };
  paint(text, kind);
  toastHost().appendChild(el);
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  el.addEventListener('click', () => { close(); onClick?.(); });
  if (onClick) el.style.cursor = 'pointer';
  if (ms) timer = setTimeout(close, ms);
  return {
    update(newText, newKind = kind, newMs = 3200) {
      paint(newText, newKind);
      clearTimeout(timer);
      if (newMs) timer = setTimeout(close, newMs);
    },
    close,
  };
}

// ---------------------------------------------------------------- Dialog

/**
 * Modaler Dialog im App-Stil. Löst mit dem `value` des gewählten Knopfs auf
 * (Escape/Abbruch = null).
 *   buttons: [{ label, value, kind: 'primary'|'danger'|'ghost' }]
 *   input:   { value, placeholder } -> Rückgabe ist dann der eingegebene Text
 */
export function dialog({ title, text = '', buttons, input = null, icon: ic = null }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'dlg-wrap';
    wrap.innerHTML = `
      <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlgTitle">
        ${ic ? `<div class="dlg-icon">${icon(ic, { size: 26 })}</div>` : ''}
        <h2 id="dlgTitle"></h2>
        <p class="dlg-text"></p>
        ${input ? '<input class="dlg-input" type="text">' : ''}
        <div class="dlg-actions"></div>
      </div>`;
    wrap.querySelector('h2').textContent = title;
    const p = wrap.querySelector('.dlg-text');
    if (text) p.textContent = text; else p.remove();
    const field = wrap.querySelector('.dlg-input');
    if (field) {
      field.value = input.value || '';
      field.placeholder = input.placeholder || '';
    }
    const actions = wrap.querySelector('.dlg-actions');
    const finish = (v) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 200);
      resolve(v);
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = `btn ${b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-danger' : ''}`;
      btn.textContent = b.label;
      btn.dataset.value = String(b.value);
      btn.addEventListener('click', () => finish(field && b.value !== null ? field.value : b.value));
      actions.appendChild(btn);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
      if (e.key === 'Enter' && field) { e.preventDefault(); finish(field.value); }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
    document.body.appendChild(wrap);
    (field || actions.querySelector('.btn-primary') || actions.lastChild)?.focus();
  });
}

export async function confirmDialog(title, text, okLabel = 'OK', kind = 'primary') {
  const v = await dialog({
    title, text,
    buttons: [{ label: 'Abbrechen', value: false }, { label: okLabel, value: true, kind }],
  });
  return v === true;
}

export function alertDialog(title, text) {
  return dialog({ title, text, icon: 'info', buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
}

// ---------------------------------------------------------------- Datei teilen/öffnen

/** Bytes als Datei herunterladen. */
export function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * PDF in einem neuen Browser-Tab öffnen. Muss direkt aus dem Klick heraus
 * laufen (kein await davor), sonst blockt der Browser das Fenster.
 */
export function openInBrowser(bytes, name) {
  const file = new File([bytes], name, { type: 'application/pdf' });
  const url = URL.createObjectURL(file);
  const win = window.open(url, '_blank');
  if (!win) {
    // Popup blockiert (oder iOS-Standalone): im selben Tab anzeigen
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  return !!win;
}

export const canShareFiles = () => {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
};

/** Über den System-Teilen-Dialog weitergeben. Liefert 'shared' | 'aborted' | 'unsupported'. */
export async function shareBytes(bytes, name) {
  const file = new File([bytes], name, { type: 'application/pdf' });
  if (!canShareFiles() || !navigator.canShare({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({ files: [file], title: name });
    return 'shared';
  } catch (e) {
    if (e?.name === 'AbortError') return 'aborted';
    throw e;
  }
}

/** Platzhalter-Knöpfe <i data-icon> befüllen – Re-Export für Module ohne eigenen Import. */
export { icon };
