// Sidechain ducker (like the MPC's Mother Ducker): each hit of the source pad dips the target track's
// gain and lets it recover. Driven by the trigger time, so sequenced hits duck sample-accurately.

export interface DuckPoint {
  t: number;
  v: number;
  /** "hold": cancel later automation and keep the value there; "target": from t, approach v with time constant tau. */
  kind: "hold" | "target";
  tau?: number;
}

// setTargetAtTime gets within ~5% of its target after 3 time constants.
const TAU_PER = 3;

/**
 * Automation for one duck: from `when`, dip toward 1 - depth over about `attack`, then recover over about `release`.
 * Both moves are exponential approaches, which start from whatever the gain is at that moment (mid-recovery from the
 * previous hit, say). A linear ramp would start from the previous scheduled event instead, which may be long before.
 */
export function duckRamp(when: number, depth: number, attack: number, release: number): DuckPoint[] {
  const floor = 1 - Math.max(0, Math.min(1, depth));
  const a = Math.max(0.001, attack);
  return [
    { t: when, v: 1, kind: "hold" },
    { t: when, v: floor, kind: "target", tau: a / TAU_PER },
    { t: when + a, v: 1, kind: "target", tau: Math.max(0.005, release) / TAU_PER },
  ];
}

export function applyDuck(param: AudioParam, points: DuckPoint[]) {
  for (const p of points) {
    if (p.kind === "hold") param.cancelAndHoldAtTime(p.t);
    else param.setTargetAtTime(p.v, p.t, p.tau ?? 0.05);
  }
}

/** The gain `t` seconds after a hit from full level, as the automation above produces it (for drawing). */
export function duckGainAt(t: number, c: { depth: number; attack: number; release: number }) {
  if (t < 0) return 1;
  const floor = 1 - Math.max(0, Math.min(1, c.depth));
  const a = Math.max(0.001, c.attack);
  const dip = (s: number) => floor + (1 - floor) * Math.exp(-s / (a / TAU_PER));
  if (t < a) return dip(t);
  const g = dip(a);
  return 1 - (1 - g) * Math.exp(-(t - a) / (Math.max(0.005, c.release) / TAU_PER));
}
