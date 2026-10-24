import type { CSSProperties, ReactNode } from "react";

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 0.01, format, onChange } = props;
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  // Ranges either side of zero (pan, EQ, pitch, detune) fill from the zero point, so a centred value shows no bar.
  const from = min < 0 && max > 0 ? Math.min(0, value) : min;
  const to = min < 0 && max > 0 ? Math.max(0, value) : value;
  return (
    <label className="slider" style={{ "--from": at(from), "--fill": at(to) } as CSSProperties}>
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{format ? format(value) : value.toFixed(2)}</span>
    </label>
  );
}

/** A choice laid out like a slider row (label, then the control), so it lines up in a column of sliders. */
export function SelectRow<T extends string | number>({ label, value, options, format = String, onPick }: {
  label: string; value: T; options: readonly T[]; format?: (v: T) => string; onPick: (v: T) => void;
}) {
  return (
    <label className="slider select-row">
      <span className="slider-label">{label}</span>
      <select value={value} onChange={(e) => onPick(options.find((o) => String(o) === e.target.value) ?? value)}>
        {options.map((o) => <option key={o} value={o}>{format(o)}</option>)}
      </select>
    </label>
  );
}

/** A switch laid out like a slider row. */
export function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="slider toggle-row">
      <span className="slider-label">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** A level meter laid out like a slider row: label, bar (0..1 of its width), value. */
export function MeterRow({ label, level, value, title, className = "" }: { label: string; level: number; value: string; title?: string; className?: string }) {
  return (
    <div className={`slider meter-row ${className}`} title={title}>
      <span className="slider-label">{label}</span>
      <div className="meter"><div style={{ width: `${Math.round(Math.max(0, Math.min(1, level)) * 100)}%` }} /></div>
      <span className="slider-value">{value}</span>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Section({ title, children, actions, color }: { title: string; children: ReactNode; actions?: ReactNode; color?: string }) {
  return (
    <section className="section" style={color ? ({ "--page": color } as CSSProperties) : undefined}>
      <header>
        <h2>{title}</h2>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
