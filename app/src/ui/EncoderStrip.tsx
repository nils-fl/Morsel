// The 8 encoders of the current page as small knobs: arc = value, name and formatted value beside it.
import { PAGES } from "../params";
import { set, useApp } from "../state/store";

const SWEEP = 135; // degrees either side of 12 o'clock

function arc(r: number, from: number, to: number) {
  const pt = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${12 + r * Math.cos(a)} ${12 + r * Math.sin(a)}`;
  };
  return `M ${pt(from)} A ${r} ${r} 0 ${Math.abs(to - from) > 180 ? 1 : 0} ${to > from ? 1 : 0} ${pt(to)}`;
}

function Knob({ value, range }: { value: number; range: [number, number] }) {
  const [lo, hi] = range;
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo || 1)));
  const deg = -SWEEP + t * 2 * SWEEP;
  // Bipolar ranges (pan, pitch) fill from the centre.
  const start = lo < 0 && hi > 0 ? 0 : -SWEEP;
  return (
    <svg className="knob" viewBox="0 0 24 24" aria-hidden>
      <path d={arc(10, -SWEEP, SWEEP)} className="knob-track" />
      {Math.abs(deg - start) > 0.5 && <path d={arc(10, Math.min(start, deg), Math.max(start, deg))} className="knob-fill" />}
      <line x1="12" y1="12" x2={12 + 7 * Math.sin((deg * Math.PI) / 180)} y2={12 - 7 * Math.cos((deg * Math.PI) / 180)} className="knob-pointer" />
    </svg>
  );
}

export function EncoderStrip() {
  useApp((s) => s); // values come from the store via the params, so redraw on any change
  const encPage = useApp((s) => s.encPage);
  const page = PAGES[encPage];
  return (
    <div className="enc-strip">
      <button className="enc-tag" onClick={() => set({ encPage: (encPage + 1) % PAGES.length })} title="Encoder page (click for next)">
        <b>ENC {encPage + 1}/{PAGES.length}</b><span>{page.name}</span>
      </button>
      <div className="enc-knobs">
        {Array.from({ length: 8 }, (_, i) => {
          const p = page.params[i];
          return (
            <div key={i} className={`enc-knob ${p ? "" : "empty"}`} title={p ? `Encoder ${i + 1}: ${p.name} = ${p.format()}` : `Encoder ${i + 1}: unused`}>
              {p ? <Knob value={p.value()} range={p.range ?? [0, 1]} /> : <svg className="knob" viewBox="0 0 24 24" aria-hidden><path d={arc(10, -SWEEP, SWEEP)} className="knob-track" /></svg>}
              <span className="enc-text">
                <span className="enc-name">{p?.name ?? "—"}</span>
                <span className="enc-val">{p ? p.format() : ""}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
