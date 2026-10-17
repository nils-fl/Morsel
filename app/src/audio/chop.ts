// Slicing a sample into pad regions (fractions 0..1 of the buffer).

export type Slice = [start: number, end: number];

export function equalSlices(n: number): Slice[] {
  return Array.from({ length: n }, (_, i) => [i / n, (i + 1) / n]);
}

/** Onset positions (0..1) from spectral-ish energy flux, at most `max` slices. */
export function detectOnsets(data: Float32Array, sampleRate: number, max = 16, sensitivity = 0.5): number[] {
  const hop = 512;
  const frames = Math.floor(data.length / hop);
  if (frames < 2) return [0];
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, n = i + hop; i < n; i++) e += data[i] * data[i];
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
  return [0, ...chosen.sort((a, b) => a - b).map((f) => (f * hop) / data.length)].filter((v, i, a) => i === 0 || v - a[i - 1] > 0.001);
}

export function slicesFromOnsets(onsets: number[]): Slice[] {
  return onsets.map((s, i) => [s, onsets[i + 1] ?? 1]);
}
