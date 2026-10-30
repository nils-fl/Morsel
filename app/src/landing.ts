// The landing page's Launchkey: Morsel in miniature, with the app's own screens (display/) and Factory kit (audio/kit.ts).
// Pads mode plays the kit's 16 sounds; Steps mode puts the selected sound's 16 steps on the pads; the encoders set the
// tempo, swing, a master filter and echo, the selected sound's tune, decay and level, and the volume.
import { renderStabNote, renderStockKit, stockSounds } from "./audio/kit";
import { BOOT_MS, bootFrame } from "./display/bootAnim";
import { Frame, H, W } from "./display/frame";
import { encoderScreen, padScreen, stepScreen } from "./display/screens";
import { computePeaks, type Peaks } from "./display/widgets";
import { paletteCss } from "./ui/palette";

const KIT = "Factory";
const NAMES = stockSounds(KIT);
// store.ts PAD_COLORS: red, orange, yellow, lime, green, mint, cyan, sky, blue, purple, magenta, pink, then again.
const COLORS = [5, 9, 13, 17, 21, 29, 37, 41, 45, 49, 53, 57, 5, 9, 13, 21].map(paletteCss);
const KICK = 0, SNARE = 1, CLAP = 2, RIM = 3, HAT = 4, OPEN_HAT = 5, STAB = 15;
// Screen dots: tokens.css --screen-bg / --screen-fg, and the unlit dots between them.
const SCREEN_BG = "#15191c", DOT_OFF = "#1a1f22", DOT_ON = "#9cc9d4";

const root = document.getElementById("lk")!;
const canvas = root.querySelector<HTMLCanvasElement>("canvas")!;
const padEls = [...root.querySelectorAll<HTMLButtonElement>(".lk-pads button")];
const keyEls = [...root.querySelectorAll<HTMLElement>(".lk-keys i")];
const playBtn = root.querySelector<HTMLButtonElement>(".lk-play")!;
const recBtn = root.querySelector<HTMLButtonElement>(".lk-rec")!;
const modeBtns = [...root.querySelectorAll<HTMLButtonElement>(".lk-modes button")];
const say = document.getElementById("lk-say")!;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- the beat ----------

const steps = NAMES.map(() => Array<boolean>(16).fill(false));
const put = (pad: number, ...at: number[]) => at.forEach((s) => (steps[pad][s] = true));
put(KICK, 0, 7, 10);
put(SNARE, 4, 12);
put(CLAP, 12);
put(RIM, 15);
put(HAT, 0, 2, 4, 6, 8, 9, 12, 14);
put(OPEN_HAT, 11);

let mode: "pads" | "steps" = "pads";
let selected = KICK;
let playing = false;
let recording = false;

const tune = NAMES.map(() => 0);
const decay = NAMES.map(() => 100);
const level = [100, 80, 60, 55, 45, 40, 40, 35, 70, 70, 70, 50, 80, 35, 45, 50];
const mix = { tempo: 96, swing: 58, filter: 100, echo: 0, volume: 80 };

// ---------- sound ----------

const kit: Promise<{ buffers: AudioBuffer[]; peaks: Peaks[] }> = renderStockKit(KIT).then((sounds) => ({
  buffers: sounds.map((s) => s.buffer),
  peaks: sounds.map((s) => computePeaks(s.buffer.getChannelData(0), W)),
}));
let peaks: Peaks[] | null = null;
kit.then((k) => (peaks = k.peaks), () => {});

// The keys play one note of the Stab: the pad is a whole chord, and three keys of it would stack three chords.
const keyNote = renderStabNote();
// A chord on the keys is several voices at once: each a bit quieter than the Stab pad, so they don't clip together.
const KEY_LEVEL = 0.6;

interface Audio { ctx: AudioContext; buffers: AudioBuffer[]; keyNote: AudioBuffer; bus: GainNode; send: GainNode; delay: DelayNode; filter: BiquadFilterNode; out: GainNode }
let audio: Audio | null = null;
let starting: Promise<Audio> | null = null;

/** The audio graph, made on the first press (browsers only let a page make sound after one). */
function start(): Promise<Audio> {
  starting ??= (async () => {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const bus = ctx.createGain(), send = ctx.createGain(), delay = ctx.createDelay(2), fb = ctx.createGain();
    const filter = ctx.createBiquadFilter(), out = ctx.createGain();
    filter.type = "lowpass";
    filter.Q.value = 2;
    fb.gain.value = 0.42;
    bus.connect(filter);
    bus.connect(send).connect(delay).connect(fb).connect(delay);
    delay.connect(filter).connect(out).connect(ctx.destination);
    const [{ buffers }, note] = await Promise.all([kit, keyNote]);
    audio = { ctx, buffers, keyNote: note, bus, send, delay, filter, out };
    applyMix();
    return audio;
  })();
  return starting.then(async (a) => {
    if (a.ctx.state !== "running") await a.ctx.resume();
    return a;
  });
}

const stepDur = () => 60 / mix.tempo / 4;
const filterHz = () => 60 * Math.pow(20000 / 60, mix.filter / 100);

function applyMix() {
  if (!audio) return;
  const t = audio.ctx.currentTime;
  audio.filter.frequency.setTargetAtTime(filterHz(), t, 0.02);
  audio.send.gain.setTargetAtTime((mix.echo / 100) * 0.55, t, 0.02);
  audio.delay.delayTime.setTargetAtTime(stepDur() * 3, t, 0.05);
  audio.out.gain.setTargetAtTime(Math.pow(mix.volume / 100, 2), t, 0.02);
}

/** When each pad last sounded (audio time), for its LED. */
const hits = NAMES.map(() => -Infinity);
let openHat: GainNode | null = null;

/** Play a pad at audio time `t`; a key passes its own rate and plays the Stab's single note (and doesn't light the pad). */
function trigger(a: Audio, pad: number, t: number, keyRate?: number) {
  const rate = keyRate ?? 2 ** (tune[pad] / 12);
  const buffer = keyRate === undefined ? a.buffers[pad] : a.keyNote;
  const src = a.ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = a.ctx.createGain();
  const peak = Math.pow(level[pad] / 100, 1.5) * (keyRate === undefined ? 1 : KEY_LEVEL);
  g.gain.setValueAtTime(peak, t);
  const len = (buffer.duration / rate) * (decay[pad] / 100);
  if (decay[pad] < 100) {
    g.gain.setValueAtTime(peak, t + len * 0.6);
    g.gain.linearRampToValueAtTime(0, t + len);
    src.stop(t + len + 0.02);
  }
  // The closed hat chokes the open one, like on any drum machine.
  if (pad === HAT && openHat) openHat.gain.setTargetAtTime(0, t, 0.01);
  if (pad === OPEN_HAT) openHat = g;
  src.connect(g).connect(a.bus);
  src.start(t);
  if (keyRate === undefined) hits[pad] = t;
}

// ---------- the sequencer: a look-ahead scheduler, the LEDs follow what was scheduled ----------

let next = { step: 0, time: 0 };
const queue: { step: number; time: number }[] = [];
let shown = { step: -1, time: 0 };
let timer = 0;

function schedule() {
  const a = audio!;
  while (next.time < a.ctx.currentTime + 0.12) {
    // Swing delays every other 16th: 50% is straight, 66% a triplet feel.
    const at = next.time + (next.step % 2 ? ((mix.swing - 50) / 50) * stepDur() : 0);
    steps.forEach((s, pad) => s[next.step] && trigger(a, pad, at));
    queue.push({ step: next.step, time: at });
    next = { step: (next.step + 1) % 16, time: next.time + stepDur() };
  }
}

async function setPlaying(on: boolean) {
  if (on === playing) return;
  playing = on;
  playBtn.setAttribute("aria-pressed", String(on));
  if (on) {
    const a = await start();
    if (!playing) return;
    next = { step: 0, time: a.ctx.currentTime + 0.05 };
    queue.length = 0;
    schedule();
    timer = window.setInterval(schedule, 25);
  } else {
    clearInterval(timer);
    queue.length = 0;
    shown = { step: -1, time: 0 };
    setRecording(false);
  }
  wake();
}

function setRecording(on: boolean) {
  recording = on;
  recBtn.setAttribute("aria-pressed", String(on));
  if (on && !playing) void setPlaying(true);
  wake();
}

// ---------- the encoders ----------

interface Knob { name: string; min: number; max: number; step: number; get(): number; set(v: number): void; text(v: number): string }
const pct = (v: number) => `${Math.round(v)}%`;
const KNOBS: Knob[] = [
  { name: "Tempo", min: 60, max: 180, step: 1, get: () => mix.tempo, set: (v) => (mix.tempo = v), text: (v) => `${v}` },
  { name: "Swing", min: 50, max: 75, step: 1, get: () => mix.swing, set: (v) => (mix.swing = v), text: pct },
  { name: "Filter", min: 0, max: 100, step: 1, get: () => mix.filter, set: (v) => (mix.filter = v),
    text: (v) => (v >= 100 ? "Open" : filterHz() >= 1000 ? `${(filterHz() / 1000).toFixed(1)}k` : `${Math.round(filterHz())}`) },
  { name: "Echo", min: 0, max: 100, step: 1, get: () => mix.echo, set: (v) => (mix.echo = v), text: pct },
  { name: "Tune", min: -12, max: 12, step: 1, get: () => tune[selected], set: (v) => (tune[selected] = v), text: (v) => (v > 0 ? `+${v}` : `${v}`) },
  { name: "Decay", min: 5, max: 100, step: 1, get: () => decay[selected], set: (v) => (decay[selected] = v), text: pct },
  { name: "Level", min: 0, max: 100, step: 1, get: () => level[selected], set: (v) => (level[selected] = v), text: pct },
  { name: "Volume", min: 0, max: 100, step: 1, get: () => mix.volume, set: (v) => (mix.volume = v), text: pct },
];
const knobEls = [...root.querySelectorAll<HTMLElement>(".lk-encs [role=slider]")];
let turned = { knob: -1, until: 0 };

function showKnob(i: number) {
  const k = KNOBS[i], v = k.get(), el = knobEls[i];
  el.style.setProperty("--turn", String((v - k.min) / (k.max - k.min)));
  el.setAttribute("aria-valuemin", String(k.min));
  el.setAttribute("aria-valuemax", String(k.max));
  el.setAttribute("aria-valuenow", String(v));
  el.setAttribute("aria-valuetext", i >= 4 && i <= 6 ? `${k.text(v)}, ${NAMES[selected]}` : k.text(v));
}

function turn(i: number, to: number) {
  const k = KNOBS[i];
  const v = Math.min(k.max, Math.max(k.min, Math.round(to / k.step) * k.step));
  if (v !== k.get()) {
    k.set(v);
    applyMix();
    showKnob(i);
  }
  turned = { knob: i, until: performance.now() + 1400 };
  wake();
}

knobEls.forEach((el, i) => {
  showKnob(i);
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    const k = KNOBS[i], from = k.get(), x0 = e.clientX, y0 = e.clientY;
    const move = (m: PointerEvent) => turn(i, from + ((m.clientX - x0 + y0 - m.clientY) / 180) * (k.max - k.min));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    turn(i, from);
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    turn(i, KNOBS[i].get() - Math.sign(e.deltaY || -e.deltaX) * KNOBS[i].step);
  }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const k = KNOBS[i], big = (k.max - k.min) / 10;
    const by: Record<string, number> = { ArrowUp: k.step, ArrowRight: k.step, ArrowDown: -k.step, ArrowLeft: -k.step, PageUp: big, PageDown: -big };
    if (e.key === "Home" || e.key === "End") turn(i, e.key === "Home" ? k.min : k.max);
    else if (e.key in by) turn(i, k.get() + by[e.key]);
    else return;
    e.preventDefault();
  });
});

// ---------- pads, keys and buttons ----------

/** The pad under DOM slot `k` (top row first): pads 9-16 on top and 1-8 below, like the app; steps run 1-8, 9-16. */
const padAt = (k: number) => (k < 8 ? k + 8 : k - 8);

function select(pad: number) {
  selected = pad;
  knobEls.forEach((_, i) => i >= 4 && i <= 6 && showKnob(i));
}

/** Acts on pointerdown, for timing; keyboard presses arrive as clicks with no pointer (detail 0). */
function press(el: HTMLElement, act: () => void) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button === 0) act();
  });
  el.addEventListener("click", (e) => e.detail === 0 && act());
}

padEls.forEach((el, k) =>
  press(el, () => {
    if (mode === "steps") {
      steps[selected][k] = !steps[selected][k];
      // Stopped, a new step sounds once, so you hear what you're writing.
      if (steps[selected][k] && !playing) void start().then((a) => trigger(a, selected, a.ctx.currentTime));
      wake();
      return;
    }
    const pad = padAt(k);
    select(pad);
    void start().then((a) => {
      trigger(a, pad, a.ctx.currentTime);
      // Recording: the hit goes into the loop on the nearest 16th.
      if (recording && playing && shown.step >= 0) {
        const late = a.ctx.currentTime - shown.time > stepDur() / 2;
        steps[pad][(shown.step + (late ? 1 : 0)) % 16] = true;
      }
      wake();
    });
  }),
);

function playKey(i: number) {
  keyEls[i].classList.add("down");
  setTimeout(() => keyEls[i].classList.remove("down"), 160);
  // In Steps the lowest 16 keys pick the sound, as on the Launchkey; otherwise the keys play the Stab, C4 in the middle.
  if (mode === "steps" && i < 16) select(i);
  void start().then((a) => {
    if (mode === "steps" && i < 16) trigger(a, i, a.ctx.currentTime);
    else trigger(a, STAB, a.ctx.currentTime, 2 ** ((i - 12 + tune[STAB]) / 12));
    wake();
  });
}
keyEls.forEach((el, i) => el.addEventListener("pointerdown", (e) => e.button === 0 && playKey(i)));

press(playBtn, () => void setPlaying(!playing));
press(recBtn, () => setRecording(!recording));
modeBtns.forEach((el) =>
  press(el, () => {
    mode = el.dataset.mode as typeof mode;
    modeBtns.forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    say.textContent = mode === "steps" ? `The pads are the 16 steps of ${NAMES[selected]}` : "The pads play the kit";
    turned.until = 0;
    wake();
  }),
);

// Computer keys: A W S E D F T G Y H U J K play the top octave of the keys; space starts and stops.
const LETTERS = "awsedftgyhujk";
addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = LETTERS.indexOf(e.key.toLowerCase());
  if (n >= 0 && e.key.length === 1) playKey(12 + n);
  else if (e.key === " " && root.contains(document.activeElement) && !(document.activeElement instanceof HTMLButtonElement)) {
    e.preventDefault();
    void setPlaying(!playing);
  }
});

// ---------- drawing: the screen and the LEDs, each frame while something moves ----------

const booted = performance.now() - (reduced ? BOOT_MS : 0);
const g = canvas.getContext("2d")!;
let last: Uint8Array | null = null;

function frame(now: number): Frame {
  const boot = bootFrame(now - booted);
  if (boot) return boot;
  const status = `P1 ${recording ? "REC" : playing ? "PLAY" : "STOP"}`;
  if (now < turned.until) {
    return encoderScreen({
      title: "T1 Drums", status, tag: "PAD", info: `${selected + 1} ${NAMES[selected]}`, active: turned.knob,
      cells: KNOBS.map((k) => ({ name: k.name, value: k.text(k.get()), level: (k.get() - k.min) / (k.max - k.min) })),
    });
  }
  if (mode === "steps") {
    return stepScreen({
      track: "T1 Drums", status, item: `${selected + 1} ${NAMES[selected]}`, bar: "1", bars: 1,
      steps: steps[selected], playhead: playing ? shown.step : -1, pageTag: "STEP", pageInfo: `Swing ${mix.swing}%`,
    });
  }
  return padScreen({
    track: "T1 Drums", pad: selected, name: NAMES[selected], peaks: peaks?.[selected] ?? null, start: 0, end: 1,
    status, pageTag: "PLAY", pageInfo: `${mix.tempo} BPM`,
  });
}

function drawScreen(f: Frame) {
  if (last && f.px.every((v, i) => v === last![i])) return;
  last = f.px.slice();
  const p = canvas.width / W, dot = Math.max(1, Math.round(p * 0.78));
  g.fillStyle = SCREEN_BG;
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (const on of [0, 1]) {
    g.fillStyle = on ? DOT_ON : DOT_OFF;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (f.px[y * W + x] === on) g.fillRect(Math.round(x * p), Math.round(y * p), dot, dot);
  }
}

/** While the screen boots, a light runs across the pads, left to right. */
const sweep = (ms: number, col: number) => Math.abs(col - ((ms / 900) * 10 - 1)) < 0.8;

function drawPads(now: number) {
  const t = audio?.ctx.currentTime ?? -1;
  const boot = now - booted < BOOT_MS ? now - booted : -1;
  while (queue.length && queue[0].time <= t) shown = queue.shift()!;
  padEls.forEach((el, k) => {
    let c: string, s: string, label: string, pressed: string | null = null;
    if (boot >= 0) {
      c = COLORS[padAt(k)];
      s = sweep(boot, k % 8) ? "hit" : "off";
      label = `Pad ${padAt(k) + 1}, ${NAMES[padAt(k)]}`;
    } else if (mode === "steps") {
      const on = steps[selected][k];
      c = COLORS[selected];
      s = playing && shown.step === k ? "head" : on ? "on" : k % 4 === 0 ? "beat" : "off";
      label = `Step ${k + 1}`;
      pressed = String(on);
    } else {
      const pad = padAt(k);
      c = COLORS[pad];
      s = t >= hits[pad] && t < hits[pad] + 0.11 ? "hit" : pad === selected ? "sel" : "dim";
      label = `Pad ${pad + 1}, ${NAMES[pad]}`;
    }
    if (el.dataset.s !== s) el.dataset.s = s;
    if (el.style.getPropertyValue("--c") !== c) el.style.setProperty("--c", c);
    if (el.getAttribute("aria-label") !== label) el.setAttribute("aria-label", label);
    if (pressed === null) el.removeAttribute("aria-pressed");
    else if (el.getAttribute("aria-pressed") !== pressed) el.setAttribute("aria-pressed", pressed);
  });
}

function fit() {
  const p = Math.max(2, Math.floor((canvas.clientWidth * devicePixelRatio) / W));
  canvas.width = p * W;
  canvas.height = p * H;
  last = null;
  wake();
}
new ResizeObserver(fit).observe(canvas);

// Draws while the device is on screen and something can change: the boot, playback, a knob's pop-up, a lit pad.
let visible = true, raf = 0, idleFrames = 0;
function tick(now: number) {
  raf = 0;
  drawScreen(frame(now));
  drawPads(now);
  const busy = now - booted < BOOT_MS || playing || now < turned.until;
  idleFrames = busy ? 0 : idleFrames + 1;
  if (visible && idleFrames < 30) raf = requestAnimationFrame(tick);
}
function wake() {
  idleFrames = 0;
  if (!raf && visible) raf = requestAnimationFrame(tick);
}
new IntersectionObserver(([e]) => {
  visible = e.isIntersecting;
  wake();
}).observe(root);
kit.then(wake, () => {});
wake();
