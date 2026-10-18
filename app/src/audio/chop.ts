// Slicing a sample into pad regions (fractions 0..1 of the buffer).

export type Slice = [start: number, end: number];

export function equalSlices(n: number): Slice[] {
  return Array.from({ length: n }, (_, i) => [i / n, (i + 1) / n]);
}

/**
 * Onset positions (0..1 of the whole buffer) from spectral-ish energy flux, at most `max` slices.
 * Only `range` is analysed; the first onset is always the range start.
 */
export function detectOnsets(data: Float32Array, sampleRate: number, max = 16, sensitivity = 0.5, range: [number, number] = [0, 1]): number[] {
  const from = Math.floor(Math.min(range[0], range[1]) * data.length);
  const to = Math.floor(Math.max(range[0], range[1]) * data.length);
  const first = from / data.length;
  const hop = 512;
  const frames = Math.floor((to - from) / hop);
  if (frames < 2) return [first];
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = from + f * hop, n = i + hop; i < n; i++) e += data[i] * data[i];
    energy[f] = Math.sqrt(e / hop);
  }
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);
  const sorted = [...flux].sort((a, b) => a - b);
  const thresh = sorted[Math.floor(sorted.length * (0.9 + 0.09 * (1 - sensitivity)))] || 0;
  const minGap = Math.floor((0.08 * sampleRate) / hop);
  const peaks: { f: number; v: number }[] = [];
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] > thresh && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) peaks.push({ f, v: flux[f] });
  }
  const chosen: number[] = [];
  for (const p of peaks.sort((a, b) => b.v - a.v)) {
    if (chosen.length >= max - 1) break;
    if (chosen.every((c) => Math.abs(c - p.f) >= minGap)) chosen.push(p.f);
  }
  return [first, ...chosen.sort((a, b) => a - b).map((f) => (from + f * hop) / data.length)].filter((v, i, a) => i === 0 || v - a[i - 1] > 0.001);
}

export function slicesFromOnsets(onsets: number[], end = 1): Slice[] {
  return onsets.map((s, i) => [s, onsets[i + 1] ?? end]);
}

/** Slices between consecutive markers (N + 1 markers make N slices). */
export function slicesFromMarkers(markers: number[]): Slice[] {
  return markers.slice(0, -1).map((m, i) => [m, markers[i + 1]]);
}

/** Nearest zero crossing to `frac` within `radius` samples, so slice starts don't click. */
export function zeroCrossing(data: Float32Array, frac: number, radius = 256): number {
  const at = Math.round(frac * data.length);
  for (let d = 0; d <= radius; d++) {
    for (const i of [at - d, at + d]) {
      if (i <= 0 || i >= data.length) continue;
      if ((data[i - 1] <= 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] <= 0)) return i / data.length;
    }
  }
  return frac;
}

// Marker lists are sorted boundaries; the first and last are the region bounds.

/** Insert a marker unless it lands within `minGap` of another one or outside the region. */
export function addMarker(markers: number[], m: number, minGap: number): number[] {
  const first = markers[0], last = markers[markers.length - 1];
  if (m <= first + minGap || m >= last - minGap) return markers;
  if (markers.some((x) => Math.abs(x - m) < minGap)) return markers;
  return [...markers, m].sort((a, b) => a - b);
}

/** Move marker `i`, clamped between its neighbours so the order never changes. */
export function moveMarker(markers: number[], i: number, m: number, minGap: number): number[] {
  const lo = i > 0 ? markers[i - 1] + minGap : 0;
  const hi = i < markers.length - 1 ? markers[i + 1] - minGap : 1;
  const out = markers.slice();
  out[i] = Math.max(lo, Math.min(hi, m));
  return out;
}

/** Remove an inner marker; the region bounds stay. */
export function removeMarker(markers: number[], i: number): number[] {
  if (i <= 0 || i >= markers.length - 1) return markers;
  return markers.filter((_, k) => k !== i);
}

/** A view window [start, end] of at least `min` wide, kept inside 0..1. */
export function clampView(a: number, span: number, min: number): [number, number] {
  span = Math.max(min, Math.min(1, span));
  a = Math.max(0, Math.min(1 - span, a));
  return [a, a + span];
}
