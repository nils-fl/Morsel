// Maps Launchkey events to actions per hardware mode, and renders LEDs + display.
import { addDrumTrack, allPresets, bendKeys, currentKit, finishChop, keepRegion, keyOff, keyOn, modKeys, kitNames, liveWhen, openInChop, playPad, releasePad, setRepeatLatch, stretchChop, toggleSampling, togglePlay, toggleRecord } from "../actions";
import { engine } from "../audio/engine";
import { launchkey } from "../midi/launchkey";
import { keyVelocity, padVelocity } from "../midi/velocity";
import { CC, COLOR, type LedMode, type PadLayout } from "../midi/protocol";
import { DUCK_PAGE, PAGES, STEP_PAGE, fixPage, inputLabel, keysSampleList, padLabel, pagesFor, presetLabel, stepPage, stepPageLabel, turnEncoder } from "../params";
import { makeTicker, sequencer } from "../seq/sequencer";
import { PPQN, REPEAT_OPTIONS, pageSteps, rowSteps } from "../seq/timing";
import {
  type AppState, addTrack, clearTrack, clipOf, copyClip, copyPattern, drumPads, drumTrack, editStep, get, keysTrack, markUndo, padDucks, patternHasNotes, selectTrack,
  selectedTrack, set, stepEvents, stepTrack, store, togglePadFlag, toggleStep, toggleTrackFlag, trackAudible, trackBars, trackLength, trackUndoSteps, clipStep, stepPages, undoTrack, updateProject, PAD_COLORS,
} from "../state/store";
import type { HwMode, KeysInstrument, NoteEvent, Track, TrackKind } from "../state/types";
import { noteForKeysPad, stepForPad } from "./stepMap";
import { noteName } from "../ui/notes";
import { activeOverlay, releaseHold, showTemp, type Overlay } from "./notify";
import { chopAddMarker, chopEncoder, chopKeyDown, chopKeyUp, chopKeysReleased, chopMarkerArrows, chopPad, chopPadLeds, chopRemoveMarker, chopSetPage, chopStepMarker, chopStop, chopTogglePlay, chopView } from "./chop";
import { browseCan, browseChop, browseDisplay, browseEncoder, browseEnter, browseLeds, browseOnFolder, browseOnSample, browseShiftEnter, browsePad, browseUp, browseView, enterBrowse, exitBrowse } from "./browse";
import { H, W, type Frame } from "../display/frame";
import { browserScreen, chopScreen, duckScreen, encoderScreen, gridScreen, keysScreen, padScreen, shiftCoverText, shiftEncHint, shiftRows, shiftScreen, stepScreen } from "../display/screens";
import { HEADER_H, computePeaks, duckPanel, filterPanel, overlayBar, type Peaks } from "../display/widgets";
import { BOOT_BURP_MS, BOOT_EAT_MS, BOOT_MS, bootFrame } from "../display/bootAnim";

const MODES: HwMode[] = ["play", "step", "track", "mute", "pattern"];
const MODE_NAMES: Record<HwMode, string> = { play: "Play", step: "Step", track: "Track", mute: "Mute", pattern: "Pattern", browse: "Browse", chop: "Chop" };
/** Modes entered on top of another one; leaving them returns to prevHwMode. */
const TEMPORARY: HwMode[] = ["browse", "chop"];


/** Play and Chop use the drum layout (velocity, pressure); every other mode lights the pads in DAW layout. */
const layoutFor = (mode: HwMode): PadLayout => (mode === "play" || mode === "chop" ? "drum" : "daw");
// -Infinity, not 0: after a page reload the device reports its layout within the first second
// (performance.now() starts at the reload), and that first report must not be ignored.
let lastLayoutFix = -Infinity;

/** Encoder page to go back to when leaving Step mode (which opens its own Step page). */
let pageBeforeStep: number | null = null;

/** Turn encoder `index` of encoder page `page` and show its value on the screen: the Launchkey's encoders and the
 *  on-screen knobs (ui/EncoderStrip.tsx) both come here. */
export function turnPageEncoder(page: number, index: number, delta: number, fine: boolean, whole = false) {
  const p = turnEncoder(page, index, delta, fine, whole);
  // The Duck screen already draws the curve, so its popup goes without the visual.
  if (p) showTemp(p.name, p.format(), { visual: page === DUCK_PAGE ? undefined : p.visual?.(), encoder: index });
}

export function setHwMode(mode: HwMode) {
  const prev = get().hwMode;
  if (prev === mode) return;
  cancelNewTrack();
  if (prev === "browse") exitBrowse();
  if (prev === "chop") chopStop(); // e.g. Shift + Enc ⌃ from Chop into Browse: don't leave the audition playing
  if (mode === "browse") enterBrowse();
  if (prev === "play" && get().repeatLatch) setRepeatLatch(false);
  set({ hwMode: mode, prevHwMode: TEMPORARY.includes(prev) ? get().prevHwMode : prev });
  if (prev === "step") heldSteps.clear(); // a step let go in another mode stays
  if (mode === "step") {
    pageBeforeStep = get().encPage;
    set({ encPage: STEP_PAGE });
  } else if (prev === "step") {
    if (get().encPage === STEP_PAGE) set({ encPage: pageBeforeStep ?? 0 });
    fixPage();
  }
  launchkey.setLayout(layoutFor(mode));
  // The Func cycle shows where you are in it ("Mode 2/5"); Browse and Chop sit outside it.
  const at = MODES.indexOf(mode);
  showTemp(at < 0 ? "Mode" : `Mode ${at + 1}/${MODES.length}`, MODE_NAMES[mode]);
}


/** An open chop session takes over the encoders, pads and screen (see initController), whichever tab is showing. */
export function enterChopHw() {
  if (get().hwMode !== "chop") setHwMode("chop");
}

export function exitChopHw() {
  if (get().hwMode !== "chop") return;
  chopStop();
  setHwMode(get().prevHwMode);
}

/** Shift + Pad down: chop the selected pad's sample, or go back to the open chop when the pad is empty or holds the same sample. */
function hwOpenChop() {
  const s = get();
  const pad = drumPads(s)[s.selectedPad];
  if (s.chop && (!pad.sampleId || s.chop.sampleId === pad.sampleId)) {
    set({ tab: "Chop" });
    return enterChopHw();
  }
  if (!pad.sampleId) return showTemp("Chop", "Pad is empty");
  openInChop();
  enterChopHw();
}

const heldPads = new Set<number>();
/**
 * Step pads held in Step mode, with the step they pressed. Encoders 1 and 2 edit them while held; a lit step is
 * deleted on release, unless they did.
 */
const heldSteps = new Map<number, { pattern: number; track: string; tick: number; span: number; note: number; remove: boolean }>();
/** The steps held now already have their undo step (from adding a note, or the first edit). */
let heldStepsUndo = false;
/** Pads sounding from Play mode (hit or note repeat), so a release after a mode switch still stops them. */
const playingPads = new Map<number, string>();
/** Scene held (note repeat; in Pattern mode, + pad appends to the song, + two pads copies a clip). */
let sceneHeld = false;
/** When Scene was last pressed in Play mode: a second press soon after latches note repeat. */
let lastSceneTap = 0;

/** Func held in Play mode: pads and keys hit meanwhile erase (MPC Erase), and the mode switches on release unless they did. */
let funcHeld = false;
let funcErased = false;
/** Pads and keys held for erasing: the track and note they erase. */
const erasingPads = new Map<number, { track: string; note: number }>();
const erasingKeys = new Map<number, { track: string; note: number }>();

/** Func + pad / key in Play mode: erase that note of the track as the playhead passes it, while held. */
function startErase(held: Map<number, { track: string; note: number }>, at: number, track: Track, note: number) {
  funcErased = true;
  if (!get().playing) return showTemp("Erase", "Play first");
  held.set(at, { track: track.id, note });
  sequencer.eraseStart(track.id, note);
  showTemp("Erase", track.kind === "drum" ? track.pads[note].name : noteName(note), { hold: true });
}

function stopErase(held: Map<number, { track: string; note: number }>, at: number) {
  const e = held.get(at);
  if (!e) return;
  held.delete(at);
  sequencer.eraseStop(e.track, e.note);
  if (!erasingPads.size && !erasingKeys.size) releaseHold();
}

/** A pad let go: stop its voice and its note repeat, whatever mode we are in now. */
function padReleased(pad: number) {
  heldPads.delete(pad);
  stopErase(erasingPads, pad);
  const step = heldSteps.get(pad);
  if (step) {
    heldSteps.delete(pad);
    if (step.remove) toggleStep(step.pattern, step.track, step.tick, step.span, step.note);
    if (!heldSteps.size) heldStepsUndo = false;
  }
  engine.voices.pressure[pad] = 0;
  const note = keysPads.get(pad);
  if (note) {
    keysPads.delete(pad);
    keyOff(note.note, note.track);
  }
  const track = playingPads.get(pad);
  if (track !== undefined) {
    playingPads.delete(pad);
    engine.voices.releasePad(track, pad, liveWhen());
    sequencer.repeatPads.delete(`${track}:${pad}`);
  }
}

/** Let go of everything the hands were holding (device unplugged, project replaced). */
export function releaseAll() {
  heldSteps.clear();
  for (const pad of [...heldPads, ...playingPads.keys(), ...keysPads.keys()]) padReleased(pad);
  for (const [note, track] of instrumentKeys) keyOff(note, track);
  instrumentKeys.clear();
  for (const [note, pad] of selectKeys) {
    selectKeys.delete(note);
    releasePad(pad);
  }
  for (const [note, { track, pad }] of drumKeys) {
    drumKeys.delete(note);
    engine.voices.releasePad(track, pad, liveWhen());
  }
  for (const key of [...erasingKeys.keys()]) stopErase(erasingKeys, key);
  chopKeysReleased();
  funcHeld = false;
  sceneHeld = false;
  setRepeatLatch(false);
  releaseHold();
  if (get().shift) set({ shift: false });
}

// Start-up animation: plays when the page loads and whenever the Launchkey connects; any input skips it.
let bootStart = -Infinity;
/** The Launchkey connecting this long after the page loaded counts as plugged in later. */
const REPLAY_AFTER_MS = 5000;
const bootElapsed = () => performance.now() - bootStart;

/** Pads during the animation: a colour sweep following the blob, a white flash on the burp, then a rainbow chase. */
function bootLeds(ms: number) {
  return Array.from({ length: 16 }, (_, i) => {
    const col = i % 8;
    if (ms < BOOT_EAT_MS) {
      const at = Math.floor((ms / BOOT_EAT_MS) * 8);
      return { color: col === at ? COLOR.white : col < at ? PAD_COLORS[i] : COLOR.off };
    }
    if (ms < BOOT_BURP_MS) return { color: Math.floor(ms / 60) % 2 ? COLOR.white : COLOR.off };
    return { color: PAD_COLORS[(i + Math.floor(ms / 50)) % 16] };
  });
}

export function initController() {
  bootStart = performance.now();
  // A new chop session (a take, Crop, a sample picked on the Chop tab) puts the Launchkey in Chop; closing it leaves.
  store.subscribe((s, prev) => {
    if (s.chop && s.chop.sampleId !== prev.chop?.sampleId) enterChopHw();
    else if (!s.chop && prev.chop) exitChopHw();
    // Switching between a drum and a keys track: stay on an encoder page that track has.
    if (s.selectedTrack !== prev.selectedTrack || s.project.tracks !== prev.project.tracks) fixPage();
    // The device's own pad mode (chords) is for keys tracks: a drum track takes the pads back.
    if (s.selectedTrack !== prev.selectedTrack && launchkey.nativePads !== null && selectedTrack(s).kind === "drum") launchkey.setLayout(layoutFor(s.hwMode));
    // The page on the step pads must exist in the selected track's clip (a shorter one may have been picked).
    const pages = stepPages(s.project.patterns[s.currentPattern], s.selectedTrack);
    if (s.stepPage >= pages) set({ stepPage: pages - 1 });
  });
  launchkey.on((e) => {
    const s = get();
    if (e.type === "pad" || e.type === "key" || e.type === "button" || e.type === "encoder") bootStart = -Infinity;
    if (!s.audioReady && ((e.type === "pad" && e.on) || (e.type === "button" && e.down && e.button !== "shift"))) showTemp("No audio", "Click the page");
    switch (e.type) {
      case "connection":
        set({ connected: e.connected, status: e.connected ? "Launchkey connected" : "Launchkey disconnected" });
        if (e.connected) {
          launchkey.setLayout(layoutFor(s.hwMode));
          lastStationary = "";
          // Plugged in later: play the intro for it. Right after the page loads the device connects while the
          // page's own intro runs (or just after it): don't start it over.
          if (performance.now() > REPLAY_AFTER_MS && bootElapsed() >= BOOT_MS) bootStart = performance.now();
        } else releaseAll();
        break;
      case "layout": {
        // The device reports its layout after connecting (often "daw" right after the handshake) and when
        // switched from the hardware. Put back the one the current mode needs, at most once a second so a
        // device that keeps refusing can't cause a loop. Not while Shift is held: that is the device's pad-mode
        // picker (measured: it reports "daw"), and fixing it then knocked out the mode picked (Shift up decides).
        if (s.shift) break;
        const want = layoutFor(s.hwMode);
        if (e.layout !== want && performance.now() - lastLayoutFix > 1000) {
          lastLayoutFix = performance.now();
          launchkey.setLayout(want);
        }
        break;
      }
      case "nativePads":
        // The device's own pad mode (its chords, measured as 15): leave it the pads. Their notes come in on the
        // keys port and play the keys track. Func, a mode change or a drum track takes them back.
        showTemp("Pads", "Launchkey mode");
        break;
      case "pad":
        if (e.on) {
          heldPads.add(e.pad);
          onPad(e.pad, padVelocity(e.velocity));
        } else padReleased(e.pad);
        break;
      case "padPressure": {
        engine.voices.pressure[e.pad] = e.pressure;
        // Note repeat: press harder for louder repeats (recorded that way too).
        const rp = sequencer.repeatPads.get(`${playingPads.get(e.pad)}:${e.pad}`);
        if (rp && e.pressure > 0) rp.vel = Math.max(24, e.pressure);
        break;
      }
      case "key":
        onKey(e.note, keyVelocity(e.velocity), e.on);
        break;
      case "pitchbend":
        bendKeys(e.value);
        break;
      case "keyCC":
        // CC 1: the Mod strip. It shows where it is; the Pitch strip doesn't (it springs back at once).
        if (e.cc === 1) {
          modKeys(e.value);
          showTemp("Mod", `${Math.round((e.value / 127) * 100)}%`);
        }
        break;
      case "encoder": {
        if (s.hwMode === "step" && heldSteps.size && e.index < 2) {
          editHeldSteps(e.index, e.delta, s.shift);
          break;
        }
        if (s.hwMode === "browse") {
          browseEncoder(e.index, e.delta, s.shift);
          break;
        }
        if (s.hwMode === "chop") {
          chopEncoder(e.index, e.delta, s.shift);
          break;
        }
        if (s.hwMode === "track" && newTrack && e.index === 0) {
          // Setting up a new track: encoder 1 picks the kind (right = Keys, left = Drums).
          newTrack.kind = e.delta > 0 ? "keys" : "drum";
          showNewTrack();
          break;
        }
        turnPageEncoder(s.encPage, e.index, e.delta, s.shift);
        break;
      }
      case "button":
        onButton(e.button, e.down);
        break;
    }
  });
  // Worker timer instead of rAF: keeps LEDs live while the tab is hidden.
  makeTicker(renderLoop)(33);
}

// Notes currently sounding on a keys track (note -> track), so a key released after a mode or track switch still stops.
const instrumentKeys = new Map<number, string>();
// Keys used to pick a sound in Step mode (pad index per note).
const selectKeys = new Map<number, number>();
/** Keys playing a drum track's pads (selected drum track, any mode but Step and Chop): the track and pad per note. */
const drumKeys = new Map<number, { track: string; pad: number }>();
/** Step mode on a keys track: the note the step pads write (the last key pressed). */
let stepNote: number | null = null;

/** "Kick" for the selected pad on a drum track, the track name for a keys track. */
const trackItemName = (s: AppState, t: Track) => (t.kind === "drum" ? t.pads[s.selectedPad].name : t.name);
/** The note the step pads write on a keys track: the last key played, else the instrument's home note. */
const keysStepNote = (t: Track) => stepNote ?? (t.keys?.type === "synth" ? 48 : t.keys?.type === "sample" ? t.keys.sample.root : 60);

/** Step mode: key -> pad, repeating every 16 keys. At the default octave the lowest key (C3 = 48) is pad 1. */
export const padForKey = (note: number) => ((note % 16) + 16) % 16;

function onKey(note: number, vel: number, on: boolean) {
  if (!on) stopErase(erasingKeys, note);
  if (!on) chopKeyUp(note);
  // Chop: the keys play the chops (and, held, put one on the next pad tapped).
  if (on && get().hwMode === "chop") return chopKeyDown(note, vel);
  if (on && funcHeld && get().hwMode === "play") {
    const sel = selectedTrack();
    return sel.kind === "drum" ? startErase(erasingKeys, note, sel, padForKey(note)) : startErase(erasingKeys, note, keysTrack(), note);
  }
  if (!on) {
    const track = instrumentKeys.get(note);
    if (track !== undefined) {
      instrumentKeys.delete(note);
      keyOff(note, track);
    }
    const pad = selectKeys.get(note);
    if (pad !== undefined) {
      selectKeys.delete(note);
      releasePad(pad);
    }
    const drum = drumKeys.get(note);
    if (drum) {
      drumKeys.delete(note);
      engine.voices.releasePad(drum.track, drum.pad, liveWhen());
      sequencer.repeatPads.delete(`${drum.track}:${drum.pad}`);
    }
    return;
  }
  const s = get();
  const sel = selectedTrack(s);
  if (s.hwMode === "step" && sel.kind === "drum") {
    // Shift + pad is taken by the Launchkey's own pad-mode shortcut, so the keys pick the sound here.
    const pad = padForKey(note);
    selectKeys.set(note, pad);
    set({ selectedPad: pad });
    engine.voices.pad(sel.id, pad, vel, liveWhen());
    showTemp("Pad", padLabel(sel.id, pad));
    return;
  }
  if (s.hwMode === "step") {
    // Keys track: the key you play is the note the step pads write.
    stepNote = note;
    instrumentKeys.set(note, keyOn(note, vel, sel.id));
    return;
  }
  if (sel.kind === "drum") {
    // A drum track: the keys play its pads (C3 = pad 1 … D#4 = pad 16, then round again), recorded like the pads.
    // Held with Scene in Play, they repeat like held pads.
    const pad = padForKey(note);
    drumKeys.set(note, { track: sel.id, pad });
    if (s.hwMode === "play" && sequencer.repeatOn) {
      sequencer.repeatPads.set(`${sel.id}:${pad}`, { track: sel.id, pad, vel });
      set({ selectedPad: pad });
      sequencer.ensureRepeatClock();
    } else playPad(pad, vel);
    return;
  }
  instrumentKeys.set(note, keyOn(note, vel));
}

/**
 * Track mode: a track being added on the next free slot of the top row. Tapping the slot starts it (Drums), encoder 1
 * picks Drums or Keys, tapping again adds it. Tapping a track or leaving Track mode calls it off.
 */
let newTrack: { kind: TrackKind } | null = null;

function showNewTrack() {
  if (!newTrack) return;
  showTemp(`New T${get().project.tracks.length + 1}: ${newTrack.kind === "drum" ? "Drums" : "Keys"}`, "Enc 1 kind, tap: add", { hold: true });
}

function cancelNewTrack() {
  if (!newTrack) return;
  newTrack = null;
  releaseHold();
}

/** Add the track set up in Track mode (a drum track gets the Factory kit, like + Drums on screen) and select it. */
async function addNewTrack(kind: TrackKind) {
  const before = get().project.tracks.length;
  if (kind === "drum") await addDrumTrack();
  else addTrack("keys");
  const p = get().project;
  if (p.tracks.length === before) return showTemp("Track", "8 tracks already");
  const t = p.tracks[p.tracks.length - 1];
  showTemp(`T${p.tracks.length} added`, t.name);
}

const DOUBLE_TAP_MS = 300;
let lastMixerTap = { pad: -1, at: 0 };

/** Second tap of the same pad within DOUBLE_TAP_MS (Mixer and Track mode: double-tap = solo). */
function tapIsDouble(pad: number) {
  const now = performance.now();
  const double = lastMixerTap.pad === pad && now - lastMixerTap.at < DOUBLE_TAP_MS;
  lastMixerTap = double ? { pad: -1, at: 0 } : { pad, at: now };
  return double;
}

/** Pads held on a keys track: the note and track to release. */
const keysPads = new Map<number, { note: number; track: string }>();

function onPad(pad: number, vel: number) {
  const s = get();
  const sel = selectedTrack(s);
  switch (s.hwMode) {
    case "browse":
      if (sel.kind === "drum") set({ selectedPad: pad });
      browsePad();
      break;
    case "chop":
      chopPad(pad, vel, liveWhen());
      break;
    case "play": {
      if (funcHeld) {
        if (sel.kind === "keys") startErase(erasingPads, pad, sel, noteForKeysPad(pad));
        else startErase(erasingPads, pad, drumTrack(s), pad);
        break;
      }
      if (sel.kind === "keys") {
        // Keys track: the pads are notes, recorded like the keybed.
        const note = noteForKeysPad(pad);
        keysPads.set(pad, { note, track: keyOn(note, vel, sel.id) });
        break;
      }
      const drums = drumTrack(s);
      playingPads.set(pad, drums.id);
      // Scene held: note repeat, playing or stopped (then on its own clock).
      if (sequencer.repeatOn) {
        sequencer.repeatPads.set(`${drums.id}:${pad}`, { track: drums.id, pad, vel });
        set({ selectedPad: pad, selectedTrack: drums.id });
        sequencer.ensureRepeatClock();
      } else playPad(pad, vel);
      break;
    }
    case "step": {
      const pat = s.project.patterns[s.currentPattern];
      const t = selectedTrack(s);
      const g = stepGrid(s);
      const step = stepForPad(pad, g.perRow);
      const tick = (g.first + step) * g.span;
      if (step < 0 || tick >= trackLength(pat, t.id)) break;
      const note = t.kind === "drum" ? s.selectedPad : keysStepNote(t);
      // A lit step goes on release, so it can be held and edited first.
      const lit = stepEvents(clipOf(pat, t.id).events, t.kind === "drum", tick, g.span, note).length > 0;
      if (!lit) {
        toggleStep(s.currentPattern, t.id, tick, g.span, note);
        heldStepsUndo = true;
      }
      heldSteps.set(pad, { pattern: s.currentPattern, track: t.id, tick, span: g.span, note, remove: lit });
      break;
    }
    case "track": {
      // Top row = select track 1-8. Bottom row = mute track 1-8, double-tap = solo.
      const p = s.project;
      if (pad >= 8) {
        const t = p.tracks[pad - 8];
        if (!t) {
          // An empty slot: set up a new track (on the next free one), then a second tap adds it.
          if (!newTrack) {
            newTrack = { kind: "drum" };
            showNewTrack();
          } else {
            const kind = newTrack.kind;
            cancelNewTrack();
            void addNewTrack(kind);
          }
          break;
        }
        cancelNewTrack();
        selectTrack(t.id);
        showTemp(`Track ${pad - 7}`, `${t.name} (${t.kind === "drum" ? "drums" : "keys"})`);
        break;
      }
      cancelNewTrack();
      const t = p.tracks[pad];
      if (!t) break;
      const double = tapIsDouble(pad);
      if (double) {
        toggleTrackFlag(t.id, "mute");
        toggleTrackFlag(t.id, "solo");
      } else toggleTrackFlag(t.id, "mute");
      const now = get().project.tracks.find((x) => x.id === t.id)!;
      showTemp(t.name, double ? (now.solo ? "Solo" : "Solo off") : now.mute ? "Muted" : "On");
      break;
    }
    case "mute": {
      // Pads of the drum track (the last one picked, when a keys track is selected).
      // Tap = mute. Double-tap = solo: the second tap undoes the first tap's mute and toggles solo.
      const t = drumTrack(s);
      const double = tapIsDouble(pad);
      if (double) {
        togglePadFlag(t.id, pad, "padMutes");
        togglePadFlag(t.id, pad, "padSolos");
      } else togglePadFlag(t.id, pad, "padMutes");
      const now = drumTrack();
      showTemp(now.pads[pad].name, double ? (now.padSolos[pad] ? "Solo" : "Solo off") : now.padMutes[pad] ? "Muted" : "On");
      break;
    }
    case "pattern": {
      // Hold a pattern pad + tap another = copy the held pattern there; with Scene held too, only the selected track's clip.
      const held = [...heldPads].find((p) => p !== pad);
      if (held !== undefined) {
        if (sceneHeld) {
          const t = selectedTrack(s);
          copyClip(held, pad, t.id);
          showTemp("Copied clip", `${t.name} ${held + 1} > ${pad + 1}`);
        } else {
          copyPattern(held, pad);
          showTemp("Copied", `Pattern ${held + 1} > ${pad + 1}`);
        }
        break;
      }
      // Hold Scene + pad = append to the song (Shift + pad is taken by the Launchkey).
      if (sceneHeld) {
        updateProject((p) => ({ ...p, song: [...p.song, { pattern: pad, repeats: 1 }] }));
        showTemp("Song +", `Pattern ${pad + 1}`);
      } else {
        sequencer.selectPattern(pad);
        showTemp("Pattern", `${pad + 1}${s.playing ? " (queued)" : ""}`);
      }
      break;
    }
  }
}

function onButton(button: string, down: boolean) {
  const s = get();
  if (button === "shift") {
    // Shift let go without picking one of the device's own pad modes: put back the layout the mode needs.
    if (!down && launchkey.nativePads === null && launchkey.layout !== layoutFor(s.hwMode)) launchkey.setLayout(layoutFor(s.hwMode));
    return set({ shift: down });
  }
  // Shift + the encoder page arrows: Browse (any track) and Chop (drum tracks) on / off. Checked before Browse takes the arrows.
  // In Browse, Shift + ⌄ chops the highlighted sample (any track): leaving Chop goes back to the mode before Browse.
  if (down && s.shift && (button === "encPageUp" || button === "encPageDown")) {
    if (button === "encPageUp" ? s.hwMode === "browse" : s.hwMode === "chop") return button === "encPageUp" ? setHwMode(s.prevHwMode) : exitChopHw();
    if (button === "encPageDown" && s.hwMode === "browse") return void browseChop().then((ok) => ok && enterChopHw());
    if (button === "encPageDown" && selectedTrack(s).kind !== "drum") return showTemp("Chop", "Drum track only");
    return button === "encPageUp" ? setHwMode("browse") : hwOpenChop();
  }
  if (s.hwMode === "browse" && down) {
    // Browse owns Func / Pad down (open/load), Scene / Pad up (up a folder) and the encoder page arrows
    // (one item), so the left hand selects while the right scrolls.
    if ((button === "func" || button === "padDown") && !s.shift) return void browseEnter();
    if (button === "scene" || (button === "padUp" && !s.shift)) return browseUp();
    if (button === "encPageUp" || button === "encPageDown") return browseEncoder(0, button === "encPageUp" ? -1 : 1, false);
  }
  if (s.hwMode === "browse" && down && button === "func" && s.shift) return void browseShiftEnter(() => setHwMode(get().prevHwMode));
  // Scene let go: note repeat (and the held popup) end, in every mode.
  if (button === "scene" && !down) {
    sceneHeld = false;
    // Latched, note repeat keeps going for the pads you hold.
    if (!s.repeatLatch) {
      sequencer.repeatOn = false;
      sequencer.repeatPads.clear();
    }
    releaseHold();
    return;
  }
  if (s.hwMode === "chop") {
    // Chop owns Play (audition, a loop on the Sample page; Shift = the sequencer), the encoder page arrows (its Sample
    // and Chop pages), Function (Sample page: keep only start-end; Chop page: done, to the rack) and Scene (Sample
    // page: stretch to the tempo set; Chop page: add a marker at the playhead, Shift = remove the selected one).
    const samplePage = s.chop?.page === "sample";
    if (button === "scene") return void (down && (samplePage ? !s.shift && stretchChop() : s.shift ? chopRemoveMarker() : chopAddMarker()));
    if (down && button === "play") return s.shift ? togglePlay() : chopTogglePlay();
    if (down && !s.shift && button === "func") return void (samplePage ? keepRegion() : finishChop());
    if (!s.shift && (button === "encPageUp" || button === "encPageDown")) return void (down && chopSetPage(button === "encPageUp" ? "sample" : "chop"));
    // Pad ⌃ / ⌄ step through the markers, like encoder 3 (with Shift they still change track, below).
    if (!s.shift && (button === "padUp" || button === "padDown")) return void (down && chopStepMarker(button === "padUp" ? -1 : 1));
  }
  // Shift + Pad up / down: previous / next track ("< Track" / "Track >" on the device). The device sends its own
  // Track CCs for them, so that is what arrives; padUp / padDown + Shift are kept as a fallback.
  const trackDir = button === "trackPrev" || (button === "padUp" && s.shift) ? -1 : button === "trackNext" || (button === "padDown" && s.shift) ? 1 : 0;
  if (trackDir) {
    if (!down) return;
    const t = stepTrack(trackDir);
    const n = get().project.tracks.indexOf(t) + 1;
    // Chop works on drum tracks; on a keys track go back to playing. Browse follows the track (pads or keys).
    if (t.kind !== "drum" && s.hwMode === "chop") exitChopHw();
    showTemp(`Track ${n}/${get().project.tracks.length}`, `${t.name} (${t.kind === "drum" ? "drums" : "keys"})`);
    return;
  }
  if (button === "scene") {
    // Hold for note repeat (Play, playing or stopped) or song-append (Pattern); Shift+Scene clears the selected track in this pattern.
    if (s.shift) {
      // Step mode on a drum track clears the selected pad's notes; elsewhere the whole clip.
      const t = selectedTrack(s);
      const onePad = s.hwMode === "step" && t.kind === "drum";
      const events = clipOf(s.project.patterns[s.currentPattern], t.id).events;
      if (!events.some((e) => !onePad || e.note === s.selectedPad)) return showTemp("Clear", "Nothing to clear");
      clearTrack(s.currentPattern, t.id, onePad ? s.selectedPad : undefined);
      showTemp("Cleared", onePad ? trackItemName(s, t) : t.name);
      return;
    }
    sceneHeld = true;
    const drums = drumTrack(s).id;
    const rate = REPEAT_OPTIONS.find((o) => o.ticks === s.repeatRate)?.label ?? "";
    if (s.hwMode === "play" && selectedTrack(s).kind !== "drum") {
      // The pads are notes on a keys track; note repeat is for drum pads.
      sequencer.repeatOn = true;
      showTemp("Repeat", "Drum pads only", { hold: true });
    } else if (s.hwMode === "play") {
      // A press while latched lets go; a second press in quick succession latches.
      const now = performance.now();
      if (s.repeatLatch) {
        setRepeatLatch(false);
        lastSceneTap = 0;
        sceneHeld = false;
        return showTemp("Repeat", "Off");
      }
      const latch = now - lastSceneTap < DOUBLE_TAP_MS;
      lastSceneTap = latch ? 0 : now;
      if (latch) setRepeatLatch(true);
      sequencer.repeatOn = true;
      for (const p of heldPads) {
        playingPads.set(p, drums);
        sequencer.repeatPads.set(`${drums}:${p}`, { track: drums, pad: p, vel: 100 });
      }
      sequencer.ensureRepeatClock();
      showTemp("Repeat", latch ? `${rate} latched` : rate, { hold: !latch });
    } else if (s.hwMode === "pattern") showTemp("Scene", "Pad = add to song", { hold: true });
    return;
  }
  if (button === "func" && !down && funcHeld) {
    funcHeld = false;
    if (!funcErased) setHwMode(MODES[(MODES.indexOf(get().hwMode) + 1) % MODES.length]);
    return;
  }
  if (!down) return;
  switch (button) {
    case "play":
      if (s.shift) {
        set({ metronome: !s.metronome });
        showTemp("Metronome", get().metronome ? "On" : "Off");
      } else togglePlay();
      break;
    case "record":
      if (s.shift) {
        if (s.sampleSource === "tab" && s.sampling === "idle" && !s.tabShared) showTemp("Sample", "Share a tab");
        toggleSampling(true);
      }
      else toggleRecord();
      break;
    case "func":
      if (s.shift) {
        // The selected track's last change (a recorded pass, step edits, pads); other tracks keep theirs.
        const t = selectedTrack(s);
        const done = undoTrack(t.id);
        const label = `Undo T${s.project.tracks.indexOf(t) + 1}`;
        showTemp(label, done ? `${trackUndoSteps(get(), t.id)} left` : "Nothing to undo");
      } else if (s.hwMode === "play") {
        // Held with pads it erases; the mode switch waits for the release.
        funcHeld = true;
        funcErased = false;
      } else setHwMode(MODES[(MODES.indexOf(s.hwMode) + 1) % MODES.length]);
      break;
    case "encPageUp":
    case "encPageDown": {
      // No wrap-around: the arrow LEDs show which directions are available.
      const page = stepPage(s.encPage, button === "encPageUp" ? -1 : 1);
      if (page !== s.encPage) set({ encPage: page });
      showTemp("Encoders", PAGES[page].name);
      break;
    }
    case "padUp":
    case "padDown": {
      const dir = button === "padUp" ? -1 : 1;
      if (s.hwMode === "step") {
        const pages = stepPages(s.project.patterns[s.currentPattern], s.selectedTrack);
        const page = Math.max(0, Math.min(pages - 1, s.stepPage + dir));
        set({ stepPage: page });
        showTemp("Bar", `${stepPageLabel(page)} / ${trackBars(s.project.patterns[s.currentPattern], s.selectedTrack)}`);
      } else {
        // While playing the switch is queued, so step on from the pattern already queued.
        const i = Math.max(0, Math.min(15, (s.queuedPattern ?? s.currentPattern) + dir));
        sequencer.selectPattern(i);
        showTemp("Pattern", `${i + 1}${s.playing && i !== s.currentPattern ? " (queued)" : ""}`);
      }
      break;
    }
  }
}

// ---------- rendering ----------

let lastStationary = "";
let ledsPaused = false;
let bitmapActive = false;
let frame: Frame | null = null;

/** Let the Lab page drive the pad LEDs and screen directly. */
export function pauseLeds(paused: boolean) {
  ledsPaused = paused;
  if (!paused) {
    lastStationary = "";
    bitmapActive = false;
    launchkey.clearBitmap();
  }
}

/** The screen the controller is currently drawing (for the on-screen preview). */
export const currentFrame = () => frame;

const peakCache = new Map<string, Peaks>();
function peaksFor(id: string | null): Peaks | null {
  if (!id) return null;
  let pk = peakCache.get(id);
  if (!pk) {
    const buf = engine.buffer(id);
    if (!buf) return null;
    pk = computePeaks(buf.getChannelData(0), W);
    peakCache.set(id, pk);
  }
  return pk;
}

/** What a sample-based keys track plays, for its screen. */
function keysSoundName(s: AppState, k: KeysInstrument) {
  if (k.type === "sample") return k.sample.sampleId ? (s.samples[k.sample.sampleId]?.name ?? "Sample") : "No sample loaded";
  if (k.type === "chromatic") return `Pad ${k.sourcePad + 1}: ${s.project.tracks.find((t) => t.id === k.sourceTrack)?.pads[k.sourcePad].name ?? "?"}`;
  return k.multiName || "Multisample";
}

/** "T2 Keys 1": the selected track's number and name, for the screen headers. */
function trackLabel(s: AppState) {
  const t = selectedTrack(s);
  return `T${s.project.tracks.indexOf(t) + 1} ${t.name}`;
}

function transportState(s: AppState) {
  return s.sampling !== "idle" ? "SAMPLE" : s.countIn ? "COUNT" : s.recording ? "REC" : s.playing ? "PLAY" : "STOP";
}

/** "P1 PLAY": the header's right side on every mode screen, so Play / Record always show. */
export const statusText = (s: AppState) => `P${s.currentPattern + 1} ${transportState(s)}`;

/** Encoder pages whose screen shows the instrument (waveform, list, curve) rather than the 8 encoders. */
const INSTRUMENT_TAGS = ["KIT", "PAD", "PAD2", "KEYS", "DUCK"];
const onEncoderScreen = (s: AppState) => s.hwMode === "play" && !INSTRUMENT_TAGS.includes(PAGES[s.encPage].tag);

/** Encoder 1 (velocity, Shift: fine) or 2 (nudge) turned while step pads are held: edit those steps' notes. */
function editHeldSteps(index: number, delta: number, fine: boolean) {
  if (!heldStepsUndo) {
    markUndo(true);
    heldStepsUndo = true;
  }
  const dVel = index === 0 ? delta * (fine ? 1 : 2) : 0;
  const dNudge = index === 1 ? delta : 0;
  let first: NoteEvent | undefined;
  for (const step of heldSteps.values()) {
    step.remove = false;
    const e = editStep(step.pattern, step.track, step.tick, step.span, step.note, dVel, dNudge, false);
    first ??= e;
  }
  if (!first) return;
  const nudge = first.nudge ?? 0;
  if (index === 0) showTemp("Velocity", String(first.vel), { encoder: 0 });
  else showTemp("Nudge", nudge > 0 ? `+${nudge}` : String(nudge), { encoder: 1 });
}

/** The selected track's step grid on the pads: ticks per step, steps per pad row and per page, the page's first step. */
function stepGrid(s: AppState) {
  const span = clipStep(s.project.patterns[s.currentPattern], s.selectedTrack);
  return { span, perRow: rowSteps(span), page: pageSteps(span), first: s.stepPage * pageSteps(span) };
}

/** Which steps of the page on the pads have notes (of the selected pad, on a drum track). */
function stepsOf(s: AppState) {
  const pat = s.project.patterns[s.currentPattern];
  const t = selectedTrack(s);
  const len = trackLength(pat, t.id);
  const g = stepGrid(s);
  const events = clipOf(pat, t.id).events.filter((e) => t.kind !== "drum" || e.note === s.selectedPad);
  return Array.from({ length: g.page }, (_, step) => {
    const tick = (g.first + step) * g.span;
    return tick < len && events.some((e) => e.tick >= tick && e.tick < tick + g.span);
  });
}

function playheadStep(s: AppState) {
  const pos = sequencer.trackTickAt(s.selectedTrack);
  if (!pos || pos.tick < 0 || pos.pattern !== s.currentPattern) return -1;
  const g = stepGrid(s);
  const step = Math.floor(pos.tick / g.span) - g.first;
  return step >= 0 && step < g.page ? step : -1;
}

/** Graphic screen for the current mode, or null when there is nothing to draw yet (Chop before its buffer). */
function screenFor(s: AppState, overlay: Overlay | null): Frame | null {
  const p = s.project;
  const status = statusText(s);
  switch (s.hwMode) {
    case "browse": {
      const v = browseView();
      return browserScreen({ ...v, track: trackLabel(s) });
    }
    case "play": {
      const t = selectedTrack(s);
      const page = PAGES[s.encPage];
      // The instrument's own pages show the instrument (pad waveform, preset / sample list, duck curve);
      // the shared pages (LFO, Track FX, Mix, Global) show their 8 encoders.
      if (onEncoderScreen(s)) {
        return encoderScreen({
          title: trackLabel(s),
          status,
          tag: page.tag,
          info: page.summary(),
          active: overlay?.encoder,
          cells: Array.from({ length: 8 }, (_, i) => {
            const prm = page.params[i];
            if (!prm) return null;
            const [lo, hi] = prm.range ?? [0, 1];
            return { name: prm.name, value: prm.format(), level: (prm.value() - lo) / (hi - lo || 1) };
          }),
        });
      }
      if (page.tag === "KIT") {
        // No highlight when the pads aren't a saved kit (a chop, a folder, hand-picked samples).
        const kits = kitNames();
        return keysScreen({
          track: trackLabel(s),
          status,
          presets: kits.map((k) => ({ label: k })),
          index: kits.indexOf(currentKit()),
          title: currentKit(),
          tag: "KIT",
          summary: page.summary(),
        });
      }
      if (s.encPage === DUCK_PAGE) {
        const d = t.duck;
        const target = t.kind === "drum" ? `${t.pads.filter((_, i) => padDucks(t, i)).length} pads` : t.name;
        return duckScreen({
          ...d, track: trackLabel(s), status, source: inputLabel(d.input), target,
          level: engine.voices.duckLevel(t.id), summary: PAGES[DUCK_PAGE].summary(),
        });
      }
      if (t.kind === "keys") {
        const k = t.keys!;
        // Encoder 1 of the Keys page scrolls this list: the synth's presets or the library's samples.
        // The other sources show what they play.
        // Synth presets are shown a folder at a time (encoder 1 scrolls on into the next folder, Shift jumps folders).
        const lib = k.type === "sample" ? keysSampleList() : [];
        const all = k.type === "synth" ? allPresets() : [];
        const current = all.find((x) => x.name === k.preset);
        const inFolder = current ? all.filter((x) => x.folder === current.folder) : all;
        const presets = k.type === "synth" ? inFolder
          : k.type === "sample" ? lib.map((x) => ({ name: x.name, user: false }))
          : [{ name: keysSoundName(s, k), user: false }];
        const index = k.type === "synth" ? presets.findIndex((x) => x.name === k.preset)
          : k.type === "sample" ? lib.findIndex((x) => x.id === k.sample.sampleId) : 0;
        return keysScreen({
          track: trackLabel(s),
          status,
          presets: presets.length ? presets.map((x) => ({ label: x.name, user: x.user })) : [{ label: "No samples in the library" }],
          index: Math.max(0, index),
          title: presetLabel(),
          tag: page.tag,
          summary: page.summary(),
          folder: current ? { name: current.folder, pos: `${index + 1}/${presets.length}` } : undefined,
        });
      }
      const pad = t.pads[s.selectedPad];
      return padScreen({
        track: trackLabel(s),
        pad: s.selectedPad, name: pad.name, peaks: peaksFor(pad.sampleId), start: pad.start, end: pad.end,
        status,
        pageTag: page.tag, pageInfo: page.summary(),
      });
    }
    case "chop": {
      const v = chopView(W);
      return v && chopScreen(v);
    }
    case "track": {
      // Top row = tracks 1-8 (selected = solid), bottom row = their mute / solo state (solid = audible).
      const cells = Array.from({ length: 16 }, (_, i) => {
        const t = p.tracks[i >= 8 ? i - 8 : i];
        // The next free slot: "+" to add a track there, its kind (D / K) while one is set up.
        if (!t && i - 8 === p.tracks.length) return newTrack ? { label: newTrack.kind === "drum" ? "D" : "K", fill: true } : { label: "+", fill: false };
        if (!t) return { label: "", fill: false, dim: true };
        if (i >= 8) return { label: `${i - 7}`, fill: t.id === s.selectedTrack, mark: t.kind === "keys" };
        return { label: t.solo ? "S" : t.mute ? "M" : "", fill: trackAudible(p, t.id) };
      });
      return gridScreen({ title: trackLabel(s), status, cells, tag: "TRACK", info: newTrack ? "Enc1 kind Tap:add" : "Up:pick Dn:mute" });
    }
    case "mute": {
      // The pads of the drum track (the last one picked when a keys track is selected).
      const t = drumTrack(s);
      const cells = t.pads.map((pad, i) => ({
        label: t.padSolos[i] ? "S" : t.padMutes[i] ? "M" : `${i + 1}`,
        fill: !t.padMutes[i] && !!pad.sampleId,
        dim: !pad.sampleId,
      }));
      return gridScreen({ title: `T${p.tracks.indexOf(t) + 1} ${t.name}`, status, cells, tag: "MUTE", info: "1x mute 2x solo" });
    }
    case "pattern": {
      // Current = solid, has notes = bar, queued = dotted.
      const cells = p.patterns.map((pat, i) => ({
        label: `${i + 1}`,
        fill: i === s.currentPattern,
        mark: patternHasNotes(pat),
        dim: i === s.queuedPattern,
      }));
      return gridScreen({
        title: trackLabel(s), status, cells, tag: "PATTERN",
        info: s.queuedPattern !== null ? `Next: P${s.queuedPattern + 1}` : "Hold+tap copy",
      });
    }
    case "step": {
      const t = selectedTrack(s);
      return stepScreen({
        track: trackLabel(s),
        status,
        item: t.kind === "drum" ? trackItemName(s, t) : `Note ${noteName(keysStepNote(t))}`,
        bar: stepPageLabel(), bars: trackBars(p.patterns[s.currentPattern], t.id),
        steps: stepsOf(s), perRow: stepGrid(s).perRow, playhead: playheadStep(s),
        pageTag: PAGES[s.encPage].tag, pageInfo: PAGES[s.encPage].summary(),
      });
    }
    default:
      return null;
  }
}

function renderLoop() {
  const s = get();
  const bootMs = bootElapsed();
  const boot = bootFrame(bootMs);
  const msg = boot ? null : activeOverlay();
  // Shift held: the shift map, until an encoder is turned (fine steps), when the value matters more.
  const shiftMap = s.shift && msg?.encoder === undefined && !boot;
  const next = boot ?? (shiftMap ? shiftScreen({ rows: shiftRows(s.hwMode, selectedTrack(s).kind, s.sampling !== "idle", browseOnFolder()), enc: shiftEncHint(s.hwMode) }) : screenFor(s, msg));
  // Nothing to draw yet (Chop waiting for its buffer): keep the last frame rather than flashing device text.
  frame = next ?? frame;
  launchkey.shiftCover = shiftCoverText(s.hwMode, selectedTrack(s).kind, browseOnFolder());
  // On the 8-encoder screen the turned cell is highlighted instead; a popup would cover the bottom row.
  const suppress = msg?.encoder !== undefined && onEncoderScreen(s) && !shiftMap;
  if (frame && msg && !suppress) {
    if (msg.visual?.kind === "filter") filterPanel(frame, 0, HEADER_H, W, H - HEADER_H - 10, msg.visual);
    if (msg.visual?.kind === "duck") duckPanel(frame, 0, HEADER_H, W, H - HEADER_H - 10, msg.visual);
    overlayBar(frame, msg.name, msg.value);
  }
  if (!launchkey.connected || ledsPaused) return;
  launchkey.setPads(boot ? bootLeds(bootMs) : s.hwMode === "browse" ? browseLeds() : s.hwMode === "chop" ? chopPadLeds(heldPads) : padLeds(s));
  const ep = encPageLeds(s);
  launchkey.setButtonLed(CC.encPageUp, ep.up);
  launchkey.setButtonLed(CC.encPageDown, ep.down);
  const pa = padArrowLeds(s);
  launchkey.setButtonLed(CC.padUp, pa.up);
  launchkey.setButtonLed(CC.padDown, pa.down);
  const fs = funcSceneLeds(s);
  launchkey.setButtonLed(CC.func, fs.func);
  launchkey.setButtonLed(CC.scene, fs.scene);
  const t = transportLeds(s);
  launchkey.setButtonLed(CC.play, t.play);
  launchkey.setButtonLed(CC.record, t.record);

  if (frame && launchkey.bitmapSupported !== false) {
    launchkey.showBitmap(frame.pack());
    bitmapActive = true;
    return;
  }
  if (bitmapActive) {
    launchkey.clearBitmap();
    bitmapActive = false;
    lastStationary = "";
  }
  if (s.hwMode === "browse") return showStationaryIfChanged(...browseDisplay());
  const p = s.project;
  const line1 = `P${s.currentPattern + 1} ${p.bpm}BPM ${transportState(s)}`;
  const line2 = `${MODE_NAMES[s.hwMode]} ${s.hwMode === "step" ? `B${stepPageLabel()} ` : ""}${trackLabel(s)}`;
  showStationaryIfChanged(line1, line2);
}

const LED_FULL = 127, LED_DIM = 16;

/** Function: lit (cycles modes; in Browse it opens/loads, so off in an empty folder).
 *  Scene: dim, bright while note repeat is held; in Browse lit when you can go up a folder. */
function funcSceneLeds(s: AppState) {
  if (s.hwMode === "browse") {
    const can = browseCan();
    return { func: can.enter ? LED_FULL : 0, scene: can.up ? LED_FULL : 0 };
  }
  return { func: LED_FULL, scene: sequencer.repeatOn ? LED_FULL : LED_DIM };
}

/** Encoder page arrows: lit when the selected track has a page that way. Browse: they step through the list. Shift: Browse / Chop
 *  (Chop: drum tracks; in Browse, when a sample is highlighted). Chop: its Sample / Chop pages. */
function encPageLeds(s: AppState) {
  if (s.shift) {
    const chop = s.hwMode === "browse" ? browseOnSample() : selectedTrack(s).kind === "drum" || s.hwMode === "chop";
    return { up: LED_FULL, down: chop ? LED_FULL : 0 };
  }
  if (s.hwMode === "chop") return { up: s.chop?.page === "chop" ? LED_FULL : 0, down: s.chop?.page === "sample" ? LED_FULL : 0 };
  if (s.hwMode === "browse") {
    const on = browseCan().enter ? LED_FULL : 0;
    return { up: on, down: on };
  }
  const list = pagesFor(selectedTrack(s).kind), i = list.indexOf(s.encPage);
  return { up: i > 0 ? LED_FULL : 0, down: i < list.length - 1 ? LED_FULL : 0 };
}

/** Pad up/down: lit when there is somewhere to go. Step mode = bar pages, Browse = up a folder / open, Chop = markers, else = patterns. Shift: tracks. */
function padArrowLeds(s: AppState) {
  if (s.shift) {
    // Previous / next track.
    const on = s.project.tracks.length > 1 ? LED_FULL : 0;
    return { up: on, down: on };
  }
  if (s.hwMode === "browse") {
    const can = browseCan();
    return { up: can.up ? LED_FULL : 0, down: can.enter ? LED_FULL : 0 };
  }
  if (s.hwMode === "chop") {
    const m = chopMarkerArrows();
    return { up: m.up ? LED_FULL : 0, down: m.down ? LED_FULL : 0 };
  }
  const [pos, last] = s.hwMode === "step" ? [s.stepPage, stepPages(s.project.patterns[s.currentPattern], s.selectedTrack) - 1] : [s.currentPattern, 15];
  return { up: pos > 0 ? LED_FULL : 0, down: pos < last ? LED_FULL : 0 };
}

/** Play: lit while playing, bright on each beat. Record: blinks on beats in count-in, solid while recording;
 *  sampling blinks fast while waiting for sound, solid while capturing. */
export function transportLeds(s: AppState, tick = sequencer.tickAt()?.tick ?? null, nowMs = performance.now()) {
  const onBeat = tick !== null && (((tick % PPQN) + PPQN) % PPQN) < PPQN / 2;
  const play = s.playing && !s.countIn ? (onBeat ? LED_FULL : LED_DIM) : 0;
  let record = 0;
  if (s.sampling === "waiting") record = Math.floor(nowMs / 150) % 2 ? LED_FULL : 0;
  else if (s.sampling === "recording") record = LED_FULL;
  else if (s.countIn) record = onBeat ? LED_FULL : 0;
  else if (s.recording) record = LED_FULL;
  return { play, record };
}

function padLeds(s: AppState) {
  const p = s.project;
  const steps = s.hwMode === "step" ? stepsOf(s) : [];
  const head = s.hwMode === "step" ? playheadStep(s) : -1;
  const len = trackLength(p.patterns[s.currentPattern], s.selectedTrack);
  const leds: { color: number; mode?: LedMode }[] = [];
  for (let i = 0; i < 16; i++) {
    let color: number = COLOR.off;
    let mode: LedMode = "static";
    switch (s.hwMode) {
      case "play": {
        const t = selectedTrack(s);
        if (t.kind === "keys") {
          // Note pads in the track colour, the Cs white.
          color = heldPads.has(i) ? COLOR.white : noteForKeysPad(i) % 12 === 0 ? COLOR.dimWhite : t.color;
          break;
        }
        const pad = drumPads(s)[i];
        color = heldPads.has(i) ? COLOR.white : pad.sampleId ? pad.color : COLOR.off;
        if (i === s.selectedPad && !heldPads.has(i)) mode = "pulse";
        break;
      }
      case "step": {
        const g = stepGrid(s);
        const step = stepForPad(i, g.perRow);
        const tick = (g.first + step) * g.span;
        if (step < 0 || tick >= len) break;
        const t = selectedTrack(s);
        const trackColor = t.kind === "drum" ? t.pads[s.selectedPad].color : t.color;
        color = steps[step] ? trackColor : tick % PPQN === 0 ? COLOR.dimWhite : COLOR.off;
        if (step === head) color = COLOR.white;
        break;
      }
      case "track": {
        // Top row: tracks in their colours, the selected one pulsing. Bottom row: their mute/solo state.
        // The next free slot glows dimly (tap to add a track), pulsing while one is set up.
        const t = p.tracks[i >= 8 ? i - 8 : i];
        if (!t && i - 8 === p.tracks.length) {
          color = newTrack ? COLOR.white : COLOR.dimWhite;
          if (newTrack) mode = "pulse";
        }
        if (!t) break;
        if (i >= 8) {
          color = t.color;
          if (t.id === s.selectedTrack) mode = "pulse";
        } else color = t.solo ? COLOR.yellow : !trackAudible(p, t.id) ? COLOR.dimRed : COLOR.green;
        break;
      }
      case "mute": {
        const t = drumTrack(s);
        color = t.padSolos[i] ? COLOR.yellow : t.padMutes[i] ? COLOR.dimRed : t.pads[i].sampleId ? COLOR.green : COLOR.dimGreen;
        break;
      }
      case "pattern": {
        const has = patternHasNotes(p.patterns[i]);
        color = i === s.currentPattern ? COLOR.green : has ? COLOR.blue : COLOR.off;
        if (i === s.queuedPattern) { color = COLOR.green; mode = "flash"; }
        break;
      }
    }
    leds.push({ color, mode });
  }
  return leds;
}

function showStationaryIfChanged(line1: string, line2: string) {
  const text = line1 + "|" + line2;
  if (text !== lastStationary) {
    lastStationary = text;
    launchkey.showStationary(line1, line2);
  }
}
