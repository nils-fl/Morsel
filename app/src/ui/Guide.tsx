// Overview of the hardware mapping, modes and encoder pages. Shown in the Help tab and as an overlay.
import { useEffect, useState } from "react";
import { PAGES } from "../params";
import { useApp } from "../state/store";
import { mute, paletteCss } from "./palette";

type ControlId = "strips" | "screen" | "shift" | "settings" | "play" | "record" | "octave" | "arpScale" | "padUp" | "padDown" | "encoders" | "pads" | "encUp" | "encDown" | "scene" | "func" | "keys";

const CONTROLS: Record<ControlId, { name: string; does: string; shift?: string }> = {
  strips: { name: "Pitch / Mod strips", does: "Handled by the Launchkey itself; LaunchKit doesn't use them yet." },
  shift: { name: "Shift", does: "Hold for the second function of a button. With an encoder: fine steps. Shift + a pad is the Launchkey's own pad-mode shortcut (labels under the pads), so LaunchKit doesn't use it." },
  settings: { name: "Settings", does: "The Launchkey's own settings menu. Not used by LaunchKit." },
  octave: { name: "Oct − / Oct +", does: "Shift the keyboard by octaves (handled by the Launchkey). Step mode picks tracks from the lowest 16 keys at the default octave." },
  arpScale: { name: "Arp / Scale", does: "The Launchkey's own arpeggiator and scale mode. They work on the keys while LaunchKit plays them." },
  encUp: { name: "Encoder page ⌃", does: "Previous encoder page (the arrows next to the encoders). Lit when there is a page to go to. Browse: previous item." },
  encDown: { name: "Encoder page ⌄", does: "Next encoder page (Pad → Pad 2 → Global). Browse: next item." },
  screen: { name: "Screen", does: "Selected pad's waveform (Play), the 16-step grid (Step) or the sample browser (Browse). Turning an encoder pops up its value; the filters show their curve." },
  encoders: { name: "Encoders 1–8", does: "Edit the parameters of the current encoder page (see below).", shift: "Fine steps" },
  play: { name: "Play", does: "Start / stop.", shift: "Metronome on / off" },
  record: { name: "Record", does: "Stopped: 1-bar count-in, then overdub. Playing: recording on / off.", shift: "Sample the audio input onto the selected pad (press again to stop). Browser tab: share the tab once on screen, then this starts and stops takes." },
  padUp: { name: "Pad ⌃", does: "The arrow left of the top pad row. Previous pattern. Step mode: previous bar. Browse: up a folder.", shift: "Enter / leave Browse" },
  padDown: { name: "Pad ⌄", does: "The arrow left of the bottom pad row. Next pattern. Step mode: next bar. Browse: open folder / load onto the pad." },
  pads: { name: "Pads", does: "Depends on the mode (see Modes). Pressure opens the pad's filters." },
  scene: { name: "Scene ›", does: "The › button right of the top pad row. Hold while playing pads: note repeat. Pattern mode: hold + pad adds that pattern to the song. Browse: up a folder.", shift: "Clear the selected track in this pattern" },
  func: { name: "Func", does: "The button right of the bottom pad row. Cycle pad modes: Play → Step → Mixer → Pattern. Browse: open folder / load onto the pad.", shift: "Undo" },
  keys: { name: "Keys", does: "Play the Keys instrument, recorded into the Keys track. Step mode: pick the track (lowest 16 keys = pads 1–16). The Launchkey's Arp and Scale still work." },
};

// Controls the Launchkey handles itself (drawn faded).
const NATIVE: ControlId[] = ["strips", "settings", "octave", "arpScale"];

const SHORTCUTS: [string, string][] = [
  ["Shift + Play", "Metronome"],
  ["Shift + Record", "Sample (input, master or shared tab) → selected pad"],
  ["Shift + Func", "Undo"],
  ["Shift + Scene", "Clear selected track"],
  ["Shift + Pad ⌃", "Browse on / off"],
  ["Shift + Encoder", "Fine steps"],
  ["Pad on Duck page", "Make it the sidechain input"],
  ["Hold Scene + pads", "Note repeat (Play)"],
  ["Hold Scene + pad", "Add pattern to song (Pattern)"],
  ["Double-tap pad", "Solo (Mixer)"],
];

const OFF = "#2a2f35", DIM = "#4a525a", WHITE = "#e6e9ec", GREEN = mute("#2fe05a"), BLUE = mute("#3b5bff"), RED = mute("#6b1a1a"), YELLOW = mute("#ffe83b"), CYAN = mute("#3be7ff");
type Led = { c: string; blink?: boolean };

// Example LED states per mode, pad index 0-15 (0-7 = bottom row).
const stepLeds = (): Led[] => Array.from({ length: 16 }, (_, i) => {
  const step = i >= 8 ? i - 8 : i + 8; // top row = steps 1-8
  if (step === 6) return { c: WHITE };
  return { c: [0, 4, 8, 10, 12].includes(step) ? CYAN : step % 4 === 0 ? DIM : OFF };
});
const mixerLeds = (): Led[] => Array.from({ length: 16 }, (_, i) => ({ c: i === 2 ? RED : i === 4 ? YELLOW : i < 12 ? GREEN : mute("#1a5c2a") }));
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

export function Guide() {
  const pads = useApp((s) => s.project.pads);
  const selected = useApp((s) => s.selectedPad);
  const [focus, setFocus] = useState<ControlId>("func");
  const c = CONTROLS[focus];
  // cls = the element's own classes; buttons use the g-ctl look, the areas (encoders, pads, keys) their own.
  const ctl = (id: ControlId, cls = "g-ctl") => ({
    className: `${cls} ${focus === id ? "on" : ""} ${NATIVE.includes(id) ? "native" : ""}`,
    onMouseEnter: () => setFocus(id),
    onFocus: () => setFocus(id),
    onClick: () => setFocus(id),
    "aria-label": CONTROLS[id].name,
  });

  const playLeds: Led[] = pads.map((p, i) => ({ c: p.sampleId ? paletteCss(p.color) : OFF, blink: i === selected }));
  const browseLeds: Led[] = pads.map((p, i) => (i === selected ? { c: WHITE, blink: true } : { c: p.sampleId ? `color-mix(in srgb, ${paletteCss(p.color)} 35%, ${OFF})` : OFF }));

  const modes = [
    { name: "Play", color: "var(--amber)", leds: playLeds, how: "Start mode", pads: "Play samples, velocity-sensitive. The last pad hit is selected (pulsing).", enc: "Pad / Pad 2 / Global pages", keys: "Keys instrument" },
    { name: "Step", color: "var(--cyan)", leds: stepLeds(), how: "Func ×1", pads: "16 steps of the selected track: top row 1–8, bottom row 9–16. White = playhead, dim = beats.", enc: "Same pages", keys: "Pick the track (and hear it)" },
    { name: "Mixer", color: "var(--lime)", leds: mixerLeds(), how: "Func ×2", pads: "Tap = mute (red), double-tap = solo (yellow).", enc: "Same pages", keys: "Keys instrument" },
    { name: "Pattern", color: "var(--violet)", leds: patternLeds(), how: "Func ×3", pads: "Pick a pattern (green). Blue = has notes. While playing the switch is queued (flashing) until the loop ends.", enc: "Same pages", keys: "Keys instrument" },
    { name: "Browse", color: "var(--white)", leds: browseLeds, how: "Shift + Pad ⌃", pads: "Target a pad (flashes white) and audition it. Pad ⌄ / Func = open or load, Pad ⌃ / › = up a folder.", enc: "1 or 8 = scroll (auto-preview), 2 or 7 = jump by letter (Shift: by 8). ⌃ / ⌄ arrows = one item", keys: "Keys instrument" },
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
            <button {...ctl("screen", "g-screen")}><span>LAUNCHKIT</span><span>P1 PLAY</span></button>
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
          <aside className="g-info" aria-live="polite">
            <div className="g-info-tag">{c.name}</div>
            <p>{c.does}</p>
            {c.shift && (
              <p className="g-shift"><b>Shift</b> {c.shift}</p>
            )}
          </aside>
        </div>
      </section>

      <section className="g-block">
        <h3><b>02</b> Pad modes</h3>
        <p className="hint">Func cycles Play → Step → Mixer → Pattern. Browse sits outside the cycle.</p>
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
          <p className="hint">Switch with the ⌃ / ⌄ arrows right of the encoders. Hold Shift for fine steps.</p>
          {PAGES.map((pg, n) => (
            <div key={pg.name} className="g-page">
              <div className="g-page-tag"><b>{pg.tag}</b><span>{n + 1}/{PAGES.length}</span></div>
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
            <li>Close Ableton Live first: LaunchKit puts the Launchkey in DAW mode and takes over its pads, encoders, buttons and screen.</li>
            <li>Everything autosaves in this browser. Song tab → Export project to keep a copy with all samples.</li>
            <li>Drop audio files on an on-screen pad to load them. Import folder adds a whole folder to the browser.</li>
            <li>Kits panel: save the 16 pads as a kit, or Import kit… from a kit file.</li>
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
          <strong>LAUNCHKIT</strong>
          <span>Guide · Launchkey Mini MK4</span>
          <button onClick={onClose}>Esc ✕</button>
        </header>
        <Guide />
      </div>
    </div>
  );
}
