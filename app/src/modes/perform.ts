// Perform mode: the pads play live effects on the whole mix. Bank 1 (Pad FX): hold a pad for its effect, pressure
// sets how much; up to four at once (a fifth bypasses the oldest until it is let go, as on the MPC Sample); Scene
// latches the held ones. Bank 2 (Flex Beat): a pad starts a time effect (repeats, tape stops, gates), pad 1 = Empty.
// Nothing here is recorded: it is heard live and in a take from the master (Shift + Record).
import { engine } from "../audio/engine";
import { FLEX_NAMES, MAX_PAD_FX, PAD_FX, formatParam, knobTracks, type FxDef } from "../audio/perform/catalog";
import { BAR_TICKS, secondsPerTick } from "../seq/timing";
import { sequencer } from "../seq/sequencer";
import { get, set, updatePerform, type PerformLive } from "../state/store";
import { showTemp } from "./notify";

/** Each Pad FX's amount (pad pressure, 0..1), kept out of the store: it changes many times a second. */
const amounts = new Map<number, number>();
/** Pads held down in Perform mode (pad index -> the Pad FX or Flex Beat effect it started). */
const held = new Map<number, { bank: "pad" | "flex"; fx: number }>();

const perform = () => engine.voices.masterBus.perform;
const live = () => get().perform;
const setLive = (p: Partial<PerformLive>) => set({ perform: { ...live(), ...p } });

/** Whether the Perform engine runs (the worklet engine; the old node engine has none). */
export const performAvailable = () => !!perform();

/** The Pad FX sounding: the newest MAX_PAD_FX engaged ones, in the order they went down. */
export const sounding = (p = live()) => p.engaged.slice(-MAX_PAD_FX);

function sendPads() {
  const node = perform();
  if (!node) return;
  node.send({ t: "pads", active: sounding().map((fx) => ({ fx, amount: amounts.get(fx) ?? 0 })), held: live().engaged });
}

/** Velocity sets the amount until the pad's pressure takes over (firm presses start strong). */
const velAmount = (vel: number) => Math.max(0.15, Math.min(1, vel / 127));

export function performPadDown(pad: number, vel: number) {
  if (!perform()) return showTemp("Perform", "Needs the worklet engine");
  const s = live();
  if (s.bank === "flex") {
    held.set(pad, { bank: "flex", fx: pad });
    return playFlex(pad);
  }
  held.set(pad, { bank: "pad", fx: pad });
  amounts.set(pad, velAmount(vel));
  // A latched pad pressed again stays latched (Scene unlatches it); it just moves to the newest place.
  const engaged = [...s.engaged.filter((x) => x !== pad), pad];
  setLive({ engaged, selected: pad });
  sendPads();
  const bypassed = engaged.length > MAX_PAD_FX ? PAD_FX[engaged[engaged.length - MAX_PAD_FX - 1]].name : null;
  showTemp(PAD_FX[pad].name, bypassed ? `${bypassed} bypassed` : summary(PAD_FX[pad], get().project.perform.pad[pad]));
}

export function performPadUp(pad: number) {
  const h = held.get(pad);
  held.delete(pad);
  if (!h || h.bank === "flex") {
    // Loop mode keeps a Flex Beat effect going after the pad is let go; one-shot ends by itself.
    return;
  }
  const s = live();
  if (s.latched.includes(pad)) return;
  amounts.delete(pad);
  setLive({ engaged: s.engaged.filter((x) => x !== pad) });
  sendPads();
}

export function performPressure(pad: number, pressure: number) {
  const h = held.get(pad);
  if (!h || h.bank !== "pad") return;
  // Pressure arrives as 0..127; a latched pad keeps the amount it was latched at once the finger lifts.
  if (pressure <= 0 && live().latched.includes(pad)) return;
  const a = Math.max(velAmount(0), pressure / 127);
  amounts.set(pad, a);
  perform()?.send({ t: "amount", fx: pad, amount: a });
}

/** Scene in Perform mode: latch the held Pad FX at their amounts, or unlatch them (with none held: all). */
export function performLatch() {
  const s = live();
  if (s.bank === "flex") return toggleFlexMode();
  const heldFx = [...held.values()].filter((h) => h.bank === "pad").map((h) => h.fx);
  if (!heldFx.length) {
    if (!s.latched.length) return showTemp("Latch", "Hold a Pad FX");
    const engaged = s.engaged.filter((x) => !s.latched.includes(x));
    s.latched.forEach((x) => amounts.delete(x));
    setLive({ latched: [], engaged });
    sendPads();
    return showTemp("Latch", "All off");
  }
  const allLatched = heldFx.every((x) => s.latched.includes(x));
  const latched = allLatched ? s.latched.filter((x) => !heldFx.includes(x)) : [...new Set([...s.latched, ...heldFx])];
  setLive({ latched });
  showTemp("Latch", `${heldFx.map((x) => PAD_FX[x].short).join(" ")} ${allLatched ? "off" : "on"}`);
}

/** Latch one Pad FX on (at its amount, engaging it when it isn't) or off: the on-screen grid's Shift-click. */
export function performToggleLatch(fx: number) {
  const s = live();
  if (s.latched.includes(fx)) {
    amounts.delete(fx);
    setLive({ latched: s.latched.filter((x) => x !== fx), engaged: s.engaged.filter((x) => x !== fx) });
  } else {
    if (!amounts.has(fx)) amounts.set(fx, 0.8);
    setLive({ latched: [...s.latched, fx], engaged: [...s.engaged.filter((x) => x !== fx), fx], selected: fx });
  }
  sendPads();
}

/** Select the bank and the Pad FX the encoders edit (the on-screen panel). */
export function performSelect(fx: number) {
  setLive({ selected: fx });
}

/** Pad ⌃ / ⌄ in Perform mode: switch between the Pad FX and the Flex Beat bank. */
export function performBank(bank: "pad" | "flex") {
  if (live().bank === bank) return;
  setLive({ bank });
  showTemp("Perform", bank === "pad" ? "Pad FX" : "Flex Beat");
}

function playFlex(program: number) {
  setLive({ flex: program });
  perform()?.send({ t: "flex", program });
  const f = get().project.perform.flex;
  showTemp("Flex Beat", program ? `${FLEX_NAMES[program]}${f.oneShot ? "" : " (loop)"}` : "Empty");
}

/** The engine ended a one-shot Flex Beat effect. */
export function flexEnded() {
  setLive({ flex: 0 });
}

function toggleFlexMode() {
  updatePerform((p) => ({ ...p, flex: { ...p.flex, oneShot: !p.flex.oneShot } }));
  showTemp("Flex Beat", get().project.perform.flex.oneShot ? "One shot" : "Loop");
}

/** Everything off: the pads let go, latches and Flex Beat cleared (leaving the mode keeps latched effects on). */
export function performAllOff() {
  held.clear();
  amounts.clear();
  setLive({ engaged: [], latched: [], flex: 0 });
  sendPads();
  perform()?.send({ t: "flex", program: 0 });
}

/** Pads held when the mode changes: let them go as if released. */
export function performReleaseHeld() {
  for (const pad of [...held.keys()]) performPadUp(pad);
}

/** A Pad FX's settings, short, for popups and the screen footer. */
export function summary(def: FxDef, values: readonly number[]) {
  return def.params.map((p, i) => formatParam(p, values[i] ?? p.def)).join(" ");
}

// ---------- Knob FX target ----------

let lastTargets = "";

/** Route the tracks through the Knob FX or past it, as its target says (the selected track, some tracks, the mix). */
export function applyKnobTargets(force = false) {
  // Before the audio starts there is nothing to route; the new engine gets it (syncPerformGrid).
  if (!(engine.voices as typeof engine.voices | undefined)) return;
  const s = get();
  const t = knobTracks(s.project.perform.knob.target, s.project.tracks.map((x) => x.id), s.selectedTrack);
  const key = t === "all" ? "all" : [...t].sort().join(",");
  if (key === lastTargets && !force) return;
  lastTargets = key;
  engine.voices.setKnobTargets(t);
}

// ---------- the grid ----------

let lastGrid = { bpm: 0, origin: NaN };
let lastNode: unknown = null;
/** A free grid's origin while the transport is stopped (so the LFOs and Flex Beat keep a steady beat). */
let freeOrigin = 0;

/**
 * Keep the engine's grid on the transport's bars (every frame of the controller's render loop). While stopped it runs
 * on its own from the last bar, at the project tempo.
 */
export function syncPerformGrid() {
  const node = perform();
  if (!node) return;
  if (node !== lastNode) {
    // A new engine (the context was rebuilt): it starts empty, so it gets the grid and what is engaged again.
    lastNode = node;
    lastGrid = { bpm: 0, origin: NaN };
    node.onFlexEnd = flexEnded;
    node.setSettings(get().project.perform);
    applyKnobTargets(true);
    sendPads();
  }
  const bpm = get().project.bpm;
  const now = engine.now;
  const pos = sequencer.tickAt(now);
  let origin: number;
  if (pos && pos.tick >= 0) {
    const spt = secondsPerTick(bpm);
    origin = now - (pos.tick % BAR_TICKS) * spt;
    freeOrigin = origin;
  } else {
    // Stopped: keep the last bar grid going; a tempo change keeps the beat's phase.
    if (bpm !== lastGrid.bpm && lastGrid.bpm) {
      const beat = ((now - freeOrigin) * lastGrid.bpm) / 60;
      freeOrigin = now - (beat * 60) / bpm;
    }
    origin = freeOrigin;
  }
  // Re-sent when the tempo changes or the origin moved by more than a millisecond (a new bar, a stop, a jump).
  const barSec = (4 * 60) / bpm;
  const drift = Math.abs(((origin - lastGrid.origin) % barSec + barSec + barSec / 2) % barSec - barSec / 2);
  if (bpm === lastGrid.bpm && drift < 0.001) return;
  lastGrid = { bpm, origin };
  node.send({ t: "grid", bpm, origin });
}

