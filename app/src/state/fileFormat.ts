// File format names for project and kit exports. Files exported before the rename to Morsel say "launchkit" and still load.
export const PROJECT_FORMAT = "morsel";
export const KIT_FORMAT = "morsel-kit";
const PROJECT_FORMATS = new Set([PROJECT_FORMAT, "launchkit"]);
const KIT_FORMATS = new Set([KIT_FORMAT, "launchkit-kit"]);

export const isProjectFormat = (f: unknown) => typeof f === "string" && PROJECT_FORMATS.has(f);
export const isKitFormat = (f: unknown) => typeof f === "string" && KIT_FORMATS.has(f);

// Exports are zip files: the project or kit as JSON, and each sample as a WAV in samples/. Before that they were one
// JSON file with the samples in it as base64 (*.morsel.json, *.morsel-kit.json), which still import.
export const PROJECT_EXT = ".morsel";
export const KIT_EXT = ".morsel-kit";
export const PROJECT_ACCEPT = `${PROJECT_EXT},.json`;
export const KIT_ACCEPT = `${KIT_EXT},.json`;
/** The JSON inside the zip. */
export const ZIP_JSON = "morsel.json";

/** A file name for a sample in the zip's samples/ folder: its name without characters file systems refuse, unique (case-insensitively) in `taken`. */
export function sampleFileName(name: string, taken: Set<string>) {
  const safe = [...name].map((c) => (c < " " || '\\/:*?"<>|'.includes(c) ? "_" : c)).join("");
  const base = safe.replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 60) || "sample";
  let file = `samples/${base}.wav`;
  for (let i = 2; taken.has(file.toLowerCase()); i++) file = `samples/${base} (${i}).wav`;
  taken.add(file.toLowerCase());
  return file;
}
