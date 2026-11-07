// Zoomen & Verschieben eines Bildes in einer Bühne – nur das Dokument wird
// größer, nie die ganze Oberfläche.
//
// Bedienung: zwei Finger (Pinch), Trackpad-Pinch bzw. Strg+Mausrad,
// Doppeltipp/Doppelklick (hinein ↔ ganze Seite), Knöpfe über zoomCenter().
// Gezoomt verschiebt ein Finger, die Maus oder das Mausrad die Seite;
// ungezoomt meldet Wischen bzw. kräftiges Scrollen onSwipe(+1/−1).
//
// Das Bild liegt absolut in der Bühne und wird per CSS-Transform skaliert –
// flüssig auch am Handy. onSettled() meldet das Ende einer Zoom-Geste, damit
// der Aufrufer schärfer nachrendern kann.

export function createZoomPan(stage, img, { maxZoom = 8, onSwipe = null, onChange = null, onSettled = null } = {}) {
  const st = { zoom: 1, tx: 0, ty: 0, fitW: 0, fitH: 0, aspect: 210 / 297, wheelPage: 0, settleTimer: null };

  function clamp() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const sw = st.fitW * st.zoom;
    const sh = st.fitH * st.zoom;
    const m = 12;
    st.tx = sw <= w ? (w - sw) / 2 : Math.min(m, Math.max(w - sw - m, st.tx));
    st.ty = sh <= h ? (h - sh) / 2 : Math.min(m, Math.max(h - sh - m, st.ty));
  }

  function apply() {
    img.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.zoom})`;
    stage.classList.toggle('zoomed', st.zoom > 1.01);
    onChange?.(st.zoom);
  }

  function settleSoon() {
    clearTimeout(st.settleTimer);
    st.settleTimer = setTimeout(() => onSettled?.(st.zoom), 300);
  }

  /** Bild einpassen (bei neuer Seite oder geänderter Bühnengröße); Zoom bleibt. */
  function layout() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    const pad = w < 600 ? 10 : 24;
    const oldW = st.fitW;
    st.fitW = Math.max(40, Math.min(w - pad * 2, (h - pad * 2) * st.aspect));
    st.fitH = st.fitW / st.aspect;
    if (oldW && oldW !== st.fitW) {
      const k = st.fitW / oldW;
      st.tx *= k;
      st.ty *= k;
    }
    img.style.width = `${st.fitW}px`;
    img.style.height = `${st.fitH}px`;
    clamp();
    apply();
  }

  /** Zoomen um einen Punkt der Bühne – der Punkt bleibt unter Finger/Zeiger. */
  function zoomAt(z, px, py) {
    const old = st.zoom;
    const nz = Math.min(maxZoom, Math.max(1, z));
    st.tx = px - (px - st.tx) * (nz / old);
    st.ty = py - (py - st.ty) * (nz / old);
    st.zoom = nz;
    clamp();
    apply();
    settleSoon();
  }
  const zoomCenter = (z) => zoomAt(z, stage.clientWidth / 2, stage.clientHeight / 2);

  function reset() {
    st.zoom = 1;
    st.tx = 0;
    st.ty = 0;
    clamp();
    apply();
  }

  // ---- Zeiger (Finger, Maus, Stift)
  const pts = new Map();
  let pinch = null;
  let pan = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startPinch = () => {
    const [a, b] = [...pts.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = {
      d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      z: st.zoom,
      // Punkt des Dokuments unter der Fingermitte (ungezoomte Pixel)
      cx: (mid.x - st.tx) / st.zoom,
      cy: (mid.y - st.ty) / st.zoom,
    };
    pan = null;
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* egal */ }
    pts.set(e.pointerId, local(e));
    if (pts.size >= 2) { startPinch(); return; }
    const p = local(e);
    pan = { x: p.x, y: p.y, tx: st.tx, ty: st.ty, moved: false };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = Math.min(maxZoom, Math.max(1, pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)));
      st.zoom = z;
      st.tx = mid.x - pinch.cx * z;
      st.ty = mid.y - pinch.cy * z;
      clamp();
      apply();
      return;
    }
    if (!pan) return;
    const p = local(e);
    const dx = p.x - pan.x;
    const dy = p.y - pan.y;
    if (Math.hypot(dx, dy) > 6) pan.moved = true;
    if (st.zoom > 1.01) {
      st.tx = pan.tx + dx;
      st.ty = pan.ty + dy;
      clamp();
      apply();
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size < 2) {
        pinch = null;
        settleSoon();
        // Mit dem verbliebenen Finger nahtlos weiterschieben
        if (pts.size === 1) {
          const q = [...pts.values()][0];
          pan = { x: q.x, y: q.y, tx: st.tx, ty: st.ty, moved: true };
        }
      }
      return;
    }
    if (!pan) return;
    const dx = p.x - pan.x;
    const dy = p.y - pan.y;
    const moved = pan.moved;
    pan = null;
    if (st.zoom <= 1.01 && onSwipe && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      onSwipe(dx < 0 ? 1 : -1);
      return;
    }
    if (!moved && e.type === 'pointerup') {
      // Doppeltipp / Doppelklick: hinein bzw. wieder ganze Seite
      const now = Date.now();
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
        zoomAt(st.zoom > 1.05 ? 1 : 2.5, p.x, p.y);
        lastTap.t = 0;
      } else {
        lastTap = { t: now, x: p.x, y: p.y };
      }
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('lostpointercapture', end);

  // Mausrad & Trackpad: Pinch kommt als Strg+Rad → zoomen, sonst verschieben
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(st.zoom * Math.exp(-e.deltaY * unit * 0.008), p.x, p.y);
    } else if (st.zoom > 1.01) {
      st.tx -= e.deltaX * unit;
      st.ty -= e.deltaY * unit;
      clamp();
      apply();
    } else if (onSwipe && Math.abs(e.deltaY * unit) > 40) {
      const t = Date.now();
      if (t - st.wheelPage > 450) {
        st.wheelPage = t;
        onSwipe(e.deltaY > 0 ? 1 : -1);
      }
    }
  }, { passive: false });

  // Safari (Mac-Trackpad, iPhone): eigene Gesten-Ereignisse
  let g = null;
  stage.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    const p = local(e);
    g = { z: st.zoom, x: Number.isFinite(p.x) ? p.x : stage.clientWidth / 2, y: Number.isFinite(p.y) ? p.y : stage.clientHeight / 2 };
  });
  stage.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (g && !pinch) zoomAt(g.z * e.scale, g.x, g.y);
  });
  stage.addEventListener('gestureend', (e) => { e.preventDefault(); g = null; });

  new ResizeObserver(() => { if (stage.clientWidth) layout(); }).observe(stage);

  return {
    get zoom() { return st.zoom; },
    get fitW() { return st.fitW; },
    get state() { return st; },
    /** Seitenverhältnis des (neuen) Bildes setzen und einpassen. */
    setAspect(aspect) { if (aspect > 0) st.aspect = aspect; layout(); },
    layout,
    reset,
    zoomAt,
    zoomCenter,
  };
}
