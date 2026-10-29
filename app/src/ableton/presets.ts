// Ableton Live's presets (.adg racks, .adv devices: gzipped XML), read for the sounds they're made of: a Drum Rack's
// pads (note, name, sample) and a Simpler instrument's sample zones. The samples are referred to by their path in
// Live's library (RelativePath), so they're read from the connected library folder; nothing is copied into Morsel's
// files. Presets without samples (Drift and other synths) have no sounds to read. Pure, for the tests.

/** A Drum Rack pad: the MIDI note it plays on, its name, and its sample's path in the library. */
export interface LivePad {
  note: number;
  name: string;
  sample: string;
}

/** A multisample zone: the sample, the note it plays at its own pitch, and the keys it covers. */
export interface LiveZone {
  sample: string;
  root: number;
  lo: number;
  hi: number;
}

export type LivePreset =
  | { kind: "kit"; name: string; pads: LivePad[] }
  | { kind: "instrument"; name: string; zones: LiveZone[] };

/** Gunzip a preset's bytes into its XML (DecompressionStream: browsers, Electron and Node). */
export async function presetXml(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

const value = (xml: string, tag: string) => new RegExp(`<${tag} Value="([^"]*)"`).exec(xml)?.[1];
const xmlText = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const AUDIO = /\.(wav|aiff?|flac)$/i;

/** Every sample path in a piece of XML, in order, once each. */
const samplePaths = (xml: string) =>
  [...new Set([...xml.matchAll(/<RelativePath Value="([^"]+)"/g)].map((m) => xmlText(m[1])).filter((p) => AUDIO.test(p)))];

/** A Drum Rack's pads, from its branches (a pad's note is stored as 128 minus the note). */
export function kitPads(xml: string): LivePad[] {
  const pads: LivePad[] = [];
  for (const m of xml.matchAll(/<DrumBranchPreset Id="\d+">([\s\S]*?)<\/DrumBranchPreset>/g)) {
    const b = m[1];
    const stored = Number(value(b, "ReceivingNote"));
    const sample = samplePaths(b)[0];
    if (!sample || !Number.isFinite(stored)) continue;
    const name = [...b.matchAll(/<UserName Value="([^"]*)"/g)].map((n) => xmlText(n[1])).find(Boolean);
    pads.push({ note: 128 - stored, name: name ?? sample.split("/").pop()!.replace(/\.[^.]+$/, ""), sample });
  }
  return pads.sort((a, b) => a.note - b.note);
}

/** The velocity a note is played at to pick a multisample's layer: a firm, ordinary hit. */
const LAYER_VELOCITY = 100;

/**
 * A Simpler instrument's zones: the multisample parts the layer at velocity 100 plays, one per key range. A single
 * sample (Simpler's classic mode) is one zone over every key.
 */
export function instrumentZones(xml: string): LiveZone[] {
  const zones: LiveZone[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<MultiSamplePart [^>]*>([\s\S]*?)<\/MultiSamplePart>/g)) {
    const p = m[1];
    const sample = samplePaths(p)[0];
    if (!sample) continue;
    const keys = /<KeyRange>\s*<Min Value="(\d+)" \/>\s*<Max Value="(\d+)" \/>/.exec(p);
    const vels = /<VelocityRange>\s*<Min Value="(\d+)" \/>\s*<Max Value="(\d+)" \/>/.exec(p);
    if (vels && !(Number(vels[1]) <= LAYER_VELOCITY && LAYER_VELOCITY <= Number(vels[2]))) continue;
    const lo = keys ? Number(keys[1]) : 0, hi = keys ? Number(keys[2]) : 127;
    const range = `${lo}-${hi}`;
    if (seen.has(range)) continue; // another chain's copy of the same range (a rack's release or pedal layer)
    seen.add(range);
    zones.push({ sample, root: Number(value(p, "RootKey") ?? 60), lo, hi });
  }
  return zones.sort((a, b) => a.lo - b.lo);
}

/** What a preset holds: a Drum Rack's pads, a Simpler instrument's zones, or nothing Morsel can play (a synth). */
export function readPreset(xml: string, name: string): LivePreset | null {
  if (/<DrumGroupDevice\b/.test(xml)) {
    const pads = kitPads(xml);
    return pads.length ? { kind: "kit", name, pads } : null;
  }
  const zones = instrumentZones(xml);
  return zones.length ? { kind: "instrument", name, zones } : null;
}

/** A preset file's name without its extension ("505 Core Kit.adg" -> "505 Core Kit"). */
export const presetName = (file: string) => file.replace(/\.ad[gv]$/i, "");

export const isPresetFile = (file: string) => /\.ad[gv]$/i.test(file);
