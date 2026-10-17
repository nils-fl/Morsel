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
  return (
    <label className="slider" style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}>
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{format ? format(value) : value.toFixed(2)}</span>
    </label>
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
