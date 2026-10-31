// The Perform tab: the live effects on the whole mix, as on the Launchkey's Perform mode. Hold an effect's pad to play
// it (Shift-click latches it), pick the Flex Beat effects, and set up the Knob FX the encoders play.
import { FLEX_NAMES, KNOB_FX, MAX_PAD_FX, PAD_FX, formatParam, type FxDef, type FxParam } from "../audio/perform/catalog";
import { performAvailable, performBank, performPadDown, performPadUp, performSelect, performToggleLatch, sounding } from "../modes/perform";
import { updatePerform, useApp } from "../state/store";
import { Section, SelectRow, Slider, ToggleRow } from "./controls";

/** Pads 9-16 on top, 1-8 below, as on the Launchkey. */
const ORDER = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];

const FAMILY_VAR: Record<FxDef["family"], string> = {
  time: "var(--orange)", mod: "var(--violet)", filter: "var(--cyan)", color: "var(--yellow)", space: "var(--blue)",
};

function ParamRow({ p, value, onChange }: { p: FxParam; value: number; onChange: (v: number) => void }) {
  if (p.options) {
    const idx = p.options.map((_, i) => i);
    return <SelectRow label={p.name} value={Math.round(value)} options={idx} format={(i) => p.options![i]} onPick={onChange} />;
  }
  return <Slider label={p.name} value={value} min={p.min} max={p.max} step={p.step / 2} format={(v) => formatParam(p, v)} onChange={onChange} />;
}

const setRow = (rows: number[][], i: number, j: number, v: number) => rows.map((r, k) => (k === i ? r.map((x, m) => (m === j ? v : x)) : r));

export function PerformPanel() {
  const live = useApp((s) => s.perform);
  const settings = useApp((s) => s.project.perform);
  const ok = performAvailable();
  const on = sounding(live);
  const sel = PAD_FX[live.selected];
  const knob = KNOB_FX[settings.knob.kind];

  const down = (i: number, e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (live.bank === "pad" && e.shiftKey) return performToggleLatch(i);
    performPadDown(i, 100);
  };

  return (
    <div className="perform-panel panels">
      <Section
        title="Perform"
        actions={
          <div className="seg">
            <button className={live.bank === "pad" ? "on" : ""} onClick={() => performBank("pad")}>Pad FX</button>
            <button className={live.bank === "flex" ? "on" : ""} onClick={() => performBank("flex")}>Flex Beat</button>
          </div>
        }
      >
        <p className="hint tip">
          Live effects on the whole mix, heard live and in a take from the master (Shift + Record), not recorded into the
          clips. On the Launchkey: Func to <b>Perform</b> mode. Pad FX: hold a pad, press harder for more; up to {MAX_PAD_FX} at
          once (a fifth bypasses the oldest until you let go of it); Scene latches the pads you hold, Shift + Scene turns
          everything off. Pad ⌃ / ⌄ switch to Flex Beat: time effects on the mix, pad 1 stops them. Here: hold an effect,
          Shift-click to latch it.
        </p>
        {!ok && <p className="hint">The Perform effects run on the worklet voice engine (Preferences → Lab).</p>}
        <div className="perform-grid">
          {ORDER.map((i) => {
            const flex = live.bank === "flex";
            const name = flex ? FLEX_NAMES[i] : PAD_FX[i].name;
            const active = flex ? live.flex === i && i > 0 : on.includes(i);
            const bypassed = !flex && live.engaged.includes(i) && !active;
            const latched = !flex && live.latched.includes(i);
            const color = flex ? "var(--magenta)" : FAMILY_VAR[PAD_FX[i].family];
            return (
              <button
                key={i}
                className={`perform-pad${active ? " on" : ""}${bypassed ? " bypassed" : ""}${latched ? " latched" : ""}${!flex && live.selected === i ? " selected" : ""}`}
                style={{ "--fx": color } as React.CSSProperties}
                disabled={!ok}
                onPointerDown={(e) => down(i, e)}
                onPointerUp={() => (flex ? undefined : performPadUp(i))}
                onPointerCancel={() => performPadUp(i)}
                onContextMenu={(e) => e.preventDefault()}
              >
                <span className="perform-num">{i + 1}</span>
                <span className="perform-name">{name}</span>
                {latched && <span className="perform-latch">latch</span>}
              </button>
            );
          })}
        </div>
      </Section>

      {live.bank === "pad" ? (
        <Section title={`Pad ${live.selected + 1}: ${sel.name}`}>
          <p className="hint tip">The settings of the Pad FX touched last (encoders 1–{sel.params.length} on the Launchkey's Perform page). Click a name above to pick another.</p>
          <div className="perform-pick">
            {PAD_FX.map((d, i) => (
              <button key={i} className={`chip${i === live.selected ? " on" : ""}`} onClick={() => performSelect(i)}>{d.short}</button>
            ))}
          </div>
          {sel.params.map((p, j) => (
            <ParamRow key={p.name} p={p} value={settings.pad[live.selected][j]} onChange={(v) => updatePerform((s) => ({ ...s, pad: setRow(s.pad, live.selected, j, v) }))} />
          ))}
        </Section>
      ) : (
        <Section title="Flex Beat">
          <p className="hint tip">The effects follow the bar: each is a bar long and lines up with the bar lines. One shot plays an effect to the end of its bar and goes back to Empty; Loop repeats it until you pick another or pad 1. Quantize waits for the next bar line to switch.</p>
          <ToggleRow label="Loop" checked={!settings.flex.oneShot} onChange={(v) => updatePerform((s) => ({ ...s, flex: { ...s.flex, oneShot: !v } }))} />
          <ToggleRow label="Quantize" checked={settings.flex.quantize} onChange={(v) => updatePerform((s) => ({ ...s, flex: { ...s.flex, quantize: v } }))} />
          <Slider label="Mix" value={settings.flex.mix} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updatePerform((s) => ({ ...s, flex: { ...s.flex, mix: v } }))} />
        </Section>
      )}

      <Section title="Knob FX">
        <p className="hint tip">One effect on the whole mix, played on the encoders in any mode (the Knob FX encoder page) while the pads go on playing.</p>
        <ToggleRow label="On" checked={settings.knob.on} onChange={(v) => updatePerform((s) => ({ ...s, knob: { ...s.knob, on: v } }))} />
        <SelectRow label="Effect" value={settings.knob.kind} options={KNOB_FX.map((_, i) => i)} format={(i) => KNOB_FX[i].name} onPick={(i) => updatePerform((s) => ({ ...s, knob: { ...s.knob, kind: i } }))} />
        {knob.params.map((p, j) => (
          <ParamRow
            key={`${knob.name}-${p.name}`}
            p={p}
            value={settings.knob.params[settings.knob.kind][j]}
            onChange={(v) => updatePerform((s) => ({ ...s, knob: { ...s.knob, params: setRow(s.knob.params, s.knob.kind, j, v) } }))}
          />
        ))}
        <Slider label="Mix" value={settings.knob.mix} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updatePerform((s) => ({ ...s, knob: { ...s.knob, mix: v } }))} />
      </Section>
    </div>
  );
}
