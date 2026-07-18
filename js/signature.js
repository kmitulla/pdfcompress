// Unterschriften: Foto-Freistellung (Schwellwert/Helligkeit/Kontrast/Farbe)
// und Glättung gezeichneter Striche (Catmull-Rom -> kubische Bezierkurven),
// damit Unterschriften als saubere Vektoren im PDF landen.

// ---------------------------------------------------------------- Foto -> freigestellt

// opts: { threshold: 0..100, brightness: -100..100, contrast: -100..100,
//         color: '#rrggbb' | 'original' }
// Liefert Canvas mit transparentem Hintergrund, auf Inhalt beschnitten.
export function processSignatureImage(source, opts) {
  const maxDim = 1600;
  const s = Math.min(1, maxDim / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * s));
  const h = Math.max(1, Math.round(source.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  const bright = (opts.brightness || 0) * 1.27;
  const c = (opts.contrast || 0) / 100;
  const cf = (1 + c) / (1 - Math.min(0.99, c));
  const thr = 40 + ((opts.threshold ?? 50) / 100) * 180; // 40..220
  const soft = 26; // weiche Kante für glatte Ränder
  let ink = null;
  if (opts.color && opts.color !== 'original') {
    ink = [
      parseInt(opts.color.slice(1, 3), 16),
      parseInt(opts.color.slice(3, 5), 16),
      parseInt(opts.color.slice(5, 7), 16),
    ];
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      let lum = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8;
      lum = Math.max(0, Math.min(255, cf * (lum - 128) + 128 + bright));
      // dunkler als Schwellwert -> Tinte; weiche Übergangszone
      const alpha = Math.max(0, Math.min(1, (thr - lum) / soft + 0.5));
      if (alpha > 0.02) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      d[p + 3] = Math.round(alpha * 255);
      if (ink) {
        d[p] = ink[0];
        d[p + 1] = ink[1];
        d[p + 2] = ink[2];
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  if (maxX < 0) return canvas; // nichts erkannt -> unbeschnitten zurück
  const pad = 8;
  const cx = Math.max(0, minX - pad);
  const cy = Math.max(0, minY - pad);
  const cw = Math.min(w, maxX + pad + 1) - cx;
  const ch = Math.min(h, maxY + pad + 1) - cy;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
  return out;
}

// ---------------------------------------------------------------- Strich-Glättung

// Rohpunkte ausdünnen (Mindestabstand), damit die Glättung ruhig wird
export function simplifyPoints(points, minDist = 1.2) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  for (const p of points) {
    const last = out[out.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) out.push(p);
  }
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// Catmull-Rom-Spline durch die Punkte als SVG-Pfad mit kubischen Beziers
export function strokeToSvgPath(points) {
  const pts = simplifyPoints(points);
  if (pts.length === 0) return '';
  const f = (n) => (Math.round(n * 100) / 100);
  if (pts.length === 1) {
    const p = pts[0];
    return `M ${f(p.x)} ${f(p.y)} L ${f(p.x + 0.1)} ${f(p.y)}`;
  }
  let dPath = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    dPath += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return dPath;
}

// Striche (Arrays von Punkten) in eine gemeinsame normierte Box (0..1) legen
export function normalizeStrokes(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const st of strokes) {
    for (const p of st) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);
  return {
    aspect: w / h,
    strokes: strokes.map((st) => st.map((p) => ({
      x: (p.x - minX) / w,
      y: (p.y - minY) / h,
    }))),
  };
}
