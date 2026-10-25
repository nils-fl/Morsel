// How much of the playing's dynamics reaches the sound: a curve on the Launchkey's pad and key velocities, applied as
// they come in, so a recorded note keeps the velocity that was heard. Per browser (or desktop app), like the bend range.
import { oneOf, pref } from "../state/prefs";

export const VELOCITY_CURVES = ["full", "medium", "light", "fixed"] as const;
export type VelocityCurve = (typeof VELOCITY_CURVES)[number];

export const VELOCITY_LABEL: Record<VelocityCurve, string> = { full: "Full", medium: "Medium", light: "Light", fixed: "Fixed" };

/** The softest hit's velocity and the bend above it: Medium and Light lift soft hits, so the level varies less. */
const SHAPE: Record<Exclude<VelocityCurve, "fixed">, { floor: number; exp: number }> = {
  full: { floor: 1, exp: 1 },
  medium: { floor: 50, exp: 0.7 },
  light: { floor: 80, exp: 0.6 },
};

/** A played velocity (1..127) through a curve; 0 (a release) stays 0. Fixed plays every hit at 127. */
export function velocityThrough(curve: VelocityCurve, vel: number): number {
  if (vel <= 0) return 0;
  if (curve === "fixed") return 127;
  const { floor, exp } = SHAPE[curve];
  return Math.round(floor + (127 - floor) * Math.pow((Math.min(127, vel) - 1) / 126, exp));
}

export const padVelocityPref = pref<VelocityCurve>("morsel.padVelocity", "medium", oneOf(VELOCITY_CURVES));
export const keyVelocityPref = pref<VelocityCurve>("morsel.keyVelocity", "medium", oneOf(VELOCITY_CURVES));

// The curves in use, so a hit doesn't read the preference (localStorage) every time; set*Velocity keeps them current.
let padCurve = padVelocityPref.get();
let keyCurve = keyVelocityPref.get();

export const padVelocity = (vel: number) => velocityThrough(padCurve, vel);
export const keyVelocity = (vel: number) => velocityThrough(keyCurve, vel);

export function setPadVelocity(curve: VelocityCurve) {
  padCurve = curve;
  padVelocityPref.set(curve);
}

export function setKeyVelocity(curve: VelocityCurve) {
  keyCurve = curve;
  keyVelocityPref.set(curve);
}

export const currentVelocityCurves = () => ({ pads: padCurve, keys: keyCurve });
