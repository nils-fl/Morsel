// Maps Launchkey events to actions per hardware mode, and renders LEDs + display.
import { keyOff, keyOn, playPad, releasePad, toggleSampling, togglePlay, toggleRecord } from "../actions";
import { engine } from "../audio/engine";
import { launchkey } from "../midi/launchkey";
import { CC, COLOR, type LedMode, type PadLayout } from "../midi/protocol";
import { PAGES, turnEncoder } from "../params";
import { makeTicker, sequencer } from "../seq/sequencer";
import { PPQN, STEP_TICKS } from "../seq/timing";
import { type AppState, clearTrack, get, patternLength, set, toggleArray, toggleStep, undo, updateProject, KEYS_TRACK } from "../state/store";
import type { HwMode } from "../state/types";
import { stepForPad } from "./stepMap";
import { activeOverlay, showTemp } from "./notify";
import { chopEncoder, chopPad, chopPadLeds, chopView } from "./chop";
import { browseCan, browseDisplay, browseEncoder, browseEnter, browseLeds, browsePad, browseUp, browseView, enterBrowse, exitBrowse } from "./browse";
import { H, W, type Frame } from "../display/frame";
import { browserScreen, chopScreen, padScreen, stepScreen } from "../display/screens";
import { HEADER_H, computePeaks, filterPanel, overlayBar, type Peaks } from "../display/widgets";

const MODES: HwMode[] = ["play", "step", "mixer", "pattern"];
const MODE_NAMES: Record<HwMode, string> = { play: "Play", step: "Step", mixer: "Mixer", pattern: "Pattern", browse: "Browse", chop: "Chop" };
/** Modes entered on top of another one; leaving them returns to prevHwMode. */
const TEMPORARY: HwMode[] = ["browse", "chop"];


/** Play and Chop use the drum layout (velocity, pressure); every other mode lights the pads in DAW layout. */
const layoutFor = (mode: HwMode): PadLayout => (mode === "play" || mode === "chop" ? "drum" : "daw");
let lastLayoutFix = 0;

export function setHwMode(mode: HwMode) {
  const prev = get().hwMode;
  if (prev === mode) return;
  if (prev === "browse") exitBrowse();
  if (mode === "browse") enterBrowse();
  set({ hwMode: mode, prevHwMode: TEMPORARY.includes(prev) ? get().prevHwMode : prev });
  launchkey.setLayout(layoutFor(mode));
  showTemp("Mode", MODE_NAMES[mode]);
}


/** The Chop tab takes over the encoders, pads and screen while it is open. */
export function enterChopHw() {
  if (get().hwMode !== "chop") setHwMode("chop");
}

export function exitChopHw() {
  if (get().hwMode === "chop") setHwMode(get().prevHwMode);
}

const heldPads = new Set<number>();

export function initController() {
  launchkey.on((e) => {
    const s = get();
    if (!s.audioReady && ((e.type === "pad" && e.on) || (e.type === "button" && e.down && e.button !== "shift"))) showTemp("NO AUDIO", "CLICK THE PAGE");
    switch (e.type) {
      case "connection":
        set({ connected: e.connected, status: e.connected ? "Launchkey connected" : "Launchkey disconnected" });
        if (e.connected) {
          launchkey.setLayout(layoutFor(s.hwMode));
          lastStationary = "";
        }
        break;
      case "layout": {
        // The device reports its layout after connecting (often "daw" right after the handshake) and when
        // switched from the hardware. Put back the one the current mode needs, at most once a second so a
        // device that keeps refusing can't cause a loop.
        const want = layoutFor(s.hwMode);
        if (e.layout !== want && performance.now() - lastLayoutFix > 1000) {
          lastLayoutFix = performance.now();
          launchkey.setLayout(want);
        }
        break;
      }
      case "pad":
        if (e.on) heldPads.add(e.pad);
        else heldPads.delete(e.pad);
        onPad(e.pad, e.velocity, e.on);
        break;
      case "padPressure":
        engine.voices.pressure[e.pad] = e.pressure;
        break;
      case "key":
        onKey(e.note, e.velocity, e.on);
        break;
      case "encoder": {
        if (s.hwMode === "browse") {
          browseEncoder(e.index, e.delta, s.shift);
          break;
        }
        if (s.hwMode === "chop") {
          chopEncoder(e.index, e.delta, s.shift);
          break;
        }
        const p = turnEncoder(s.encPage, e.index, e.delta, s.shift);
        if (p) showTemp(p.name, p.format(), p.visual?.());
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

// Notes currently sounding on the Keys instrument, so a key released after a mode switch still stops.
const instrumentKeys = new Set<number>();
// Keys used to pick a sound in Step mode (pad index per note).
const selectKeys = new Map<number, number>();

/** Step mode: key -> pad, repeating every 16 keys. At the default octave the lowest key (C3 = 48) is pad 1. */
export const padForKey = (note: number) => ((note % 16) + 16) % 16;

function onKey(note: number, vel: number, on: boolean) {
  if (!on) {
    if (instrumentKeys.delete(note)) keyOff(note);
    const pad = selectKeys.get(note);
    if (pad !== undefined) {
      selectKeys.delete(note);
      releasePad(pad);
    }
    return;
  }
  const s = get();
  if (s.hwMode === "step") {
    // Shift + pad is taken by the Launchkey's own pad-mode shortcut, so the keys pick the sound here.
    const pad = padForKey(note);
    selectKeys.set(note, pad);
    set({ selectedTrack: pad, selectedPad: pad });
    engine.voices.pad(pad, vel, engine.now);
    showTemp("Track", `${pad + 1} ${s.project.pads[pad].name}`);
    return;
  }
  instrumentKeys.add(note);
  keyOn(note, vel);
}

const DOUBLE_TAP_MS = 300;
let lastMixerTap = { pad: -1, at: 0 };

function onPad(pad: number, vel: number, on: boolean) {
  const s = get();
  if (!on) {
    if (s.hwMode === "play") {
      releasePad(pad);
      sequencer.repeatPads.delete(pad);
    }
    return;
  }
  switch (s.hwMode) {
    case "browse":
      set({ selectedPad: pad, selectedTrack: pad });
      browsePad();
      break;
    case "chop":
      chopPad(pad, vel);
      break;
    case "play":
      if (sequencer.repeatOn && s.playing) {
        sequencer.repeatPads.set(pad, vel);
        set({ selectedPad: pad, selectedTrack: pad });
      } else playPad(pad, vel);
      break;
    case "step": {
      const pat = s.project.patterns[s.currentPattern];
      const tick = (s.stepPage * 16 + stepForPad(pad)) * STEP_TICKS;
      if (tick >= patternLength(pat)) break;
      toggleStep(s.currentPattern, s.selectedTrack, tick, STEP_TICKS, 60, Math.max(vel, 40));
      break;
    }
    case "mixer": {
      // Tap = mute. Double-tap = solo: the second tap undoes the first tap's mute and toggles solo.
      const now = performance.now();
      const double = lastMixerTap.pad === pad && now - lastMixerTap.at < DOUBLE_TAP_MS;
      lastMixerTap = double ? { pad: -1, at: 0 } : { pad, at: now };
      if (double) {
        toggleArray("mutes", pad);
        toggleArray("solos", pad);
      } else toggleArray("mutes", pad);
      engine.voices.updateMix();
      const p = get().project;
      showTemp(p.pads[pad].name, double ? (p.solos[pad] ? "Solo" : "Solo off") : p.mutes[pad] ? "Muted" : "On");
      break;
    }
    case "pattern":
      // Hold Scene + pad = append to the song (Shift + pad is taken by the Launchkey).
      if (sequencer.repeatOn) {
        updateProject((p) => ({ ...p, song: [...p.song, { pattern: pad, repeats: 1 }] }));
        showTemp("Song +", `Pattern ${pad + 1}`);
      } else {
        sequencer.selectPattern(pad);
        showTemp("Pattern", `${pad + 1}${s.playing ? " (queued)" : ""}`);
      }
      break;
  }
}

function onButton(button: string, down: boolean) {
  const s = get();
  if (button === "shift") return set({ shift: down });
  if (s.hwMode === "browse" && down) {
    // Browse owns Func / Pad down (open/load), Scene / Pad up (up a folder) and the encoder page arrows
    // (one item), so the left hand selects while the right scrolls. Shift + Pad up (sent as trackPrev) leaves.
    if ((button === "func" || button === "padDown") && !s.shift) return void browseEnter();
    if (button === "scene" || (button === "padUp" && !s.shift)) return browseUp();
    if (button === "encPageUp" || button === "encPageDown") return browseEncoder(0, button === "encPageUp" ? -1 : 1, false);
  }
  // The device turns Shift + Pad up into its own "< Track" CC, so that is what arrives; padUp + shift kept as a fallback.
  if ((button === "trackPrev" || (button === "padUp" && s.shift)) && down) {
    setHwMode(s.hwMode === "browse" ? s.prevHwMode : "browse");
    return;
  }
  if (button === "scene") {
    // Hold for note repeat (Play) or song-append (Pattern); Shift+Scene clears the selected track in this pattern.
    if (down && s.shift) {
      clearTrack(s.currentPattern, s.selectedTrack);
      showTemp("Cleared", s.selectedTrack === KEYS_TRACK ? "Keys" : s.project.pads[s.selectedTrack].name);
      return;
    }
    sequencer.repeatOn = down;
    if (down) for (const p of heldPads) sequencer.repeatPads.set(p, 100);
    else sequencer.repeatPads.clear();
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
        if (s.sampleSource === "tab" && s.sampling === "idle") showTemp("Sample", "Start on screen");
        toggleSampling(true);
      }
      else toggleRecord();
      break;
    case "func":
      if (s.shift) {
        undo();
        showTemp("Undo", "");
      } else setHwMode(MODES[(MODES.indexOf(s.hwMode) + 1) % MODES.length]);
      break;
    case "encPageUp":
    case "encPageDown": {
      // No wrap-around: the arrow LEDs show which directions are available.
      const page = Math.max(0, Math.min(PAGES.length - 1, s.encPage + (button === "encPageUp" ? -1 : 1)));
      if (page !== s.encPage) set({ encPage: page });
      showTemp("Encoders", PAGES[page].name);
      break;
    }
    case "padUp":
    case "padDown": {
      const dir = button === "padUp" ? -1 : 1;
      if (s.hwMode === "step") {
        const bars = s.project.patterns[s.currentPattern].bars;
        const page = Math.max(0, Math.min(bars - 1, s.stepPage + dir));
        set({ stepPage: page });
        showTemp("Bar", `${page + 1} / ${bars}`);
      } else {
        const i = Math.max(0, Math.min(15, s.currentPattern + dir));
        sequencer.selectPattern(i);
        showTemp("Pattern", `${i + 1}`);
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

function transportState(s: AppState) {
  return s.sampling !== "idle" ? "SAMPLING" : s.countIn ? "COUNT-IN" : s.recording ? "REC" : s.playing ? "PLAY" : "STOP";
}

function stepsOf(s: AppState) {
  const pat = s.project.patterns[s.currentPattern];
  const len = patternLength(pat);
  return Array.from({ length: 16 }, (_, step) => {
    const tick = (s.stepPage * 16 + step) * STEP_TICKS;
    return tick < len && pat.events.some((e) => e.track === s.selectedTrack && e.tick >= tick && e.tick < tick + STEP_TICKS);
  });
}

function playheadStep(s: AppState) {
  const pos = sequencer.tickAt();
  if (!pos || pos.tick < 0 || pos.pattern !== s.currentPattern) return -1;
  const step = Math.floor(pos.tick / STEP_TICKS) - s.stepPage * 16;
  return step >= 0 && step < 16 ? step : -1;
}

/** Graphic screen for the current mode, or null for text-only modes. */
function screenFor(s: AppState): Frame | null {
  const p = s.project;
  switch (s.hwMode) {
    case "browse": {
      const v = browseView();
      return browserScreen({ folder: v.folder, index: v.index, items: v.items, targetPad: s.selectedPad });
    }
    case "play": {
      const pad = p.pads[s.selectedPad];
      return padScreen({
        pad: s.selectedPad, name: pad.name, peaks: peaksFor(pad.sampleId), start: pad.start, end: pad.end,
        status: `P${s.currentPattern + 1} ${transportState(s)}`,
        pageTag: PAGES[s.encPage].tag, pageInfo: PAGES[s.encPage].summary(),
      });
    }
    case "chop": {
      const v = chopView(W);
      return v && chopScreen(v);
    }
    case "step":
      return stepScreen({
        pattern: s.currentPattern,
        track: s.selectedTrack === KEYS_TRACK ? "Keys" : p.pads[s.selectedTrack].name,
        bar: s.stepPage, bars: p.patterns[s.currentPattern].bars,
        steps: stepsOf(s), playhead: playheadStep(s),
        status: `${p.bpm}BPM ${transportState(s)}`,
        pageTag: PAGES[s.encPage].tag,
      });
    default:
      return null;
  }
}

function renderLoop() {
  const s = get();
  frame = screenFor(s);
  const msg = activeOverlay();
  if (frame && msg) {
    if (msg.visual?.kind === "filter") filterPanel(frame, 0, HEADER_H, W, H - HEADER_H - 10, msg.visual);
    overlayBar(frame, msg.name, msg.value);
  }
  if (!launchkey.connected || ledsPaused) return;
  launchkey.setPads(s.hwMode === "browse" ? browseLeds() : s.hwMode === "chop" ? chopPadLeds(heldPads) : padLeds(s));
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
  const line2 = `${MODE_NAMES[s.hwMode]} ${s.hwMode === "step" ? `B${s.stepPage + 1} ` : ""}${s.selectedTrack === KEYS_TRACK ? "Keys" : p.pads[s.selectedPad].name}`;
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

/** Encoder page arrows: lit when there is a page to go to. Browse: they step through the list. */
function encPageLeds(s: AppState) {
  if (s.hwMode === "browse") {
    const on = browseCan().enter ? LED_FULL : 0;
    return { up: on, down: on };
  }
  return { up: s.encPage > 0 ? LED_FULL : 0, down: s.encPage < PAGES.length - 1 ? LED_FULL : 0 };
}

/** Pad up/down: lit when there is somewhere to go. Step mode = bar pages, Browse = up a folder / open, else = patterns. */
function padArrowLeds(s: AppState) {
  if (s.hwMode === "browse") {
    const can = browseCan();
    return { up: can.up ? LED_FULL : 0, down: can.enter ? LED_FULL : 0 };
  }
  const [pos, last] = s.hwMode === "step" ? [s.stepPage, s.project.patterns[s.currentPattern].bars - 1] : [s.currentPattern, 15];
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
  const len = patternLength(p.patterns[s.currentPattern]);
  const leds: { color: number; mode?: LedMode }[] = [];
  for (let i = 0; i < 16; i++) {
    let color: number = COLOR.off;
    let mode: LedMode = "static";
    switch (s.hwMode) {
      case "play": {
        const pad = p.pads[i];
        color = heldPads.has(i) ? COLOR.white : pad.sampleId ? pad.color : COLOR.off;
        if (i === s.selectedPad && !heldPads.has(i)) mode = "pulse";
        break;
      }
      case "step": {
        const step = stepForPad(i);
        if ((s.stepPage * 16 + step) * STEP_TICKS >= len) break;
        const trackColor = s.selectedTrack === KEYS_TRACK ? COLOR.purple : p.pads[s.selectedTrack].color;
        color = steps[step] ? trackColor : step % 4 === 0 ? COLOR.dimWhite : COLOR.off;
        if (step === head) color = COLOR.white;
        break;
      }
      case "mixer":
        color = p.solos[i] ? COLOR.yellow : p.mutes[i] ? COLOR.dimRed : p.pads[i].sampleId ? COLOR.green : COLOR.dimGreen;
        break;
      case "pattern": {
        const has = p.patterns[i].events.length > 0;
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
