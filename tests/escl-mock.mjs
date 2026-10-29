// Nachgebauter eSCL-Scanner für die Tests – verhält sich wie ein strenger
// Epson: nur bestimmte Auflösungen, kein 1-Bit-JPEG, ein hängender Auftrag
// blockiert mit 409, bis er gelöscht wird.
import http from 'node:http';

const CAPS = (res) => `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.63</pwg:Version>
  <pwg:MakeAndModel>EPSON ET-2720 Series</pwg:MakeAndModel>
  <scan:Platen><scan:PlatenInputCaps>
    <scan:MinWidth>16</scan:MinWidth><scan:MaxWidth>2550</scan:MaxWidth>
    <scan:MinHeight>16</scan:MinHeight><scan:MaxHeight>3508</scan:MaxHeight>
    <scan:SettingProfiles><scan:SettingProfile>
      <scan:ColorModes><scan:ColorMode>BlackAndWhite1</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode><scan:ColorMode>RGB24</scan:ColorMode></scan:ColorModes>
      <scan:DocumentFormats><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><pwg:DocumentFormat>application/pdf</pwg:DocumentFormat></scan:DocumentFormats>
      <scan:SupportedResolutions><scan:DiscreteResolutions>
        ${res.map((d) => `<scan:DiscreteResolution><scan:XResolution>${d}</scan:XResolution><scan:YResolution>${d}</scan:YResolution></scan:DiscreteResolution>`).join('')}
      </scan:DiscreteResolutions></scan:SupportedResolutions>
    </scan:SettingProfile></scan:SettingProfiles>
  </scan:PlatenInputCaps></scan:Platen>
</scan:ScannerCapabilities>`;

const tag = (xml, t) => (new RegExp(`<(?:\\w+:)?${t}>([^<]*)<`).exec(xml) || [])[1];

/**
 * @param {{port:number, resolutions?:number[], image?:(settings)=>Buffer, delayMs?:number, hangingJob?:boolean}} o
 *
 * Steuerung von außen (für die Tests):
 *   POST /__mock/image?dpi=300   Rumpf = JPEG, das bei dieser Auflösung geliefert wird
 *   POST /__mock/config          {"delayMs":…, "rejectFirst":…, "hangingJob":true}
 *   POST /__mock/reset           alles zurücksetzen
 *   GET  /__mock/state           eingegangene Scan-Aufträge
 */
export function startMockScanner(o) {
  const state = {
    jobs: new Map(),   // id -> {state, settings, served}
    posts: [],          // eingegangene ScanSettings
    next: 1,
    rejectFirst: 0,     // so viele POSTs mit 503 ablehnen
  };
  if (o.hangingJob) state.jobs.set('stale', { state: 'Processing', settings: {}, served: false });
  const images = {};
  const imageFor = (settings) => images[settings.dpi] || images.any || o.image?.(settings) || null;
  const resolutions = o.resolutions || [100, 200, 300, 600];
  const busy = () => [...state.jobs.values()].some((j) => j.state === 'Processing');
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString('utf8');
      const u = req.url;
      if (u.startsWith('/__mock/')) {
        const url = new URL(u, 'http://x');
        if (url.pathname === '/__mock/image') images[url.searchParams.get('dpi') || 'any'] = raw;
        if (url.pathname === '/__mock/config') {
          const c = JSON.parse(body || '{}');
          if (c.delayMs != null) o.delayMs = c.delayMs;
          if (c.rejectFirst != null) state.rejectFirst = c.rejectFirst;
          if (c.hangingJob) state.jobs.set('stale', { state: 'Processing', settings: {}, served: false });
        }
        if (url.pathname === '/__mock/reset') {
          for (const k of Object.keys(images)) delete images[k];
          state.jobs.clear();
          state.posts.length = 0;
          state.rejectFirst = 0;
          o.delayMs = 0;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ posts: state.posts, jobs: [...state.jobs.keys()] }));
      }
      if (u === '/eSCL/ScannerCapabilities') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(CAPS(resolutions));
      }
      if (u === '/eSCL/ScannerStatus') {
        const jobs = [...state.jobs.entries()].map(([id, j]) => `<scan:JobInfo><pwg:JobUri>/eSCL/ScanJobs/${id}</pwg:JobUri><pwg:JobState>${j.state}</pwg:JobState></scan:JobInfo>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(`<scan:ScannerStatus xmlns:scan="x" xmlns:pwg="y"><pwg:Version>2.63</pwg:Version><pwg:State>${busy() ? 'Processing' : 'Idle'}</pwg:State><scan:Jobs>${jobs}</scan:Jobs></scan:ScannerStatus>`);
      }
      if (u === '/eSCL/ScanJobs' && req.method === 'POST') {
        const settings = { dpi: +tag(body, 'XResolution'), color: tag(body, 'ColorMode'), format: tag(body, 'DocumentFormat') };
        state.posts.push(settings);
        if (state.rejectFirst > 0) { state.rejectFirst--; res.writeHead(503); return res.end(); }
        if (busy()) { res.writeHead(409); return res.end(); }
        if (!resolutions.includes(settings.dpi)) { res.writeHead(409); return res.end(); }
        if (settings.color === 'BlackAndWhite1' && settings.format === 'image/jpeg') { res.writeHead(409); return res.end(); }
        const id = `job${state.next++}`;
        state.jobs.set(id, { state: 'Processing', settings, served: false });
        res.writeHead(201, { Location: `/eSCL/ScanJobs/${id}` });
        return res.end();
      }
      const m = /^\/eSCL\/ScanJobs\/(\w+)(\/NextDocument)?$/.exec(u);
      if (m) {
        const job = state.jobs.get(m[1]);
        if (!job) { res.writeHead(404); return res.end(); }
        if (req.method === 'DELETE') { state.jobs.delete(m[1]); res.writeHead(200); return res.end(); }
        if (m[2]) {
          if (job.served) { job.state = 'Completed'; res.writeHead(404); return res.end(); }
          if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
          job.served = true;
          const img = imageFor(job.settings);
          if (!img) { res.writeHead(500); return res.end('kein Testbild'); }
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': img.length });
          return res.end(img);
        }
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(o.port, () => resolve({ server, state, close: () => new Promise((r) => server.close(r)) })));
}
