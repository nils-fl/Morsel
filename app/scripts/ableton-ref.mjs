// Measure Ableton Live's Core Library drums and synth presets as a tuning reference for the stock kits and
// the Keys synth presets (needs ffmpeg). Nothing is copied: only measurements and parameter values are
// written, to reference/ableton-drums.json and reference/ableton-synths.json (git-ignored).
//
//   node scripts/ableton-ref.mjs ["<Core Library folder>"] [out file]
//
// Every drum one-shot (Samples/One Shots/Drums, Multisamples/Drum Machines) is measured and given a
// category from its folder or name. The Drum Racks (Racks/Drum Racks/**.adg, gzipped XML) say which
// samples make up a kit, so each sample is also tagged with the rack families it is used in
// (808, 909, machine, electronic, sampled, acoustic).
//
// The Drift presets (Devices/Instruments/Drift/**.adv, gzipped XML) give typical synth settings per
// category in real units: amp envelope in seconds, cutoff in Hz, osc 2 detune. Analog's presets are left
// out: their values are normalised to 0..1 on curves that aren't documented.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { analyzeHit } from "./lib/analyze.mjs";
import { decodeMono, pool, walk } from "./lib/samples.mjs";

const lib = resolve(process.argv[2] ?? "/Applications/Ableton Live 12 Lite.app/Contents/App-Resources/Core Library");
const out = resolve(process.argv[3] ?? join(import.meta.dirname, "../../reference/ableton-drums.json"));
const synthOut = join(dirname(out), "ableton-synths.json");
const SR = 44100;

// One Shots/Drums folder → category.
const FOLDERS = {
  Kick: "kick", Snare: "snare", Clap: "clap", Rim: "rim", Hihat: "hat", Cymbal: "crash", Ride: "ride", Tom: "tom",
  Shaker: "shaker", Tambourine: "tamb", Conga: "conga", Bongo: "conga", Timbales: "conga", Wood: "wood", Bell: "bell",
  "Electronic Percussion": "perc", "Misc Percussion": "perc",
};
// Drum machine multisamples are named "<Instrument> 909 …".
const NAMES = [
  [/^kick|^bd/i, "kick"], [/^snare|^sd/i, "snare"], [/^clap/i, "clap"], [/^rim/i, "rim"], [/hat/i, "hat"],
  [/^ride/i, "ride"], [/^cymbal|^crash/i, "crash"], [/^tom/i, "tom"], [/^cowbell/i, "cowbell"], [/^conga/i, "conga"],
  [/^clave/i, "clave"], [/^maraca|^shaker/i, "shaker"], [/^tamb/i, "tamb"],
];

function category(rel) {
  const name = basename(rel, extname(rel));
  const parts = rel.split("/");
  let cat = parts[1] === "One Shots" && parts[2] === "Drums" ? FOLDERS[parts[3]] : null;
  if (!cat) cat = NAMES.find(([re]) => re.test(name))?.[1] ?? null;
  if (cat === "hat") cat = /open|\boh\b/i.test(name) ? "hatOpen" : "hatClosed";
  if (cat === "crash" && /ride/i.test(name)) cat = "ride";
  return cat;
}

function family(rackRel) {
  const [, , folder] = rackRel.split("/");
  const name = basename(rackRel);
  if (folder === "Drum Machines") return /^808/.test(name) ? "808" : /^909/.test(name) ? "909" : "machine";
  return { Electronic: "electronic", Sampled: "sampled", Acoustic: "acoustic" }[folder] ?? null;
}

/** Families from the name: every 808 / 909 sample (all of a multisample's tunings), other drum machines. */
function machine(rel) {
  const name = basename(rel);
  if (/\b808\b/.test(name)) return ["808"];
  if (/\b909\b/.test(name)) return ["909"];
  return /\b(505|606|707|727|626|C78|CR ?78|DMX|Linn|LM ?1|ER)\b/i.test(name) ? ["machine"] : [];
}

async function exists(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Every file under `dir` with extension `ext`. */
async function findFiles(dir, ext) {
  const outList = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) outList.push(...(await findFiles(p, ext)));
    else if (e.name.endsWith(ext)) outList.push(p);
  }
  return outList;
}

/** A Drum Rack's pads: MIDI note and the sample it plays (the plain one of a multisample's velocity layers). */
function rackPads(xml) {
  const pads = [];
  for (const m of xml.matchAll(/<DrumBranchPreset Id="\d+">([\s\S]*?)<\/DrumBranchPreset>/g)) {
    const note = Number(/<ReceivingNote Value="(\d+)"/.exec(m[1])?.[1]);
    const rels = [...new Set([...m[1].matchAll(/<RelativePath Value="(Samples\/[^"]+)"/g)].map((r) => r[1]))];
    if (!rels.length) continue;
    const plain = rels.find((r) => !/ [a-z]\.(wav|aiff?)$/.test(r)) ?? rels[0];
    pads.push({ note, rel: plain });
  }
  return pads;
}

// Samples and the families of the racks they appear in.
const families = new Map();
const racks = [];
for (const file of await findFiles(join(lib, "Racks/Drum Racks"), ".adg")) {
  const rel = relative(lib, file);
  const fam = family(rel);
  if (!fam) continue;
  const pads = rackPads(gunzipSync(await readFile(file)).toString("utf8"));
  const present = [];
  for (const p of pads) {
    if (!(await exists(join(lib, p.rel)))) continue;
    present.push(p);
    (families.get(p.rel) ?? families.set(p.rel, new Set()).get(p.rel)).add(fam);
  }
  racks.push({ name: basename(rel, ".adg"), family: fam, pads: present.map((p) => ({ ...p, cat: category(p.rel) })) });
}

const files = new Set([
  ...(await walk(join(lib, "Samples/One Shots/Drums"))),
  ...(await walk(join(lib, "Samples/Multisamples/Drum Machines"))),
].map((f) => relative(lib, f)));
for (const rel of families.keys()) files.add(rel);

const list = [...files].filter((rel) => category(rel)).sort();
let done = 0;
const samples = (await pool(list, 8, async (rel) => {
  try {
    const x = await decodeMono(join(lib, rel), SR, 6);
    if (++done % 200 === 0) console.log(`${done}/${list.length}`);
    return { rel, cat: category(rel), families: [...new Set([...(families.get(rel) ?? []), ...machine(rel)])], ...analyzeHit(x, SR) };
  } catch (e) {
    console.log(`- ${rel}: ${e.message.split("\n")[0]}`);
    return null;
  }
})).filter(Boolean);

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ library: lib, racks, samples }, null, 1));
console.log(`${samples.length} samples, ${racks.length} racks → ${out}`);

// ---------- Drift presets ----------

// Drift's folders → Morsel's preset folders.
const DRIFT_FOLDERS = {
  Bass: "Bass", "Synth Lead": "Lead", Pad: "Pad", Strings: "Pad", "Synth Keys": "Keys", "Piano & Keys": "Keys",
  Plucked: "Pluck", Mallets: "Pluck", Percussive: "Pluck", Brass: "Brass", Effects: "FX",
};

/** A Drift preset's settings in Morsel's terms (the amp envelope, filter, osc 2 against osc 1). */
function driftPreset(xml) {
  const v = (name) => /<Manual Value="([^"]*)"/.exec(xml.slice(xml.indexOf(`<${name}>`)))?.[1];
  const num = (name) => Number(v(name));
  const on1 = v("Mixer_OscillatorOn1") === "true", on2 = v("Mixer_OscillatorOn2") === "true";
  const g1 = on1 ? num("Mixer_OscillatorGain1") : 0, g2 = on2 ? num("Mixer_OscillatorGain2") : 0;
  return {
    attack: num("Envelope1_Attack"),
    decay: num("Envelope1_Decay"),
    sustain: num("Envelope1_Sustain"),
    release: num("Envelope1_Release"),
    cutoffHz: num("Filter_Frequency"),
    resonance: num("Filter_Resonance"),
    keyTrack: num("Filter_Tracking"),
    // Osc 2 in cents against osc 1 (transpose is in octaves, detune in semitones).
    detune: Math.round((num("Oscillator2_Transpose") - num("Oscillator1_Transpose")) * 1200 + num("Oscillator2_Detune") * 100),
    osc2Level: g1 ? g2 / g1 : g2 ? 1 : 0,
    noise: v("Mixer_NoiseOn") === "true" ? num("Mixer_NoiseLevel") : 0,
  };
}

const presets = [];
const driftDir = join(lib, "Devices/Instruments/Drift");
for (const file of await findFiles(driftDir, ".adv")) {
  const [folder] = relative(driftDir, file).split("/");
  if (!DRIFT_FOLDERS[folder]) continue;
  presets.push({ name: basename(file, ".adv"), folder: DRIFT_FOLDERS[folder], driftFolder: folder, ...driftPreset(gunzipSync(await readFile(file)).toString("utf8")) });
}
await writeFile(synthOut, JSON.stringify({ library: lib, presets }, null, 1));
console.log(`${presets.length} Drift presets → ${synthOut}`);
