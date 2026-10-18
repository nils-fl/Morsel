// Maps Launchkey events to actions per hardware mode, and renders LEDs + display.
import { allPresets, keyOff, keyOn, openInChop, playPad, releasePad, sendChopToNewTrack, toggleSampling, togglePlay, toggleRecord } from "../actions";
import { engine } from "../audio/engine";
import { launchkey } from "../midi/launchkey";
import { CC, COLOR, type LedMode, type PadLayout } from "../midi/protocol";
import { DUCK_PAGE, PAGES, duckSourceLabel, duckTargetLabel, fixPage, padLabel, pagesFor, presetLabel, setDuck, stepPage, turnEncoder } from "../params";
import { makeTicker, sequencer } from "../seq/sequencer";
import { PPQN, STEP_TICKS } from "../seq/timing";
import {
  type AppState, clearTrack, clipOf, copyClip, copyPattern, drumPads, drumTrack, get, patternHasNotes, patternLength, selectTrack,
  selectedTrack, set, stepTrack, store, togglePadFlag, toggleStep, toggleTrackFlag, trackAudible, undo, updateProject, PAD_COLORS,
} from "../state/store";
import type { HwMode, Track } from "../state/types";
import { noteForKeysPad, stepForPad } from "./stepMap";
import { noteName } from "../ui/notes";
import { activeOverlay, showTemp } from "./notify";
import { chopAddMarker, chopEncoder, chopPad, chopPadLeds, chopRemoveMarker, chopStop, chopTogglePlay, chopView } from "./chop";
import { browseCan, browseDisplay, browseEncoder, browseEnter, browseFolderToPads, browseLeds, browsePad, browseUp, browseView, enterBrowse, exitBrowse } from "./browse";
import { H, W, type Frame } from "../display/frame";
import { browserScreen, chopScreen, duckScreen, keysScreen, padScreen, stepScreen } from "../display/screens";
import { HEADER_H, computePeaks, duckPanel, filterPanel, overlayBar, type Peaks } from "../display/widgets";
import { BOOT_BURP_MS, BOOT_EAT_MS, bootFrame } from "../display/bootAnim";

const MODES: HwMode[] = ["play", "step", "track", "mixer", "pattern"];
const MODE_NAMES: Record<HwMode, string> = { play: "Play", step: "Step", track: "Track", mixer: "Mixer", pattern: "Pattern", browse: "Browse", chop: "Chop" };
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

// Start-up animation: plays when the page loads and whenever the Launchkey connects; any input skips it.
let bootStart = -Infinity;
const bootElapsed = () => performance.now() - bootStart;

/** Pads during the animation: a colour sweep following the blob, a white flash on the burp, then a rainbow chase. */
function bootLeds(ms: number) {
  return Array.from({ length: 16 }, (_, i) => {
    const col = i % 8;
    if (ms < BOOT_EAT_MS) {
      const at = Math.floor((ms / BOOT_EAT_MS) * 8);
      return { color: col === at ? COLOR.white : col < at ? PAD_COLORS[i] : COLOR.off };
    }
    if (ms < BOOT_BURP_MS) return { color: Math.floor(ms / 100) % 2 ? COLOR.white : COLOR.off };
    return { color: PAD_COLORS[(i + Math.floor(ms / 80)) % 16] };
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
  });
  launchkey.on((e) => {
    const s = get();
    if (e.type === "pad" || e.type === "key" || e.type === "button" || e.type === "encoder") bootStart = -Infinity;
    if (!s.audioReady && ((e.type === "pad" && e.on) || (e.type === "button" && e.down && e.button !== "shift"))) showTemp("NO AUDIO", "CLICK THE PAGE");
    switch (e.type) {
      case "connection":
        set({ connected: e.connected, status: e.connected ? "Launchkey connected" : "Launchkey disconnected" });
        if (e.connected) {
          launchkey.setLayout(layoutFor(s.hwMode));
          lastStationary = "";
          bootStart = performance.now();
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

// Notes currently sounding on a keys track (note -> track), so a key released after a mode or track switch still stops.
const instrumentKeys = new Map<number, string>();
// Keys used to pick a sound in Step mode (pad index per note).
const selectKeys = new Map<number, number>();
/** Step mode on a keys track: the note the step pads write (the last key pressed). */
let stepNote: number | null = null;

/** "Kick" for the selected pad on a drum track, the track name for a keys track. */
const trackItemName = (s: AppState, t: Track) => (t.kind === "drum" ? t.pads[s.selectedPad].name : t.name);
/** The note the step pads write on a keys track: the last key played. */
const keysStepNote = (t: Track) => stepNote ?? (t.keys?.type === "synth" ? 48 : 60);

/** Step mode: key -> pad, repeating every 16 keys. At the default octave the lowest key (C3 = 48) is pad 1. */
export const padForKey = (note: number) => ((note % 16) + 16) % 16;

function onKey(note: number, vel: number, on: boolean) {
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
    return;
  }
  const s = get();
  const sel = selectedTrack(s);
  if (s.hwMode === "step" && sel.kind === "drum") {
    // Shift + pad is taken by the Launchkey's own pad-mode shortcut, so the keys pick the sound here.
    const pad = padForKey(note);
    selectKeys.set(note, pad);
    set({ selectedPad: pad });
    engine.voices.pad(sel.id, pad, vel, engine.now);
    showTemp("Pad", padLabel(sel.id, pad));
    return;
  }
  if (s.hwMode === "step") {
    // Keys track: the key you play is the note the step pads write.
    stepNote = note;
    instrumentKeys.set(note, keyOn(note, vel, sel.id));
    return;
  }
  instrumentKeys.set(note, keyOn(note, vel));
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

function onPad(pad: number, vel: number, on: boolean) {
  const s = get();
  if (!on) {
    const note = keysPads.get(pad);
    if (note) {
      keysPads.delete(pad);
      keyOff(note.note, note.track);
    } else if (s.hwMode === "play") {
      releasePad(pad);
      sequencer.repeatPads.delete(`${drumTrack(s).id}:${pad}`);
    }
    return;
  }
  const sel = selectedTrack(s);
  switch (s.hwMode) {
    case "browse":
      set({ selectedPad: pad });
      browsePad();
      break;
    case "chop":
      chopPad(pad, vel);
      break;
    case "play": {
      if (sel.kind === "keys") {
        // Keys track: the pads are notes, recorded like the keybed.
        const note = noteForKeysPad(pad);
        keysPads.set(pad, { note, track: keyOn(note, vel, sel.id) });
        break;
      }
      // On the Duck page the pad you hit becomes the sidechain input.
      const drums = drumTrack(s);
      if (s.encPage === DUCK_PAGE && (s.project.duck.sourceTrack !== drums.id || s.project.duck.sourcePad !== pad)) {
        setDuck({ sourceTrack: drums.id, sourcePad: pad });
        showTemp("Duck input", duckSourceLabel());
      }
      if (sequencer.repeatOn && s.playing) {
        sequencer.repeatPads.set(`${drums.id}:${pad}`, { track: drums.id, pad, vel });
        set({ selectedPad: pad, selectedTrack: drums.id });
      } else playPad(pad, vel);
      break;
    }
    case "step": {
      const pat = s.project.patterns[s.currentPattern];
      const tick = (s.stepPage * 16 + stepForPad(pad)) * STEP_TICKS;
      if (tick >= patternLength(pat)) break;
      const t = selectedTrack(s);
      const note = t.kind === "drum" ? s.selectedPad : keysStepNote(t);
      toggleStep(s.currentPattern, t.id, tick, STEP_TICKS, note, Math.max(vel, 40));
      break;
    }
    case "track": {
      // Top row = select track 1-8. Bottom row = mute track 1-8, double-tap = solo.
      const p = s.project;
      if (pad >= 8) {
        const t = p.tracks[pad - 8];
        if (!t) break;
        selectTrack(t.id);
        showTemp(`Track ${pad - 7}`, `${t.name} (${t.kind === "drum" ? "pads" : "keys"})`);
        break;
      }
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
    case "mixer": {
      // Pads of the drum track. Tap = mute. Double-tap = solo: the second tap undoes the first tap's mute and toggles solo.
      if (sel.kind !== "drum") {
        showTemp("Mixer", "Drum tracks only");
        break;
      }
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
        if (sequencer.repeatOn) {
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
}

function onButton(button: string, down: boolean) {
  const s = get();
  if (button === "shift") return set({ shift: down });
  // Shift + the encoder page arrows: Browse and Chop on / off (drum tracks). Checked before Browse takes the arrows.
  if (down && s.shift && (button === "encPageUp" || button === "encPageDown")) {
    if (button === "encPageUp" ? s.hwMode === "browse" : s.hwMode === "chop") return button === "encPageUp" ? setHwMode(s.prevHwMode) : exitChopHw();
    if (selectedTrack(s).kind !== "drum") return showTemp(button === "encPageUp" ? "Browse" : "Chop", "Drum track only");
    return button === "encPageUp" ? setHwMode("browse") : hwOpenChop();
  }
  if (s.hwMode === "browse" && down) {
    // Browse owns Func / Pad down (open/load), Scene / Pad up (up a folder) and the encoder page arrows
    // (one item), so the left hand selects while the right scrolls.
    if ((button === "func" || button === "padDown") && !s.shift) return void browseEnter();
    if (button === "scene" || (button === "padUp" && !s.shift)) return browseUp();
    if (button === "encPageUp" || button === "encPageDown") return browseEncoder(0, button === "encPageUp" ? -1 : 1, false);
  }
  if (s.hwMode === "browse" && down && button === "func" && s.shift) return browseFolderToPads();
  if (s.hwMode === "chop") {
    // Chop owns Scene (add a marker, Shift = remove), Play (audition) and Function (send to a new drum rack).
    if (button === "scene") return void (down && (s.shift ? chopRemoveMarker() : chopAddMarker()));
    if (down && !s.shift && button === "play") return chopTogglePlay();
    if (down && !s.shift && button === "func") return void sendChopToNewTrack();
  }
  // Shift + Pad up / down: previous / next track ("< Track" / "Track >" on the device). The device sends its own
  // Track CCs for them, so that is what arrives; padUp / padDown + Shift are kept as a fallback.
  const trackDir = button === "trackPrev" || (button === "padUp" && s.shift) ? -1 : button === "trackNext" || (button === "padDown" && s.shift) ? 1 : 0;
  if (trackDir) {
    if (!down) return;
    const t = stepTrack(trackDir);
    const n = get().project.tracks.indexOf(t) + 1;
    // Browse and Chop work on drum tracks; on a keys track go back to playing.
    if (t.kind !== "drum" && s.hwMode === "browse") setHwMode(s.prevHwMode);
    showTemp(`Track ${n}/${get().project.tracks.length}`, `${t.name} (${t.kind === "drum" ? "drums" : "keys"})`);
    return;
  }
  if (button === "scene") {
    // Hold for note repeat (Play) or song-append (Pattern); Shift+Scene clears the selected track in this pattern.
    if (down && s.shift) {
      // Step mode on a drum track clears the selected pad's notes; elsewhere the whole clip.
      const t = selectedTrack(s);
      const onePad = s.hwMode === "step" && t.kind === "drum";
      clearTrack(s.currentPattern, t.id, onePad ? s.selectedPad : undefined);
      showTemp("Cleared", onePad ? trackItemName(s, t) : t.name);
      return;
    }
    sequencer.repeatOn = down;
    const drums = drumTrack(s).id;
    if (down && s.hwMode === "play") for (const p of heldPads) sequencer.repeatPads.set(`${drums}:${p}`, { track: drums, pad: p, vel: 100 });
    else if (!down) sequencer.repeatPads.clear();
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
        if (s.sampleSource === "tab" && s.sampling === "idle" && !s.tabShared) showTemp("Sample", "Share tab on screen");
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
      const page = stepPage(s.encPage, button === "encPageUp" ? -1 : 1);
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

/** "T2 Keys 1": the selected track's number and name, for the screen headers. */
function trackLabel(s: AppState) {
  const t = selectedTrack(s);
  return `T${s.project.tracks.indexOf(t) + 1} ${t.name}`;
}

function transportState(s: AppState) {
  return s.sampling !== "idle" ? "SAMPLING" : s.countIn ? "COUNT-IN" : s.recording ? "REC" : s.playing ? "PLAY" : "STOP";
}

function stepsOf(s: AppState) {
  const pat = s.project.patterns[s.currentPattern];
  const len = patternLength(pat);
  const t = selectedTrack(s);
  const events = clipOf(pat, t.id).events.filter((e) => t.kind !== "drum" || e.note === s.selectedPad);
  return Array.from({ length: 16 }, (_, step) => {
    const tick = (s.stepPage * 16 + step) * STEP_TICKS;
    return tick < len && events.some((e) => e.tick >= tick && e.tick < tick + STEP_TICKS);
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
      const t = selectedTrack(s);
      if (s.encPage === DUCK_PAGE) {
        const d = p.duck;
        return duckScreen({
          ...d, source: duckSourceLabel(), target: duckTargetLabel(d.target),
          level: engine.voices.duckLevel(d.target), summary: PAGES[DUCK_PAGE].summary(),
        });
      }
      if (t.kind === "keys") {
        const presets = allPresets();
        const k = t.keys!;
        return keysScreen({
          track: trackLabel(s),
          presets: presets.map((x) => ({ label: x.name, user: x.user })),
          index: Math.max(0, presets.findIndex((x) => x.name === k.preset)),
          title: presetLabel(),
          note: k.type === "synth" ? "SYNTH" : "SAMPLE",
          tag: PAGES[s.encPage].tag,
          summary: PAGES[s.encPage].summary(),
        });
      }
      const pad = t.pads[s.selectedPad];
      return padScreen({
        track: trackLabel(s),
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
        track: trackLabel(s),
        item: selectedTrack(s).kind === "drum" ? trackItemName(s, selectedTrack(s)) : `Note ${noteName(keysStepNote(selectedTrack(s)))}`,
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
  const bootMs = bootElapsed();
  const boot = bootFrame(bootMs);
  frame = boot ?? screenFor(s);
  const msg = boot ? null : activeOverlay();
  if (frame && msg) {
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
  const line2 = `${MODE_NAMES[s.hwMode]} ${s.hwMode === "step" ? `B${s.stepPage + 1} ` : ""}${trackLabel(s)}`;
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

/** Encoder page arrows: lit when the selected track has a page that way. Browse: they step through the list. Shift: Browse / Chop. */
function encPageLeds(s: AppState) {
  if (s.shift) return { up: LED_FULL, down: LED_FULL }; // Browse / Chop
  if (s.hwMode === "browse") {
    const on = browseCan().enter ? LED_FULL : 0;
    return { up: on, down: on };
  }
  const list = pagesFor(selectedTrack(s).kind), i = list.indexOf(s.encPage);
  return { up: i > 0 ? LED_FULL : 0, down: i < list.length - 1 ? LED_FULL : 0 };
}

/** Pad up/down: lit when there is somewhere to go. Step mode = bar pages, Browse = up a folder / open, else = patterns. Shift: tracks. */
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
        const step = stepForPad(i);
        if ((s.stepPage * 16 + step) * STEP_TICKS >= len) break;
        const t = selectedTrack(s);
        const trackColor = t.kind === "drum" ? t.pads[s.selectedPad].color : t.color;
        color = steps[step] ? trackColor : step % 4 === 0 ? COLOR.dimWhite : COLOR.off;
        if (step === head) color = COLOR.white;
        break;
      }
      case "track": {
        // Top row: tracks in their colours, the selected one pulsing. Bottom row: their mute/solo state.
        const t = p.tracks[i >= 8 ? i - 8 : i];
        if (!t) break;
        if (i >= 8) {
          color = t.color;
          if (t.id === s.selectedTrack) mode = "pulse";
        } else color = t.solo ? COLOR.yellow : !trackAudible(p, t.id) ? COLOR.dimRed : COLOR.green;
        break;
      }
      case "mixer": {
        if (selectedTrack(s).kind !== "drum") break;
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
