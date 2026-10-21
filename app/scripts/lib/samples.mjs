// Finding, sorting and decoding drum samples on disk (shared by make-kits and the reference measurements).
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

export const AUDIO = /\.(wav|aiff?|flac|mp3|ogg|m4a)$/i;

/** Every audio file under `dir`. */
export async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (AUDIO.test(e.name)) out.push(p);
  }
  return out;
}

// First match wins, so the specific ones come first.
export const CATEGORIES = [
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

// "NKTJ_160_Sd" → "nktj 160 sd": underscores and dashes count as word breaks for \b.
export const words = (s) => s.toLowerCase().replace(/[_\-.]+/g, " ");

/** The category of a sample from its path relative to the pack: the file name decides first, the folders only when it says nothing. */
export function categorize(rel) {
  const name = words(basename(rel, extname(rel)));
  const folders = words(rel.split("/").slice(0, -1).join("/"));
  for (const text of [name, folders]) for (const [cat, re] of CATEGORIES) if (re.test(text)) return cat;
  return null;
}

/** Run up to `limit` promises at a time. */
export async function pool(items, limit, fn) {
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

export async function duration(file) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    return parseFloat(stdout) || Infinity;
  } catch {
    return Infinity;
  }
}

/** Decode the first `maxSec` of a file to mono float at `sr` (ffmpeg). */
export async function decodeMono(file, sr = 44100, maxSec = 4) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-t", String(maxSec), "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + Math.floor(stdout.byteLength / 4) * 4));
}
