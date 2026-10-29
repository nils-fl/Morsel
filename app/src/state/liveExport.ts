// Ableton Live's library sounds in exported files (kits, projects): they're licensed with Live for making music, not
// for passing on, so an export with any in it asks first.
import { ask } from "./confirm";
import { get } from "./store";

/** Whether a sample came from Ableton Live's library (connected as "Ableton Live", browse/disk.ts). */
export const isLiveSample = (src: string | undefined) => !!src?.startsWith("disk:Ableton Live/");

/**
 * Before exporting samples into a file: Ableton Live's library sounds are licensed with Live, for making music, not
 * for passing on. When some are in it, ask; true to go ahead.
 */
export async function okToExport(ids: Iterable<string>, what: string): Promise<boolean> {
  const samples = get().samples;
  const live = [...ids].filter((id) => isLiveSample(samples[id]?.src)).length;
  if (!live) return true;
  return ask({
    title: "Ableton Live sounds",
    message: `${live} of the samples in this ${what} come from Ableton Live's library. They're for your own music with your Live licence, not for sharing: keep the file to yourself.`,
    ok: "Export",
  });
}
