// Compare Morsel's stock sounds with the reference measurements and write reference/report.md: the kits
// against measured one-shots, the synth presets' settings against Ableton Drift's per category.
//
//   node scripts/measure-morsel.mjs && node scripts/ableton-ref.mjs && node scripts/compare-sounds.mjs
//
// Each stock kit pad is compared with the reference one-shots of its category from the rack families
// that kit is modelled on (falling back to all of them when a family has too few). A value outside the
// reference's interquartile range is flagged, with how far off it is from the median.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quartiles } from "./lib/analyze.mjs";

const ref = join(import.meta.dirname, "../../reference");
const morsel = JSON.parse(await readFile(join(ref, "morsel.json"), "utf8"));
const ableton = JSON.parse(await readFile(join(ref, "ableton-drums.json"), "utf8"));
let novation = [];
try {
  novation = JSON.parse(await readFile(join(ref, "novation-drums.json"), "utf8")).samples;
} catch {
  // Not decoded (yet): Ableton alone.
}
const samples = [...ableton.samples, ...novation.map((s) => ({ ...s, families: ["acoustic", "novation"] }))];

/** Which rack families each stock kit is modelled on. */
export const KIT_FAMILIES = {
  Factory: ["808", "909", "machine", "electronic"],
  "Lo-Fi": ["sampled"],
  "Boom Bap": ["sampled"],
  "Hip Hop": ["sampled", "electronic", "808"],
  Trap: ["electronic", "808"],
  Drill: ["electronic", "808"],
  House: ["909", "machine", "electronic"],
  Techno: ["909", "electronic"],
  DnB: ["sampled", "electronic"],
  Electro: ["808", "machine"],
};

/** A pad's reference category from its name (null: melodic or effect, not compared). */
function padCategory(name) {
  const n = name.replace(/ \d$/, "");
  if (/^(808|Sub|Rumble)/.test(n)) return "boom";
  if (n === "Kick") return "kick";
  if (/^(Snare|Ghost|Brush)/.test(n)) return "snare";
  if (/^(Clap|Snap)/.test(n)) return "clap";
  if (n === "Rim") return "rim";
  if (/^Hat (Cl|Tick)/.test(n)) return "hatClosed";
  if (n === "Hat Op") return "hatOpen";
  if (/^(Shaker|Maraca)/.test(n)) return "shaker";
  if (n === "Tamb") return "tamb";
  if (n === "Ride") return "ride";
  if (/^(Crash|Cymbal)/.test(n)) return "crash";
  if (/^Tom/.test(n)) return "tom";
  if (/^Conga/.test(n)) return "conga";
  if (n === "Cowbell") return "cowbell";
  if (/^(Wood|Perc|Clave)/.test(n)) return "wood";
  return null;
}

// Long kicks are the reference for 808 basses; cowbells come from the Bell folder or the machines' cowbells.
const inCategory = (s, cat) =>
  cat === "boom" ? s.cat === "kick" && s.len40 >= 0.8
    : cat === "kick" ? s.cat === "kick" && s.len40 < 0.8
      : cat === "cowbell" ? s.cat === "cowbell" || (s.cat === "bell" && /cowbell/i.test(s.rel))
        : s.cat === cat;

const METRICS = [
  ["len40", "len", (v) => `${v.toFixed(2)}s`],
  ["centroid", "centroid", (v) => `${Math.round(v)}`],
  ["centroidEarly", "early", (v) => `${Math.round(v)}`],
  ["centroidLate", "late", (v) => `${Math.round(v)}`],
  ["pitch", "pitch", (v) => `${Math.round(v)}`, (cat) => ["kick", "boom", "tom", "conga", "snare"].includes(cat)],
  ["attackMs", "attack", (v) => `${v.toFixed(1)}ms`],
  ["env100", "@100ms", (v) => `${v.toFixed(0)}dB`],
  ["crest", "crest", (v) => `${v.toFixed(1)}dB`],
];
const value = (m, key) => (key === "env100" ? m.env["100"] : m[key]);

function referenceFor(cat, families) {
  const own = samples.filter((s) => inCategory(s, cat) && s.families.some((f) => families.includes(f)));
  return own.length >= 6 ? { set: own, label: families.join("+") } : { set: samples.filter((s) => inCategory(s, cat)), label: "all" };
}

const lines = ["# Stock sounds vs. reference one-shots", "", "Flagged: outside the reference's interquartile range (×: Morsel / median).", ""];
let flags = 0, checks = 0;
const byCat = {};
for (const [kit, pads] of Object.entries(morsel.kits)) {
  lines.push(`## ${kit}`, "", "| Pad | ref (n) | " + METRICS.map(([, h]) => h).join(" | ") + " |", "|" + " --- |".repeat(METRICS.length + 2));
  for (const [name, m] of Object.entries(pads)) {
    const cat = padCategory(name);
    if (!cat) continue;
    const { set, label } = referenceFor(cat, KIT_FAMILIES[kit]);
    if (!set.length) continue;
    const cells = METRICS.map(([key, , fmt, only]) => {
      if (only && !only(cat)) return "";
      const q = quartiles(set.map((s) => value(s, key)));
      const v = value(m, key);
      checks++;
      const off = v < q.q1 || v > q.q3;
      if (off) flags++;
      const c = (byCat[`${cat} ${key}`] ??= [0, 0]);
      c[1]++;
      if (off) c[0]++;
      const ratio = q.median ? ` ×${(v / q.median).toFixed(2)}` : "";
      return off ? `**${fmt(v)}** (${fmt(q.median)}${ratio})` : `${fmt(v)}`;
    });
    lines.push(`| ${name} | ${cat} ${label} (${set.length}) | ${cells.join(" | ")} |`);
  }
  lines.push("");
}
const summary = Object.entries(byCat).filter(([, [f]]) => f).sort((a, b) => b[1][0] / b[1][1] - a[1][0] / a[1][1]).map(([k, [f, n]]) => `${k} ${f}/${n}`);
// Attack time mostly measures the references' lead-in, and stock 808s are meant to ring longer than Core Library's 808 kicks.
const core = Object.entries(byCat).filter(([k]) => !/^boom |attackMs$/.test(k)).reduce(([f, n], [, [cf, cn]]) => [f + cf, n + cn], [0, 0]);
lines.splice(3, 0, `${flags} of ${checks} values flagged; ${core[0]} of ${core[1]} without attack time and 808 basses.`, "", `Flags by category and metric: ${summary.join(", ")}.`, "");

// ---------- synth presets ----------

let drift = [];
try {
  drift = JSON.parse(await readFile(join(ref, "ableton-synths.json"), "utf8")).presets;
} catch {
  // No Drift presets measured.
}
const cutoffHz = (c) => 20 * 2 ** (Math.max(0, Math.min(1, c)) * 10);
const PARAMS = [
  ["attack", (p) => p.attack, (v) => v.toFixed(3)],
  ["decay", (p) => p.decay, (v) => v.toFixed(2)],
  ["sustain", (p) => p.sustain, (v) => v.toFixed(2)],
  ["release", (p) => p.release, (v) => v.toFixed(2)],
  ["cutoff Hz", (p) => p.cutoffHz ?? cutoffHz(p.cutoff), (v) => Math.round(v)],
  ["key track", (p) => p.keyTrack, (v) => v.toFixed(2)],
  ["osc 2 level", (p) => p.osc2Level, (v) => v.toFixed(2)],
  // Detune as a spread (cents off the nearest octave or interval of whole semitones).
  ["spread ¢", (p) => Math.abs(p.detune - Math.round(p.detune / 100) * 100), (v) => v.toFixed(0)],
  ["noise", (p) => p.noise, (v) => v.toFixed(2)],
];
const span = (q, fmt) => (q ? `${fmt(q.q1)} · **${fmt(q.median)}** · ${fmt(q.q3)}` : "–");
if (drift.length) {
  lines.push("# Synth presets vs. Ableton Drift presets", "", "Per folder: quartiles (q1 · **median** · q3) of Drift's presets, then Morsel's.", "");
  for (const folder of [...new Set(morsel.presets.map((p) => p.folder))]) {
    const ours = morsel.presets.map((p) => ({ ...p.params, folder: p.folder })).filter((p) => p.folder === folder);
    const theirs = drift.filter((p) => p.folder === folder);
    if (!theirs.length) continue;
    lines.push(`## ${folder} (Drift ${theirs.length}, Morsel ${ours.length})`, "", "| | Drift | Morsel |", "| --- | --- | --- |");
    for (const [label, get, fmt] of PARAMS) lines.push(`| ${label} | ${span(quartiles(theirs.map(get)), fmt)} | ${span(quartiles(ours.map(get)), fmt)} |`);
    lines.push("");
  }
}

await writeFile(join(ref, "report.md"), lines.join("\n"));
console.log(`${flags}/${checks} flagged (${core[0]}/${core[1]} without attack time and 808 basses) → ${join(ref, "report.md")}`);
