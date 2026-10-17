const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/** Root note from a filename like "Piano_C#4.wav", "Rhodes-Db3", or "Strings 060". C4 = 60. */
export function rootFromName(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, "");
  const m = base.match(/(?:^|[^A-Za-z])([A-Ga-g])([#b]?)(-?\d)(?!\d)/g);
  if (m) {
    const last = m[m.length - 1].replace(/^[^A-Ga-g]/, "");
    const [, letter, acc, oct] = last.match(/([A-Ga-g])([#b]?)(-?\d)/)!;
    const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    return (Number(oct) + 1) * 12 + semis[letter.toUpperCase()] + (acc === "#" ? 1 : acc === "b" ? -1 : 0);
  }
  const num = base.match(/(?:^|\D)(\d{2,3})$/);
  if (num && Number(num[1]) <= 127) return Number(num[1]);
  return null;
}
