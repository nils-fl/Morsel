// Canvas helpers shared by the pad waveform and the chop editor.

/** Min/max peaks of `data[from..to)` across `w` pixels. `alpha(x)` dims columns (e.g. outside the region). */
export function drawPeaks(g: CanvasRenderingContext2D, data: Float32Array, from: number, to: number, w: number, h: number, color: string, alpha?: (x: number) => number) {
  const per = (to - from) / w;
  g.fillStyle = color;
  for (let x = 0; x < w; x++) {
    let lo = 1, hi = -1;
    const i0 = Math.floor(from + x * per);
    // Zoomed past one sample per pixel: still read at least one sample.
    for (let i = i0, n = Math.min(data.length, Math.max(i0 + 1, Math.floor(from + (x + 1) * per))); i < n; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi < lo) continue;
    g.globalAlpha = alpha ? alpha(x) : 1;
    g.fillRect(x, ((1 - hi) * h) / 2, 1, Math.max(1, ((hi - lo) * h) / 2));
  }
  g.globalAlpha = 1;
}

/** Background and the faint grid, like the screen's dotted reference lines. */
export function drawWaveBg(g: CanvasRenderingContext2D, css: CSSStyleDeclaration, w: number, h: number, dpr: number) {
  g.fillStyle = css.getPropertyValue("--wave-bg") || "#111";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,.06)";
  for (let x = 0; x < w; x += w / 16) g.fillRect(Math.round(x), 0, dpr, h);
  g.fillRect(0, Math.round(h / 2), w, dpr);
}
