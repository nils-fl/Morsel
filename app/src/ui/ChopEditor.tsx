// Chop editor: place slice markers on a long recording, audition them, put the chops on pads, stretch the region.
// The session (markers, view, selection) lives in the store so the Launchkey can drive it too (modes/chop.ts).
import { useEffect, useRef, useState } from "react";
import { chopOriginal, confirmDeleteSample, cropSample, finishChop, openInChop, sendChopToNewTrack, slicesToPads, stretchChop } from "../actions";
import { MAX_CHOPS, addMarker, beatsLabel, clampView, moveMarker, removeMarker, slicesFromMarkers, zeroCrossing } from "../audio/chop";
import { engine } from "../audio/engine";
import {
  CHOP_KEY0, assignChop, autoChop, bpmText, chopLooping, chopPadOf, chopPlay, chopPlayhead, chopPlaying, chopPlaySlice, chopRack, chopStop, chopTempo,
  chopToggleLoop, minSpan, newChop, updateChop,
} from "../modes/chop";
import { enterChopHw } from "../modes/controller";
import { canAddTrack, drumPads, drumTrack, get, set, useApp } from "../state/store";
import { DEFAULT_SLICE, PAD_COUNT, type ChopSession } from "../state/types";
import { noteName } from "./notes";
import { Field, Section } from "./controls";
import { SamplePicker } from "./SamplePicker";
import { ask } from "../state/confirm";
import { paletteCss } from "./palette";
import { drawPeaks, drawWaveBg } from "./wave";

const GRAB_PX = 6; // CSS px within which a click grabs a marker
const DRAG_PX = 4; // movement before a click becomes a drag
const MIN_GAP_S = 0.01;
const PAD_IDS = Array.from({ length: PAD_COUNT }, (_, i) => i);

type View = [number, number];
type Drag = { kind: "marker"; i: number } | { kind: "pending" | "pan"; x0: number; view: View };

/** Colour of the pad slice `k` lands on, or null past the last pad. */
const padColor = (pads: { color: number }[], firstPad: number, k: number) => (firstPad + k < PAD_COUNT ? paletteCss(pads[firstPad + k].color) : null);

export function ChopEditor() {
  const chop = useApp((s) => s.chop);
  useApp((s) => s.bufferTick); // the editor opens once the sample's audio has loaded
  const selectedPad = useApp((s) => s.selectedPad);
  const padHasSample = useApp((s) => !!drumPads(s)[s.selectedPad].sampleId);
  const buffer = chop ? engine.buffer(chop.sampleId) : undefined;
  const active = !!buffer;

  // Opening the tab puts the Launchkey back in Chop; it stays there on other tabs until it leaves (Shift + Encoder ⌄) or the chop is sent.
  useEffect(() => {
    if (!active) return;
    enterChopHw();
    return () => chopStop();
  }, [active]);

  const source = (
    <SamplePicker value={chop?.sampleId ?? null} placeholder="Pick a sample…" allowNone onPick={(id) => set({ chop: id ? newChop(id) : null })} />
  );

  if (!chop || !buffer) {
    return (
      <Section title="Chop" actions={source}>
        <p className="hint">
          Sample something on a drum track's Track tab (or Shift + Record on the Launchkey): the take opens here with its transients marked. Or pick any sample above.
        </p>
        {padHasSample && <button onClick={openInChop}>Chop pad {selectedPad + 1}'s sample</button>}
      </Section>
    );
  }
  return <ChopSessionView chop={chop} buffer={buffer} source={source} />;
}

function ChopSessionView({ chop, buffer, source }: { chop: ChopSession; buffer: AudioBuffer; source: React.ReactNode }) {
  const { sampleId, markers, view, sel, firstPad, count, sens } = chop;
  const name = useApp((s) => s.samples[sampleId]?.name ?? "Sample");
  const pads = useApp(drumPads);
  const rack = useApp(chopRack);
  const projectBpm = useApp((s) => s.project.bpm);
  const [assignTo, setAssignTo] = useState(0);
  const [stretching, setStretching] = useState(false);
  const theme = useApp((s) => s.theme); // canvas colours come from CSS variables: redraw when they change
  const [playhead, setPlayhead] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);

  const data = buffer.getChannelData(0);
  const minGap = MIN_GAP_S / buffer.duration;
  const min = minSpan(buffer);
  const slices = slicesFromMarkers(markers);
  const region: [number, number] = [markers[0], markers[markers.length - 1]];
  const setMarkers = (m: number[]) => updateChop({ markers: m });
  const setView = (v: View | ((v: View) => View)) => updateChop((c) => ({ view: typeof v === "function" ? v(c.view) : v }));
  const snap = (f: number) => zeroCrossing(data, Math.max(0, Math.min(1, f)));

  // ---------- drawing ----------

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = c.clientWidth * dpr);
    const h = (c.height = c.clientHeight * dpr);
    const g = c.getContext("2d")!;
    const css = getComputedStyle(c);
    drawWaveBg(g, css, w, h, dpr);
    const [v0, v1] = view;
    const px = (f: number) => ((f - v0) / (v1 - v0)) * w;
    // Tint each slice with the colour of the pad it will land on.
    slicesFromMarkers(markers).forEach(([a, b], k) => {
      g.fillStyle = padColor(pads, firstPad, k) ?? "#646c75";
      g.globalAlpha = 0.1;
      g.fillRect(px(a), 0, px(b) - px(a), h);
    });
    g.globalAlpha = 1;
    const fg = css.getPropertyValue("--wave-fg") || "#4cf";
    const ra = px(markers[0]), rb = px(markers[markers.length - 1]);
    drawPeaks(g, data, v0 * data.length, v1 * data.length, w, h, fg, (x) => (x >= ra && x <= rb ? 1 : 0.28));
    g.fillStyle = css.getPropertyValue("--shade") || "rgba(0,0,0,.3)";
    g.fillRect(0, 0, ra, h);
    g.fillRect(rb, 0, w - rb, h);
    const white = css.getPropertyValue("--white") || "#e6e9ec";
    markers.forEach((m, i) => {
      const bound = i === 0 || i === markers.length - 1;
      g.fillStyle = i === sel ? css.getPropertyValue("--accent") || "#d9a55a" : white;
      g.globalAlpha = i === sel || bound ? 1 : 0.7;
      g.fillRect(Math.round(px(m)) - (bound ? dpr : dpr / 2), 0, bound ? 2 * dpr : dpr, h);
    });
    g.globalAlpha = 1;
  }, [data, view, markers, sel, firstPad, pads, theme]);

  useEffect(() => {
    const c = overview.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = c.clientWidth * dpr);
    const h = (c.height = c.clientHeight * dpr);
    const g = c.getContext("2d")!;
    const css = getComputedStyle(c);
    g.fillStyle = css.getPropertyValue("--wave-bg") || "#111";
    g.fillRect(0, 0, w, h);
    drawPeaks(g, data, 0, data.length, w, h, css.getPropertyValue("--dim") || "#646c75");
    g.fillStyle = css.getPropertyValue("--view-hi") || "rgba(230,233,236,.1)";
    g.fillRect(view[0] * w, 0, (view[1] - view[0]) * w, h);
    g.strokeStyle = css.getPropertyValue("--accent") || "#d9a55a";
    g.lineWidth = dpr;
    g.strokeRect(view[0] * w + dpr / 2, dpr / 2, Math.max(dpr, (view[1] - view[0]) * w - dpr), h - dpr);
  }, [data, view, theme]);

  // ---------- view ----------

  const zoomAt = (f: number, factor: number) => setView(([v0, v1]) => {
    const span = (v1 - v0) * factor;
    return clampView(f - ((f - v0) / (v1 - v0)) * span, span, min);
  });

  // Wheel zooms around the cursor; shift or a horizontal swipe scrolls. Non-passive so the page doesn't scroll.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      updateChop(({ view: [v0, v1] }) => {
        const span = v1 - v0;
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
          return { view: clampView(v0 + (d / r.width) * span, span, min) };
        }
        const f = v0 + ((e.clientX - r.left) / r.width) * span;
        const next = span * Math.exp(e.deltaY * 0.002);
        return { view: clampView(f - ((f - v0) / span) * next, next, min) };
      });
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [min]);

  // ---------- audition ----------

  // Pads on the Launchkey audition too, so poll the shared playhead rather than tracking our own playback.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setPlayhead(chopPlayhead());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------- keyboard ----------

  // Re-bound every render so the handler sees current markers and playhead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        // Don't let Space also click the button that was pressed last.
        e.preventDefault();
        if (t instanceof HTMLButtonElement) t.blur();
        if (chopPlaying()) chopStop();
        else chopPlay(...region);
      } else if (e.key === "m" || e.key === "M" || e.key === "Enter") {
        // Tap-chop: drop a marker where the playhead is.
        e.preventDefault();
        if (playhead !== null) setMarkers(addMarker(markers, snap(playhead), minGap));
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) {
        e.preventDefault();
        updateChop({ markers: removeMarker(markers, sel), sel: null });
      } else if (/^[1-9]$/.test(e.key)) {
        chopPlaySlice(Number(e.key) - 1);
      } else if (e.key === "0") {
        chopPlaySlice(9);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- pointer ----------

  const fracAt = (clientX: number, v: View = view) => {
    const r = canvas.current!.getBoundingClientRect();
    return v[0] + ((clientX - r.left) / r.width) * (v[1] - v[0]);
  };
  const markerAt = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const perPx = (view[1] - view[0]) / r.width;
    let best = -1, bestD = GRAB_PX * perPx;
    markers.forEach((m, i) => {
      const d = Math.abs(m - fracAt(clientX));
      if (d <= bestD) { best = i; bestD = d; }
    });
    return best;
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = markerAt(e.clientX);
    if (i >= 0) {
      updateChop({ sel: i });
      drag.current = { kind: "marker", i };
    } else drag.current = { kind: "pending", x0: e.clientX, view };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) {
      e.currentTarget.style.cursor = markerAt(e.clientX) >= 0 ? "ew-resize" : "crosshair";
      return;
    }
    if (d.kind === "marker") {
      setMarkers(moveMarker(get().chop?.markers ?? markers, d.i, snap(fracAt(e.clientX)), minGap));
      return;
    }
    if (d.kind === "pending" && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
    // Dragging empty space scrolls the view.
    drag.current = { ...d, kind: "pan" };
    const r = e.currentTarget.getBoundingClientRect();
    const span = d.view[1] - d.view[0];
    setView(clampView(d.view[0] - ((e.clientX - d.x0) / r.width) * span, span, min));
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind !== "pending") return;
    // A plain click on empty waveform adds a marker.
    const m = snap(fracAt(e.clientX));
    const next = addMarker(markers, m, minGap);
    updateChop({ markers: next, sel: next !== markers ? next.indexOf(m) : null });
  };
  const onDouble = (e: React.MouseEvent) => {
    const i = markerAt(e.clientX);
    if (i > 0 && i < markers.length - 1) updateChop({ markers: removeMarker(markers, i), sel: null });
  };

  const onOverview = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.buttons) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    setView(([v0, v1]) => clampView(f - (v1 - v0) / 2, v1 - v0, min));
  };

  // ---------- actions ----------

  const auto = (mode: "equal" | "transient") => autoChop(mode);
  const fit = Math.min(slices.length, PAD_COUNT - firstPad);
  const overwrites = (from: number, n: number) => pads.slice(from, from + n).filter((p) => p.sampleId).length;
  const newRack = async () => {
    const full = !canAddTrack(get().project);
    const n = Math.min(slices.length, PAD_COUNT);
    const used = overwrites(0, n);
    if (full && used && !(await ask({
      title: "No room for a new track",
      message: `There are already 8 tracks, so the slices go to ${drumTrack().name}, replacing ${used} pad${used === 1 ? "" : "s"} with samples. Undo brings them back.`,
      ok: "Replace pads",
    }))) return;
    void sendChopToNewTrack();
  };
  const send = async () => {
    const used = overwrites(firstPad, fit);
    if (used && !(await ask({
      title: "Replace pads",
      message: `Replace ${used} pad${used === 1 ? "" : "s"} with samples on ${drumTrack().name}? Undo brings them back.`,
      ok: "Replace",
    }))) return;
    const n = slicesToPads(sampleId, markers, firstPad, name, chop.slices);
    const dropped = slices.length - n;
    set({ status: `Sent ${n} slice${n === 1 ? "" : "s"} to pads ${firstPad + 1}–${firstPad + n}${dropped ? ` (${dropped} didn't fit)` : ""}` });
  };
  const crop = async () => {
    chopStop();
    const id = await cropSample(sampleId, region[0], region[1]);
    if (!id) return;
    // Keep the inner markers, re-expressed in the cropped sample, and the chops' settings.
    const span = region[1] - region[0];
    set({
      chop: { ...chop, sampleId: id, markers: markers.map((m) => (m - region[0]) / span), view: [0, 1], sel: null },
      status: `Cropped to ${(span * buffer.duration).toFixed(2)} s`,
    });
  };
  const stretch = async () => {
    setStretching(true);
    await stretchChop().finally(() => setStretching(false));
  };
  const pct = (f: number) => `${((f - view[0]) / (view[1] - view[0])) * 100}%`;
  const time = (f: number) => `${(f * buffer.duration).toFixed(2)} s`;
  const state = get();
  const onPad = slices.map((_, k) => chopPadOf(state, k));
  // The selected chop: the one starting at the selected marker.
  const cur = sel !== null && sel < slices.length ? sel : null;
  const opts = cur !== null ? (chop.slices[cur] ?? DEFAULT_SLICE) : null;
  const setOpts = (patch: Partial<typeof DEFAULT_SLICE>) => cur !== null && updateChop((c) => ({ slices: c.slices.map((o, j) => (j === cur ? { ...o, ...patch } : o)) }));
  const tempo = chopTempo(chop, buffer);
  const looping = playhead !== null && chopLooping();

  return (
    <div className="chop-editor">
      <Section
        title={`Chop · ${name}`}
        actions={
          <>
            {source}
            <button onClick={() => confirmDeleteSample(sampleId)} title="Delete this sample from the library and every pad using it">Delete</button>
            <button onClick={crop} disabled={region[0] <= 0 && region[1] >= 1} title="Keep only the region between the outer markers as a new sample">Crop to region</button>
          </>
        }
      >
        <div className="row wrap chop-tools">
          <button className={playhead !== null && !looping ? "on" : ""} onClick={() => (chopPlaying() ? chopStop() : chopPlay(...region))}>{playhead !== null && !looping ? "■ Stop" : "▶ Play"}</button>
          <button className={looping ? "on" : ""} onClick={chopToggleLoop} title="Loop the region, to count its bars and hear the seam">⟳ Loop</button>
          <span className="chop-sep" />
          <button onClick={() => zoomAt(playhead ?? (view[0] + view[1]) / 2, 0.5)} aria-label="Zoom in">＋</button>
          <button onClick={() => zoomAt((view[0] + view[1]) / 2, 2)} aria-label="Zoom out">－</button>
          <button onClick={() => setView([0, 1])}>Fit</button>
          <button onClick={() => setView(clampView(region[0], region[1] - region[0], min))}>Region</button>
          <span className="chop-sep" />
          <button onClick={() => auto("transient")}>Transients</button>
          <label className="chop-sens" title="Transient sensitivity">
            <span className="hint">Sens</span>
            <input type="range" min={0} max={1} step={0.05} value={sens} onChange={(e) => updateChop({ sens: Number(e.target.value) })} />
          </label>
          <select value={count} onChange={(e) => updateChop({ count: Number(e.target.value) })} title="Most slices for Transients / slices for Equal">
            {[2, 4, 8, 12, 16, 24, MAX_CHOPS].map((n) => <option key={n} value={n}>{n} max</option>)}
          </select>
          <button onClick={() => auto("equal")}>Equal</button>
          <button onClick={() => updateChop({ markers: region, sel: null })}>Clear</button>
          <span className="hint chop-time">{time(view[0])} – {time(view[1])} · {slices.length} slice{slices.length === 1 ? "" : "s"}</span>
        </div>

        <div className="chop-lane">
          {slices.map(([a, b], k) => (
            <button
              key={k}
              style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})`, "--slice": padColor(pads, firstPad, k) ?? "var(--dim)" } as React.CSSProperties}
              className={k === sel ? "on" : ""}
              onClick={() => {
                chopPlaySlice(k);
                updateChop({ sel: k });
              }}
              title={`Chop ${k + 1} · key ${noteName(CHOP_KEY0 + k)}${onPad[k] >= 0 ? ` · on pad ${onPad[k] + 1} of ${rack?.name}` : ""} · ${time(b - a)}`}
            >
              {k + 1}{onPad[k] >= 0 && <small>→{onPad[k] + 1}</small>}
            </button>
          ))}
        </div>
        <div className="chop-wave">
          <canvas ref={canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDouble} />
          {playhead !== null && playhead >= view[0] && playhead <= view[1] && <div className="chop-playhead" style={{ left: pct(playhead) }} />}
        </div>
        <canvas ref={overview} className="chop-overview" onPointerDown={onOverview} onPointerMove={onOverview} />

        <div className="row wrap chop-tools">
          {cur !== null && opts ? (
            <>
              <b>Chop {cur + 1}</b>
              <span className="hint">key {noteName(CHOP_KEY0 + cur)}</span>
              <Field label="Pitch">
                <input type="number" min={-24} max={24} step={1} value={opts.pitch} onChange={(e) => setOpts({ pitch: Math.max(-24, Math.min(24, Math.round(Number(e.target.value)) || 0)) })} />
              </Field>
              <label title="Chops with Choke on cut each other off; the others ring out">
                <input type="checkbox" checked={opts.choke} onChange={(e) => setOpts({ choke: e.target.checked })} /> Choke
              </label>
              <span className="chop-sep" />
              <select value={assignTo} onChange={(e) => setAssignTo(Number(e.target.value))}>
                {PAD_IDS.map((i) => <option key={i} value={i}>Pad {i + 1}</option>)}
              </select>
              <button onClick={() => assignChop(cur, assignTo)} title="Put this chop on the pad (Launchkey: hold its key and tap the pad)">
                → {rack ? rack.name : "new rack"}
              </button>
            </>
          ) : (
            <span className="hint">Click a numbered chop (or play its key) to set its pitch and choke and put it on a pad.</span>
          )}
          {rack && (
            <button className="primary chop-done" onClick={finishChop} title="Go to the rack and play (Launchkey: Function)">
              Done → {rack.name}
            </button>
          )}
        </div>

        <div className="row wrap chop-tools">
          <b>Tempo</b>
          <Field label="Length">
            <input
              type="number" min={0.25} max={64} step={0.25} value={tempo.beats / 4}
              onChange={(e) => updateChop({ beats: Math.max(1, Math.min(256, Math.round(Number(e.target.value) * 4) || 1)) })}
            />
          </Field>
          <span className="hint">
            bars{chop.beats === null ? " (guessed)" : ""} · {beatsLabel(tempo.beats)} in {tempo.seconds.toFixed(2)} s = <b>{bpmText(tempo.bpm)} BPM</b>
          </span>
          <Field label="Stretch to">
            <input type="number" min={40} max={240} step={0.1} value={chop.toBpm} onChange={(e) => updateChop({ toBpm: Math.max(40, Math.min(240, Number(e.target.value) || projectBpm)) })} />
          </Field>
          {chop.toBpm !== projectBpm && <button onClick={() => updateChop({ toBpm: projectBpm })}>Project ({bpmText(projectBpm)})</button>}
          <button disabled={stretching || Math.abs(tempo.bpm - chop.toBpm) < 0.05} onClick={stretch} title="Render the region at the new tempo, keeping its pitch, as a new sample (Launchkey: Tempo page, Function)">
            {stretching ? "Stretching…" : `Stretch ${bpmText(tempo.bpm)} → ${bpmText(chop.toBpm)}`}
          </button>
          {chop.from && <button onClick={chopOriginal} title="Back to the sample before the stretch">↺ Original</button>}
        </div>

        <p className="hint tip">
          Click: add marker · drag marker: move · double-click or Delete: remove · drag empty: scroll · wheel: zoom (shift: scroll) ·
          Space: play region · <b>M</b> while playing: drop a marker at the playhead · 1–9: play chop · click a numbered chop to hear and pick it.
          Markers snap to zero crossings. Set the region's length in bars to see its tempo, then stretch it to yours.
        </p>
        <p className="hint tip">
          <b>Launchkey:</b> the keys play the chops (C3 = chop 1) · <b>hold a key and tap a pad</b> to put that chop on it (the first one
          makes a new drum rack; the pads then play it) · encoder 1 scroll · 2 zoom · 3 pick marker · 4 move marker (Shift = fine) ·
          5 max chops · 6 sensitivity · 7 pitch · 8 choke (Shift: all) · Play: play from the marker · Scene: add a marker at the playhead
          (Shift + Scene: remove) · <b>Function: done</b> (to your rack, or chops 1–16 on a new one) · Encoder ⌄: <b>Tempo page</b>
          (1 start, 2 end, 3 length, 4 tempo, Play loops, Function stretches; ⌃ back) · Shift + Encoder ⌄: leave.
        </p>
        <div className="row">
          <button className="primary" disabled={!slices.length} onClick={newRack} title="Crop to the region, make a new drum track and put the slices on pads 1–16 (Launchkey: Function)">
            → New drum rack ({Math.min(slices.length, PAD_COUNT)} pads)
          </button>
          <span className="chop-sep" />
          <Field label="First pad">
            <select value={firstPad} onChange={(e) => updateChop({ firstPad: Number(e.target.value) })}>
              {PAD_IDS.map((i) => <option key={i} value={i}>Pad {i + 1}</option>)}
            </select>
          </Field>
          <button disabled={!fit} onClick={send}>
            Send {fit} slice{fit === 1 ? "" : "s"} → {drumTrack().name} pads {firstPad + 1}–{firstPad + fit}
          </button>
          {slices.length > fit && <span className="hint">{slices.length - fit} won't fit</span>}
        </div>
      </Section>
    </div>
  );
}
