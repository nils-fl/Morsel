// Measure Morsel's own stock sounds: the synthesized kits (rendered in Node with node-web-audio-api) and the
// factory synth presets (rendered with the worklet's SynthVoice), written to reference/morsel.json.
//
//   node scripts/measure-morsel.mjs [out file, default ../reference/morsel.json]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AudioBuffer, OfflineAudioContext } from "node-web-audio-api";
import { createServer } from "vite";
import { analyzeHit, analyzeNote } from "./lib/analyze.mjs";

const out = resolve(process.argv[2] ?? join(import.meta.dirname, "../../reference/morsel.json"));
// kit.ts renders with the browser's OfflineAudioContext and AudioBuffer.
Object.assign(globalThis, { OfflineAudioContext, AudioBuffer });

const vite = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const { renderStockKit, stockSounds } = await vite.ssrLoadModule("/src/audio/kit.ts");
const { STOCK_KITS } = await vite.ssrLoadModule("/src/state/types.ts");
const { FACTORY_PRESETS } = await vite.ssrLoadModule("/src/audio/synthPresets.ts");
const { SynthVoice } = await vite.ssrLoadModule("/src/audio/worklet/voiceCore.ts");
await vite.close();

const kits = {};
for (const kit of STOCK_KITS) {
  const sounds = await renderStockKit(kit);
  kits[kit] = Object.fromEntries(sounds.map(({ name, buffer }) => [name, analyzeHit(buffer.getChannelData(0), buffer.sampleRate)]));
  console.log(`${kit}: ${stockSounds(kit).length} sounds`);
}

const SR = 44100;
const HOLD = 1;
/** One note held for HOLD seconds, then released, rendered in 128-frame blocks like the audio thread. */
function renderNote(synth, note) {
  const v = new SynthVoice({ kind: "synth", synth, note, vel: 100 }, 0, SR);
  v.stop(HOLD, false);
  const n = Math.round((HOLD + Math.max(0.1, synth.release) * 1.5 + 0.2) * SR);
  const x = new Float32Array(n);
  for (let f = 0; f < n; f += 128) if (!v.render([x.subarray(f, Math.min(n, f + 128))], f, Math.min(128, n - f))) break;
  return x;
}
const presets = FACTORY_PRESETS.map((p) => ({
  name: p.name,
  folder: p.folder,
  params: p.params,
  notes: Object.fromEntries([36, 48, 60].map((note) => [note, analyzeNote(renderNote(p.params, note), SR, 440 * 2 ** ((note - 69) / 12), HOLD)])),
}));
console.log(`${presets.length} presets`);

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ kits, presets }, null, 1));
console.log(`→ ${out}`);
