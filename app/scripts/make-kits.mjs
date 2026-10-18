// Build LaunchKit kit files from a folder of sample packs (needs ffmpeg / ffprobe).
//
//   node scripts/make-kits.mjs "<packs folder>" [out folder, default ../kits]
//
// Every pack folder is searched for drum one-shots, sorted by name into kick / snare / clap / hats / … .
// Loops, breaks and fills are skipped. A pack with enough one-shots gets two kits (A and B, different
// picks), a smaller one one kit, a pack without kicks, snares and hats none. Kits use the same pad
// layout as the Factory kit family: kick, snare, clap, rim, closed hat, open hat, shaker, perc on the
// bottom row, second picks, toms, cymbal and an extra on the top row.
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const [packsDir, outArg] = process.argv.slice(2);
if (!packsDir) {
  console.error('Usage: node scripts/make-kits.mjs "<packs folder>" [out folder]');
  process.exit(1);
}
const outDir = resolve(outArg ?? join(import.meta.dirname, "../../kits"));

const AUDIO = /\.(wav|aiff?|flac|mp3|ogg|m4a)$/i;
// Loops and phrases, not one-shots.
const NOT_ONE_SHOT = /loop|break|fill|\btops?\b|groove|starter|song|phrase|\d{2,3} ?bpm|bpm ?\d{2,3}|chop|slice|ableton/i;
const SR = 44100;
const MAX_SEC = { cymbal: 3, hatOpen: 2.5, fx: 2.5, b808: 2.5 };
const MAX_DEFAULT = 1.6;

// First match wins, so the specific ones come first.
const CATEGORIES = [
  ["b808", /808/],
  ["kick", /kick|kck|\bbd\b|bass ?drum/],
  ["rim", /\brim|side ?stick|\bstick/],
  ["clap", /clap|snap|clp/],
  ["snare", /snare|snr|\bsd\b/],
  ["hatOpen", /open|\boh\b|\bohh?\b|hat ?op/],
  ["hatClosed", /hat|\bhh\b|\bch\b|\bchh\b|closed/],
  ["cymbal", /crash|ride|cymbal|splash|china/],
  ["tom", /\btoms?\b|tom ?(lo|mid|hi)|floor ?tom/],
  ["shaker", /shak|tamb|maraca|cabasa/],
  ["perc", /perc|conga|bongo|cowbell|clave|block|wood|tabla|bell|foley|knock|click/],
  ["fx", /\bfx\b|vox|vocal|chant|shout|scratch/],
];

// Pad layout (pad 1 = bottom left): [name, category fallbacks…, volume, colour].
const LAYOUT = [
  ["Kick", ["kick", "b808"], 0.9, 5],
  ["Snare", ["snare", "clap"], 0.85, 9],
  ["Clap", ["clap", "snare"], 0.75, 13],
  ["Rim", ["rim", "perc", "snare"], 0.7, 13],
  ["Hat Cl", ["hatClosed"], 0.65, 37],
  ["Hat Op", ["hatOpen", "cymbal", "hatClosed"], 0.55, 37],
  ["Shaker", ["shaker", "perc", "hatClosed"], 0.55, 21],
  ["Perc", ["perc", "shaker", "rim"], 0.6, 21],
  ["Kick 2", ["kick", "b808"], 0.85, 5],
  ["Snare 2", ["snare", "clap"], 0.8, 9],
  ["Clap 2", ["clap", "snare", "rim"], 0.7, 13],
  ["Hat 2", ["hatClosed", "shaker"], 0.6, 41],
  ["Tom", ["tom", "perc"], 0.75, 49],
  ["Perc 2", ["perc", "tom", "shaker"], 0.6, 49],
  ["Cymbal", ["cymbal", "hatOpen"], 0.5, 45],
  ["808 / FX", ["b808", "fx", "perc", "kick"], 0.6, 53],
];
const HATS = new Set(["Hat Cl", "Hat Op", "Hat 2"]);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (AUDIO.test(e.name)) out.push(p);
  }
  return out;
}

// "NKTJ_160_Sd" → "nktj 160 sd": underscores and dashes count as word breaks for \b.
const words = (s) => s.toLowerCase().replace(/[_\-.]+/g, " ");

function categorize(rel) {
  const name = words(basename(rel, extname(rel)));
  const folders = words(rel.split("/").slice(0, -1).join("/"));
  // The file name decides first; the folder (e.g. "Kicks", "OH") only when the name says nothing.
  for (const text of [name, folders]) for (const [cat, re] of CATEGORIES) if (re.test(text)) return cat;
  return null;
}

/** Run up to `limit` promises at a time. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function duration(file) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    return parseFloat(stdout) || Infinity;
  } catch {
    return Infinity;
  }
}

/** Decode to 44.1 kHz stereo, cut to `maxSec` with a short fade, normalise to -1 dB; base64 16-bit per channel. */
async function encode(file, maxSec) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-t", String(maxSec), "-ac", "2", "-ar", String(SR), "-f", "f32le", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const f32 = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const frames = Math.floor(f32.length / 2);
  let peak = 0;
  for (const v of f32) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 1e-4 ? 0.89 / peak : 1;
  const fade = Math.min(frames, Math.round(0.02 * SR));
  const mono = (() => {
    for (let i = 0; i < frames; i++) if (Math.abs(f32[2 * i] - f32[2 * i + 1]) > 1e-4) return false;
    return true;
  })();
  const channels = Array.from({ length: mono ? 1 : 2 }, (_, c) => {
    const pcm = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      const tail = frames - i <= fade ? (frames - i) / fade : 1;
      pcm[i] = Math.max(-1, Math.min(1, f32[2 * i + c] * gain * tail)) * 0x7fff;
    }
    return Buffer.from(pcm.buffer).toString("base64");
  });
  return { sampleRate: SR, channels };
}

// "Neekeetone - Jungle Sample Pack Vol.3" → "Jungle Vol.3": vendor prefix and "Sample Pack" dropped.
const kitName = (pack) => pack.replace(/^.* - /, "").replace(/_/g, " ").replace(/\bsample pack\b/i, "").replace(/\s+/g, " ").trim().slice(0, 22);

/** Spread picks over a sorted list (so they differ), kit A from the even entries and B from the odd ones. Never the same file twice in a kit. */
function picker(lists, variant) {
  const taken = new Map();
  const used = new Set();
  return (cat) => {
    const all = lists[cat] ?? [];
    const own = all.filter((_, i) => all.length < 2 || i % 2 === variant);
    const k = taken.get(cat) ?? 0;
    taken.set(cat, k + 1);
    const start = Math.floor(((k * 0.618 + 0.13 * (variant + 1)) % 1) * own.length);
    for (let j = 0; j < own.length; j++) {
      const rel = own[(start + j) % own.length];
      if (!used.has(rel)) {
        used.add(rel);
        return rel;
      }
    }
    return null;
  };
}

async function buildPack(pack) {
  const dir = join(packsDir, pack);
  const files = (await walk(dir)).map((f) => relative(dir, f)).filter((rel) => !NOT_ONE_SHOT.test(rel)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const typed = files.map((rel) => ({ rel, cat: categorize(rel) })).filter((f) => f.cat);
  const durations = await pool(typed, 8, (f) => duration(join(dir, f.rel)));
  const lists = {};
  typed.forEach((f, i) => {
    if (durations[i] > (MAX_SEC[f.cat] ?? MAX_DEFAULT) * 1.5) return; // a loop after all
    (lists[f.cat] ??= []).push(f.rel);
  });
  const count = (c) => lists[c]?.length ?? 0;
  if (!count("kick") || !(count("snare") + count("clap")) || !count("hatClosed")) {
    console.log(`- ${pack}: not enough drum one-shots, skipped`);
    return [];
  }
  const total = Object.values(lists).reduce((n, l) => n + l.length, 0);
  const variants = total >= 60 && count("kick") >= 4 && count("snare") + count("clap") >= 4 && count("hatClosed") >= 4 ? 2 : 1;
  const written = [];
  for (let v = 0; v < variants; v++) {
    const pick = picker(lists, v);
    const pads = [];
    const samples = {};
    for (const [label, cats, volume, color] of LAYOUT) {
      let rel = null, cat = null;
      for (const c of cats) if ((rel = pick(c))) { cat = c; break; }
      if (!rel) {
        pads.push({ name: label, sampleId: null, color, volume });
        continue;
      }
      const id = `s${pads.length}`;
      const name = basename(rel, extname(rel)).slice(0, 40);
      samples[id] = { name, ...(await encode(join(dir, rel), MAX_SEC[cat] ?? MAX_DEFAULT)) };
      pads.push({ name: label, sampleId: id, color, volume, decay: 2, ...(HATS.has(label) ? { choke: 1 } : {}) });
    }
    // Two packs can shorten to the same name: number the second rather than overwrite the first.
    let name = `${kitName(pack) || "Kit"}${variants > 1 ? ` ${"AB"[v]}` : ""}`;
    for (let i = 2; usedNames.has(name); i++) name = `${kitName(pack) || "Kit"}${variants > 1 ? ` ${"AB"[v]}` : ""} (${i})`;
    usedNames.add(name);
    const file = { format: "launchkit-kit", version: 1, name, folder: `Kits/${name}`, pads, samples };
    const path = join(outDir, `${name}.launchkit-kit.json`);
    await writeFile(path, JSON.stringify(file));
    written.push(path);
    console.log(`+ ${name}: ${pads.filter((p) => p.sampleId).length}/16 pads from ${pack}`);
  }
  return written;
}

const usedNames = new Set();
await mkdir(outDir, { recursive: true });
const packs = (await readdir(packsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
let n = 0;
for (const pack of packs) n += (await buildPack(pack)).length;
console.log(`${n} kits in ${outDir}`);
