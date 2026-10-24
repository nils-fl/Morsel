// Preferences: per browser (localStorage) on the web, a settings file in the desktop app. Not part of the project.
// Each module declares its own with pref(); the key names are the ones the web version always used.
import { native } from "../platform/native";

export interface Pref<T> {
  readonly key: string;
  get(): T;
  set(value: T): void;
}

// localStorage holds strings: numbers as digits, booleans as "on" / "off" (as the tips always were).
const encode = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : String(v));

function decode<T>(raw: string, def: T): unknown {
  if (typeof def === "number") return raw.trim() ? Number(raw) : NaN;
  if (typeof def === "boolean") return raw === "on" ? true : raw === "off" ? false : undefined;
  return raw;
}

// The desktop app's settings file, as it was when the window opened, plus what was set since.
const desktop: Record<string, unknown> = { ...native?.prefs };

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked (private window, blocked site data)
  }
}

/**
 * A preference with its default. `valid` checks a saved value (an older version or a hand-edited settings file may
 * have saved anything); `legacy` is a key the web version used before.
 */
export function pref<T>(key: string, def: T, valid: (v: unknown) => boolean, legacy?: string): Pref<T> {
  return {
    key,
    get() {
      let v: unknown;
      if (native) v = desktop[key];
      else {
        const raw = load(key) ?? (legacy ? load(legacy) : null);
        v = raw === null ? undefined : decode(raw, def);
      }
      return v !== undefined && valid(v) ? (v as T) : def;
    },
    set(value) {
      if (native) {
        desktop[key] = value;
        native.setPref(key, value);
        return;
      }
      try {
        localStorage.setItem(key, encode(value));
      } catch {
        // Not remembered; it still applies for this visit.
      }
    },
  };
}

export const oneOf = <T>(values: readonly T[]) => (v: unknown) => values.includes(v as T);
export const isString = (v: unknown) => typeof v === "string";
export const isBoolean = (v: unknown) => typeof v === "boolean";
export const inRange = (min: number, max: number) => (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
