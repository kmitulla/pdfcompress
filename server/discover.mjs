// Netzwerk-Scanner suchen: alle Adressen eines /24-Netzes auf Port 80/443
// antasten und dort, wo etwas antwortet, nach eSCL-Fähigkeiten fragen.
// (mDNS/Bonjour kommt aus einem Docker-Bridge-Netz meist nicht heraus – das
// direkte Antasten funktioniert dagegen überall.)

import net from 'node:net';
import os from 'node:os';
import { request, parseCapabilities } from './escl.mjs';

const PRIVATE = /^(10\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}|192\.168\.\d{1,3})$/;

/** Prüft, ob „a.b.c“ ein privates /24-Netz ist. */
export function validSubnet(s) {
  return typeof s === 'string' && PRIVATE.test(s) && s.split('.').every((x) => +x <= 255);
}

/** Netze, in denen gesucht wird: vom Browser gemeldet + eigene Schnittstellen. */
export function subnets(hints = []) {
  const out = new Set();
  for (const h of hints) {
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(String(h || '').replace(/^https?:\/\//, '').split(/[:/]/)[0]);
    if (m && validSubnet(m[1])) out.add(m[1]);
    else if (validSubnet(h)) out.add(h);
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const sub = a.address.split('.').slice(0, 3).join('.');
      // Docker-interne Netze (172.17–31) bringen nichts
      if (validSubnet(sub) && !/^172\.(1[7-9]|2\d|3[01])\./.test(sub)) out.add(sub);
    }
  }
  return [...out].slice(0, 3);
}

function portOpen(host, port, timeout = 450) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function probe(ip) {
  for (const [port, proto] of [[443, 'https'], [80, 'http']]) {
    if (!(await portOpen(ip, port))) continue;
    try {
      const r = await request(`${proto}://${ip}${port === 443 || port === 80 ? '' : `:${port}`}/eSCL/ScannerCapabilities`, { timeout: 3500 });
      if (r.status === 200 && /ScannerCapabilities/i.test(r.body.toString('utf8', 0, 4000))) {
        const caps = parseCapabilities(r.body.toString('utf8'));
        return { host: `${proto}://${ip}`, ip, model: caps.model, resolutions: caps.resolutions, colorModes: caps.colorModes };
      }
    } catch { /* kein eSCL */ }
  }
  return null;
}

/** Sucht in den angegebenen Netzen; liefert gefundene Scanner. */
export async function discover(nets, { concurrency = 48 } = {}) {
  const ips = [];
  for (const n of nets) for (let i = 1; i < 255; i++) ips.push(`${n}.${i}`);
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < ips.length) {
      const ip = ips[next++];
      const hit = await probe(ip);
      if (hit) found.push(hit);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  return found.sort((a, b) => a.ip.localeCompare(b.ip, 'en', { numeric: true }));
}
