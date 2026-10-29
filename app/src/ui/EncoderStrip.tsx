// The 8 encoders of the current page as small knobs: arc = value, name and formatted value beside it. They turn like
// the Launchkey's: drag up or down, scroll, or the arrow keys, Shift for fine steps. In Chop mode they are the Chop or
// Chop page's encoders, as on the Launchkey. On the FX page, an effect's name drags it to another slot, changing the
// chain's order.
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { chopPageInfo, chopParams, chopSetPage } from "../modes/chop";
import { turnPageEncoder } from "../modes/controller";
import { FX_PAGE_INDEX, PAGES, pagesFor, type Param } from "../params";
import { selectedTrack, set, useApp } from "../state/store";
import { fxDragSource, fxDropTarget } from "./fxDrag";

const SWEEP = 135; // degrees either side of 12 o'clock
/** Pixels of drag, and of scroll, per encoder detent. */
const DRAG_PX = 6;
const WHEEL_PX = 40;

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

/** One detent (or a whole step, for a key press) of encoder `index`: delta's sign is the direction. */
type Turn = (index: number, delta: number, fine: boolean, whole?: boolean) => void;

export function EncoderStrip() {
  useApp((s) => s); // values come from the store via the params, so redraw on any change
  const chopPage = useApp((s) => (s.hwMode === "chop" && s.chop ? s.chop.page : null));
  if (chopPage) {
    // The Launchkey's encoders scroll, zoom and move markers in Chop: show (and turn) those.
    const params = chopParams();
    const turnChop: Turn = (i, d, fine) => params[i]?.nudge(d, fine);
    return (
      <div className="enc-strip">
        <button
          className="enc-tag" onClick={() => chopSetPage(chopPage === "sample" ? "chop" : "sample")}
          title="Chop's encoder pages: Sample (start, end, keep, tempo) and Chop (steps, markers, chops). Click for the other one (Launchkey: Encoder page ⌃ / ⌄)"
        >
          <b>CHOP {chopPage === "sample" ? 1 : 2}/2</b><span>{chopPageInfo()}</span>
        </button>
        <div className="enc-knobs">
          {Array.from({ length: 8 }, (_, i) => <EncoderCell key={i} index={i} p={params[i]} turn={turnChop} />)}
        </div>
      </div>
    );
  }
  return <PageStrip />;
}

function PageStrip() {
  const encPage = useApp((s) => s.encPage);
  // Only the pages of the selected track's kind (no Pad pages on a keys track, no Keys page on a drum track).
  const track = useApp(selectedTrack);
  const pages = pagesFor(track.kind);
  const at = Math.max(0, pages.indexOf(encPage));
  const page = PAGES[pages[at]];
  const rack = pages[at] === FX_PAGE_INDEX;
  const [over, setOver] = useState<number | null>(null);
  return (
    <div className="enc-strip">
      <button className="enc-tag" onClick={() => set({ encPage: pages[(at + 1) % pages.length] })} title="Encoder page (click for next)">
        <b>ENC {at + 1}/{pages.length}</b><span>{page.name}</span>
      </button>
      <div className="enc-knobs">
        {Array.from({ length: 8 }, (_, i) => (
          <EncoderCell key={i} index={i} p={page.params[i]} turn={(j, d, fine, whole) => turnPageEncoder(pages[at], j, d, fine, whole)}
            drop={rack ? { ...fxDropTarget(track.id, i, setOver), className: over === i ? "drop" : "" } : undefined}
            grab={rack ? fxDragSource(track.id, i) : undefined} />
        ))}
      </div>
    </div>
  );
}

/**
 * One encoder: turned as on the Launchkey, so the screen shows the value too. `grab`: its name can be dragged (the FX
 * page's effects); `drop`: something can be dropped on it.
 */
function EncoderCell({ index, p, turn: turnOne, grab, drop }: {
  index: number; p: Param | undefined; turn: Turn; grab?: HTMLAttributes<HTMLSpanElement>; drop?: HTMLAttributes<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null); // the pointer's y at the last detent
  const [turning, setTurning] = useState(false);
  // The wheel listener stays bound across renders; it turns through the latest callback.
  const turnRef = useRef(turnOne);
  useEffect(() => {
    turnRef.current = turnOne;
  });
  // Detent by detent, like the hardware, so list params (presets, kits) step one entry each.
  const turn = (detents: number, fine: boolean, whole = false) => {
    for (let k = 0; k < Math.abs(detents); k++) turnRef.current(index, Math.sign(detents), fine, whole);
  };
  const live = !!p;
  useEffect(() => {
    // Not a React onWheel: that one is passive, and the page would scroll too.
    const el = ref.current;
    if (!el || !live) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Up is more. Shift + wheel arrives as a sideways scroll on a Mac.
      acc -= (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
      const d = Math.trunc(acc / WHEEL_PX);
      acc -= d * WHEEL_PX;
      for (let k = 0; k < Math.abs(d); k++) turnRef.current(index, Math.sign(d), e.shiftKey);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [index, live]);
  if (!p) {
    return (
      <div className="enc-knob empty" title={`Encoder ${index + 1}: unused`}>
        <svg className="knob" viewBox="0 0 24 24" aria-hidden><path d={arc(10, -SWEEP, SWEEP)} className="knob-track" /></svg>
        <span className="enc-text"><span className="enc-name">—</span><span className="enc-val" /></span>
      </div>
    );
  }
  const [lo, hi] = p.range ?? [0, 1];
  const end = () => {
    drag.current = null;
    setTurning(false);
  };
  return (
    <div
      ref={ref}
      {...drop}
      className={`enc-knob ${turning ? "turning" : ""} ${drop?.className ?? ""}`}
      title={`Encoder ${index + 1}: ${p.name} = ${p.format()} (drag, scroll or arrow keys; Shift for fine)`}
      role="slider" tabIndex={0} aria-label={`Encoder ${index + 1}: ${p.name}`}
      aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={p.value()} aria-valuetext={p.format()}
      onPointerDown={(e) => {
        // The name of a draggable effect: a drag to move it, not a turn.
        if (e.button !== 0 || (grab && (e.target as HTMLElement).closest(".enc-name"))) return;
        e.preventDefault(); // no text selection while dragging
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = e.clientY;
        setTurning(true);
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        const d = Math.trunc((drag.current - e.clientY) / DRAG_PX);
        if (!d) return;
        drag.current -= d * DRAG_PX;
        turn(d, e.shiftKey);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (!d || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        turn(d, e.shiftKey, true); // a key press is a whole step, even on a param that takes a few detents a step
      }}
    >
      <Knob value={p.value()} range={[lo, hi]} />
      <span className="enc-text">
        <span className="enc-name" {...grab} title={grab ? `Drag ${p.name} onto another encoder to move it in the chain` : undefined}>{p.name}</span>
        <span className="enc-val">{p.format()}</span>
      </span>
    </div>
  );
}
