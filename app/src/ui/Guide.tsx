// Overview of the hardware mapping, modes and encoder pages. Shown as an overlay (Guide button, ?).
import { useEffect, useState } from "react";
import { PAGES } from "../params";
import { PAD_COLORS, drumPads, useApp } from "../state/store";
import { mute, paletteCss } from "./palette";

type ControlId = "strips" | "screen" | "shift" | "settings" | "play" | "record" | "octave" | "arpScale" | "padUp" | "padDown" | "encoders" | "pads" | "encUp" | "encDown" | "scene" | "func" | "keys";

const CONTROLS: Record<ControlId, { name: string; does: string; shift?: string }> = {
  strips: { name: "Pitch / Mod strips", does: "Pitch bends the Keys notes, held ones too, and springs back to the middle (±2 semitones; Preferences → Bend range). Mod adds vibrato to them and stays where you leave it. Live only: neither is recorded." },
  shift: { name: "Shift", does: "Hold for the second function of a button. With an encoder: fine steps. Shift + a pad is the Launchkey's own pad-mode shortcut (labels under the pads), so Morsel doesn't use it." },
  settings: { name: "Settings", does: "The Launchkey's own settings menu. Not used by Morsel." },
  octave: { name: "Oct − / Oct +", does: "Shift the keyboard by octaves (handled by the Launchkey). Step mode on a drum track picks pads from the lowest 16 keys at the default octave." },
  arpScale: { name: "Arp / Scale", does: "The Launchkey's own arpeggiator and scale mode. They work on the keys while Morsel plays them." },
  encUp: { name: "Encoder page ⌃", does: "Previous encoder page (the arrows next to the encoders) of the selected track. Lit when there is a page to go to. Browse: previous item.", shift: "Enter / leave Browse (drum tracks)" },
  encDown: { name: "Encoder page ⌄", does: "Next encoder page of the selected track (drum tracks: Kit, Pad, Pad 2, Track FX, Mix, Global, Sidechain, Duck; keys tracks: Keys, LFO, Track FX, Mix, Global, Duck; Step mode adds Step first). Browse: next item. Chop: nothing.", shift: "Enter / leave Chop (the selected pad's sample, or the open chop)" },
  screen: { name: "Screen", does: "The header names the selected track (T2 Keys 1) and, on the right, the pattern and transport (P1 PLAY, REC, COUNT, SAMPLE), on every mode screen. Below in Play: the selected pad's waveform (Pad pages), the preset or sample list (Keys page), the duck curve (Duck), or the page's encoders with their values (LFO, Track FX, Mix, Global, Sidechain). Otherwise: the 16-step grid (Step), the sample browser (Browse), the zoomed take with its slice markers (Chop), or the 16 pads as cells (Track, Mute, Pattern). The footer names the mode or encoder page with its values. Switching mode or track pops up where you landed. Turning an encoder pops up its value (on the 8-encoder screens the cell lights up instead); the filters show their curve. Holding Shift shows what Shift does with each button." },
  encoders: { name: "Encoders 1–8", does: "Edit the parameters of the current encoder page (see below). Browse and Chop use them their own way (see Pad modes).", shift: "Fine steps. Keys page encoder 1: jump to the next preset folder (Bass, Lead, Keys…)" },
  play: { name: "Play", does: "Start / stop. Chop: play the take from the selected marker / stop.", shift: "Metronome on / off. Chop: start / stop the sequencer" },
  record: { name: "Record", does: "Stopped: 1-bar count-in, then overdub. During the count-in: call it off. Playing: recording on / off.", shift: "Sample (audio input, master or a shared browser tab); press again to stop. The take opens in Chop with its hits marked, or goes on the selected pad (Track tab → Sample)." },
  padUp: { name: "Pad ⌃", does: "The arrow left of the top pad row. Previous pattern. Step mode: previous bar. Browse: up a folder. Chop: previous marker.", shift: "Previous track (the device's “< Track”)" },
  padDown: { name: "Pad ⌄", does: "The arrow left of the bottom pad row. Next pattern. Step mode: next bar. Browse: open folder / load onto the pad. Chop: next marker.", shift: "Next track (the device's “Track >”)" },
  pads: { name: "Pads", does: "Depends on the mode (see Modes). In Play they play the selected track: its drum pads, or on a keys track the notes C3–D#4. Pressure (aftertouch) opens the pad's filters on note-repeat hits." },
  scene: { name: "Scene ›", does: "The › button right of the top pad row. Hold while playing drum pads: note repeat at the tempo, playing or stopped; pad pressure sets the repeats' velocity. Press it twice quickly to latch repeat on (held pads repeat without Scene) and once more to stop. Pattern mode: hold + pad adds that pattern to the song. Browse: up a folder (with or without Shift). Chop: add a marker at the playhead (Shift: remove the selected one).", shift: "Clear the selected track's clip in this pattern (Step mode on a drum track: the selected pad's notes)" },
  func: { name: "Func", does: "The button right of the bottom pad row. Cycle pad modes: Play → Step → Track → Mute → Pattern (the screen shows which of the 5 you're on; from Play it switches when you let go). Play, while playing: hold it and hold pads or keys to erase their notes as the playhead passes, like the MPC's Erase (one Undo brings them back). Browse: open folder / load onto the pad (Shift: put the whole folder on the pads). Chop: send the slices to a new drum rack.", shift: "Undo (the screen says how many steps are left). Each recorded take is one step; Cmd/Ctrl+Z on the computer does the same" },
  keys: { name: "Keys", does: "Play the keys track (the last keys track you selected), recorded into its clip. Step mode on a drum track: pick the pad (lowest 16 keys = pads 1–16); on a keys track: the note the step pads write. The Launchkey's Arp and Scale still work." },
};

// Controls the Launchkey handles itself (drawn faded).
const NATIVE: ControlId[] = ["settings", "octave", "arpScale"];

const SHORTCUTS: [string, string][] = [
  ["Shift + Play", "Metronome (Chop: start / stop the sequencer)"],
  ["Shift + Record", "Sample (input, master or shared tab) → Chop"],
  ["Shift + Func", "Undo (Browse, on a folder: its samples → pads 1–16)"],
  ["Shift + Scene", "Clear selected track's clip"],
  ["Shift + Pad ⌃", "Previous track"],
  ["Shift + Pad ⌄", "Next track"],
  ["Shift + Enc page ⌃", "Browse on / off"],
  ["Shift + Enc page ⌄", "Chop on / off"],
  ["Func", "Chop: slices → new drum rack"],
  ["Shift + Encoder", "Fine steps"],
  ["Sidechain page: pad + enc 1", "Make the pad a sidechain input"],
  ["Duck page (drums): pad + enc 7", "Does the pad duck?"],
  ["Hold Scene + pads", "Note repeat (Play); press harder for louder repeats"],
  ["Scene × 2", "Latch note repeat: held pads repeat without Scene (press Scene again to stop)"],
  ["Hold Func + pads", "Erase those pads' notes as the playhead passes (Play, while playing; keys too)"],
  ["Hold Scene + pad", "Add pattern to song (Pattern)"],
  ["Hold pad + tap pad", "Copy pattern (Pattern)"],
  ["Hold Scene + pad + tap pad", "Copy only the selected track's clip (Pattern)"],
  ["Double-tap pad", "Solo (Mute, Track bottom row)"],
  ["Space", "Computer: play / stop (Chop tab: play the region)"],
  ["R", "Computer: record"],
  ["B", "Computer: show / hide the library"],
  ["[ / ]", "Computer: previous / next pattern"],
  ["⌘ + Z", "Computer: undo (⇧⌘Z or Ctrl+Y: redo)"],
];

const OFF = "#2a2f35", DIM = "#4a525a", WHITE = "#e6e9ec", GREEN = mute("#2fe05a"), BLUE = mute("#3b5bff"), RED = mute("#6b1a1a"), YELLOW = mute("#ffe83b"), CYAN = mute("#3be7ff");
type Led = { c: string; blink?: boolean };

// Example LED states per mode, pad index 0-15 (0-7 = bottom row).
const stepLeds = (): Led[] => Array.from({ length: 16 }, (_, i) => {
  const step = i >= 8 ? i - 8 : i + 8; // top row = steps 1-8
  if (step === 6) return { c: WHITE };
  return { c: [0, 4, 8, 10, 12].includes(step) ? CYAN : step % 4 === 0 ? DIM : OFF };
});
const trackLeds = (): Led[] => Array.from({ length: 16 }, (_, i) => {
  const cols = [mute("#ff3b3b"), mute("#8a3bff"), mute("#ff8a1f"), mute("#3be7ff")];
  if (i >= 8) return i - 8 < 4 ? { c: cols[i - 8], blink: i === 9 } : { c: OFF };
  return i < 4 ? { c: i === 2 ? RED : GREEN } : { c: OFF };
});
const muteLeds = (): Led[] => Array.from({ length: 16 }, (_, i) => ({ c: i === 2 ? RED : i === 4 ? YELLOW : i < 12 ? GREEN : mute("#1a5c2a") }));
const patternLeds = (): Led[] => Array.from({ length: 16 }, (_, i) => (i === 0 ? { c: GREEN } : i === 2 ? { c: GREEN, blink: true } : { c: i < 4 ? BLUE : OFF }));

function MiniPads({ leds }: { leds: Led[] }) {
  return (
    <div className="g-minipads">
      {[8, 0].map((row) => (
        <div key={row}>
          {Array.from({ length: 8 }, (_, k) => {
            const l = leds[row + k];
            return <i key={k} className={l.blink ? "blink" : ""} style={{ "--led": l.c } as React.CSSProperties} />;
          })}
        </div>
      ))}
    </div>
  );
}

const CONTROL_IDS = Object.keys(CONTROLS) as ControlId[];

export function Guide() {
  const pads = useApp(drumPads);
  const selected = useApp((s) => s.selectedPad);
  const [focus, setFocus] = useState<ControlId>("func");
  // cls = the element's own classes; buttons use the g-ctl look, the areas (encoders, pads, keys) their own.
  const ctl = (id: ControlId, cls = "g-ctl") => ({
    className: `${cls} ${focus === id ? "on" : ""} ${NATIVE.includes(id) ? "native" : ""}`,
    onMouseEnter: () => setFocus(id),
    onFocus: () => setFocus(id),
    onClick: () => setFocus(id),
    "aria-label": CONTROLS[id].name,
  });

  const playLeds: Led[] = pads.map((p, i) => ({ c: p.sampleId ? paletteCss(p.color) : OFF, blink: i === selected }));
  const chopLeds: Led[] = pads.map((_, i) => (i < 12 ? { c: paletteCss(PAD_COLORS[i]), blink: i === 3 } : { c: OFF }));
  const browseLeds: Led[] = pads.map((p, i) => (i === selected ? { c: WHITE, blink: true } : { c: p.sampleId ? `color-mix(in srgb, ${paletteCss(p.color)} 35%, ${OFF})` : OFF }));

  const modes = [
    { name: "Play", color: "var(--amber)", leds: playLeds, how: "Start mode", pads: "Drum track: play samples, velocity-sensitive; the last pad hit is selected (pulsing). Keys track: notes C3–D#4 (Cs lit white).", enc: "Drum track: Kit, Pad, Pad 2, Track FX, Mix, Global, Sidechain, Duck. Keys track: Keys, LFO, Track FX, Mix, Global, Duck", keys: "Keys track" },
    { name: "Step", color: "var(--cyan)", leds: stepLeds(), how: "Func ×1", pads: "16 steps of the selected track (drum track: the selected pad): top row 1–8, bottom row 9–16. White = playhead, dim = beats. Hold a step: Enc 1 = velocity, Enc 2 = nudge; a lit step goes on release unless you turned one.", enc: "Step page: 1 track length (1–4 bars), 2 bar on the pads, 3 swing, 4 quantize; arrows reach the other pages", keys: "Drum track: pick the pad. Keys track: pick the note" },
    { name: "Track", color: "var(--yellow)", leds: trackLeds(), how: "Func ×2", pads: "Top row = select track 1–8 (pulsing = selected). Bottom row = mute track 1–8 (red), double-tap = solo.", enc: "Same pages (Mix: 8 track levels)", keys: "Keys track" },
    { name: "Mute", color: "var(--lime)", leds: muteLeds(), how: "Func ×3", pads: "Pads of the drum track (the last one picked, also from a keys track). Tap = mute (red), double-tap = solo (yellow).", enc: "Same pages", keys: "Keys track" },
    { name: "Pattern", color: "var(--violet)", leds: patternLeds(), how: "Func ×4", pads: "Pick a pattern (green). Blue = has notes. While playing the switch is queued (flashing) until the loop ends.", enc: "Same pages", keys: "Keys track" },
    { name: "Browse", color: "var(--white)", leds: browseLeds, how: "Shift + Enc page ⌃", pads: "Target a pad (flashes white) and audition it. Pad ⌄ / Func = open or load (Kits lists the built-in kits first; connected folders are listed at the top), Shift + Func on a folder = its samples on pads 1–16, Pad ⌃ / › = up a folder.", enc: "1 or 8 = scroll (auto-preview), 2 or 7 = jump by letter (Shift: by 8). ⌃ / ⌄ arrows = one item", keys: "Keys track" },
    { name: "Chop", color: "var(--magenta)", leds: chopLeds, how: "After a take, or Shift + Enc page ⌄", pads: "Play slices 1–16 and select their markers. Pad ⌃ / ⌄ = previous / next marker. Play = play from the marker, › = add a marker at the playhead (Shift: remove), Func = new drum rack.", enc: "1 scroll, 2 zoom, 3 pick marker, 4 move it (Shift: fine), 5 max slices, 6 sensitivity", keys: "Keys track" },
  ];

  return (
    <div className="guide">
      <section className="g-block">
        <h3><b>01</b> Controls</h3>
        <p className="hint">Hover or tap a control. Faded controls are handled by the Launchkey itself.</p>
        <div className="g-device-wrap">
          <div className="g-device">
            <div {...ctl("strips", "g-strips")} role="button" tabIndex={0}>
              <div><i /><span>Pitch</span></div>
              <div><i /><span>Mod</span></div>
            </div>
            <button {...ctl("screen", "g-screen")}><span>MORSEL</span><span>P1 PLAY</span></button>
            <div className="g-btns">
              <button {...ctl("shift")}>Shift</button>
              <button {...ctl("settings")}>Settings</button>
              <button {...ctl("play", "g-ctl g-play")}>▶</button>
              <button {...ctl("record", "g-ctl g-rec")}>●</button>
              <button {...ctl("octave")}>Oct −</button>
              <button {...ctl("octave")}>Oct +</button>
            </div>
            <div className="g-col g-arp">
              <button {...ctl("arpScale")}>Arp</button>
              <button {...ctl("arpScale")}>Scale</button>
            </div>
            <div className="g-col g-padarrows">
              <button {...ctl("padUp")}>⌃</button>
              <button {...ctl("padDown")}>⌄</button>
            </div>
            <div {...ctl("encoders", "g-encs")} role="button" tabIndex={0}>
              {Array.from({ length: 8 }, (_, i) => <i key={i}><em>{i + 1}</em></i>)}
            </div>
            <div {...ctl("pads", "g-pads")} role="button" tabIndex={0}>
              {[8, 0].map((row) => (
                <div key={row}>
                  {Array.from({ length: 8 }, (_, k) => {
                    const p = pads[row + k];
                    return <i key={k} style={{ "--led": p.sampleId ? paletteCss(p.color) : OFF } as React.CSSProperties}><em>{row + k + 1}</em></i>;
                  })}
                </div>
              ))}
            </div>
            <div className="g-col g-encarrows">
              <button {...ctl("encUp")}>⌃</button>
              <button {...ctl("encDown")}>⌄</button>
            </div>
            <div className="g-col g-scenefunc">
              <button {...ctl("scene")}>›</button>
              <button {...ctl("func")}>Func</button>
            </div>
            <span className="g-logo">LAUNCH<b>KEY</b></span>
            <div {...ctl("keys", "g-keys")} role="button" tabIndex={0}>
              {Array.from({ length: 25 }, (_, i) => {
                const black = [1, 3, 6, 8, 10].includes(i % 12);
                return <i key={i} className={black ? "b" : "w"} />;
              })}
            </div>
          </div>
          {/* Every control's text in one cell, only the current one showing: the box is as tall as the longest one, so
              hovering the controls never moves the page. */}
          <aside className="g-info">
            {CONTROL_IDS.map((id) => {
              const c = CONTROLS[id];
              return (
                <div key={id} className={`g-info-item ${id === focus ? "on" : ""}`} aria-hidden={id !== focus} aria-live={id === focus ? "polite" : undefined}>
                  <div className="g-info-tag">{c.name}</div>
                  <p>{c.does}</p>
                  {c.shift && (
                    <p className="g-shift"><b>Shift</b> {c.shift}</p>
                  )}
                </div>
              );
            })}
          </aside>
        </div>
      </section>

      <section className="g-block">
        <h3><b>02</b> Pad modes</h3>
        <p className="hint">Func cycles Play → Step → Track → Mute → Pattern. Browse and Chop sit outside the cycle.</p>
        <div className="g-modes">
          {modes.map((m) => (
            <article key={m.name} className="g-mode" style={{ "--mode": m.color } as React.CSSProperties}>
              <header><span>{m.name}</span><small>{m.how}</small></header>
              <MiniPads leds={m.leds} />
              <dl>
                <dt>Pads</dt><dd>{m.pads}</dd>
                <dt>Encoders</dt><dd>{m.enc}</dd>
                <dt>Keys</dt><dd>{m.keys}</dd>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <div className="g-split">
        <section className="g-block">
          <h3><b>03</b> Encoder pages</h3>
          <p className="hint">Switch with the ⌃ / ⌄ arrows right of the encoders. Drum tracks show Kit (encoder 1 scrolls the kits, like the Keys presets), Pad, Pad 2 and Sidechain; keys tracks show Keys (its encoders follow the sound source: synth, Sample or Pad sample) and LFO. Track FX, Mix, Global and Duck are on both; on a drum track the Duck page's encoder 7 switches whether the selected pad ducks. Hold Shift for fine steps.</p>
          {PAGES.map((pg, n) => (
            <div key={pg.name} className="g-page">
              <div className="g-page-tag"><b>{pg.tag}</b><span>{pg.stepOnly ? "Step mode" : `${n + 1}/${PAGES.filter((x) => !x.stepOnly).length}`}</span></div>
              <div className="g-page-params">
                {Array.from({ length: 8 }, (_, i) => {
                  const p = pg.params[i];
                  return <span key={i} className={p ? "" : "empty"}><em>{i + 1}</em>{p?.name ?? "—"}</span>;
                })}
              </div>
            </div>
          ))}
        </section>

        <section className="g-block">
          <h3><b>04</b> Shortcuts</h3>
          <ul className="g-shortcuts">
            {SHORTCUTS.map(([keys, what]) => (
              <li key={keys}>
                <span>{keys.split(" + ").map((k, i) => <kbd key={i}>{k}</kbd>).reduce<React.ReactNode[]>((a, k, i) => (i ? [...a, <i key={`p${i}`}>+</i>, k] : [k]), [])}</span>
                <span>{what}</span>
              </li>
            ))}
          </ul>
          <h3 className="g-sub"><b>05</b> Good to know</h3>
          <ul className="g-notes">
            <li>Everything follows the selected track: Shift + Pad ⌃ / ⌄ steps through them, and the Track tab, the on-screen pads, the encoder pages and the Launchkey screen show only that track.</li>
            <li>Close Ableton Live first: Morsel puts the Launchkey in DAW mode and takes over its pads, encoders, buttons and screen.</li>
            <li>Everything autosaves in this browser. Song tab → Export project to keep a copy with all samples, New project to start over.</li>
            <li>Samples come from connected folders (Connect folder, Chrome / Edge): browsed in place from Sample ▾ or Browse on the Launchkey, and a sample is copied into the browser only when you use it. Folder → pads in Sample ▾ makes the open folder the kit. After a browser restart, click Reconnect next to the folder in Sample ▾.</li>
            <li>Dropping an audio file on an on-screen pad loads just that file.</li>
            <li>New drum tracks start with the Factory kit. Built-in genre kits (Lo-Fi, Boom Bap, Hip Hop, Trap, Drill, House, Techno, DnB, Electro) are synthesized like it. The Kit panel (Track tab), the Kit encoder page or Browse → Kits loads a kit; the Kits panel saves, renames, exports, imports (several at once) and deletes them.</li>
            <li>Keys tracks: Synth, Sample (one sound with a root note), Pad sample or Multisample, plus a vibrato and a filter LFO (encoder page LFO).</li>
            <li>Record → chop → drum rack: Shift + Record, play, Shift + Record, then Func. The take opens in Chop with its hits marked; adjust with pads, encoders and ›.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/** Full-screen overlay around the guide. Esc or the backdrop closes it. */
export function GuideOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="g-overlay" onClick={onClose}>
      <div className="g-panel" role="dialog" aria-modal="true" aria-label="Guide" onClick={(e) => e.stopPropagation()}>
        <header className="g-head">
          <strong>MORSEL</strong>
          <span>Guide · Launchkey Mini MK4</span>
          <button onClick={onClose}>Esc ✕</button>
        </header>
        <Guide />
      </div>
    </div>
  );
}
