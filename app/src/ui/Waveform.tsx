import { useEffect, useRef } from "react";

/** Waveform with draggable start/end handles (values 0..1). */
export function Waveform(props: {
  buffer: AudioBuffer | undefined;
  start: number;
  end: number;
  slices?: number[];
  color?: string;
  onChange: (start: number, end: number) => void;
}) {
  const { buffer, start, end, color, onChange } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<"start" | "end" | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = c.clientWidth * dpr);
    const h = (c.height = c.clientHeight * dpr);
    const g = c.getContext("2d")!;
    const css = getComputedStyle(c);
    g.fillStyle = css.getPropertyValue("--wave-bg") || "#111";
    g.fillRect(0, 0, w, h);
    // Faint grid, like the screen's dotted reference lines.
    g.fillStyle = "rgba(255,255,255,.06)";
    for (let x = 0; x < w; x += w / 16) g.fillRect(Math.round(x), 0, dpr, h);
    g.fillRect(0, Math.round(h / 2), w, dpr);
    if (!buffer) return;
    const fg = color || css.getPropertyValue("--wave-fg") || "#4cf";
    const d = buffer.getChannelData(0);
    const per = Math.max(1, Math.floor(d.length / w));
    const a = Math.min(start, end) * w;
    const b = Math.max(start, end) * w;
    for (let x = 0; x < w; x++) {
      let lo = 1, hi = -1;
      for (let i = x * per, n = Math.min(d.length, i + per); i < n; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      g.fillStyle = fg;
      g.globalAlpha = x >= a && x <= b ? 1 : 0.28;
      g.fillRect(x, ((1 - hi) * h) / 2, 1, Math.max(1, ((hi - lo) * h) / 2));
    }
    g.globalAlpha = 1;
    g.fillStyle = "rgba(0,0,0,.45)";
    g.fillRect(0, 0, a, h);
    g.fillRect(b, 0, w - b, h);
    g.fillStyle = "#f2f6ff";
    g.fillRect(a - dpr, 0, 2 * dpr, h);
    g.fillRect(b - dpr, 0, 2 * dpr, h);
  }, [buffer, start, end, color]);

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  return (
    <canvas
      ref={canvas}
      className="waveform"
      onPointerDown={(e) => {
        const x = pos(e);
        drag.current = Math.abs(x - start) < Math.abs(x - end) ? "start" : "end";
        e.currentTarget.setPointerCapture(e.pointerId);
        onChange(drag.current === "start" ? x : start, drag.current === "end" ? x : end);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const x = pos(e);
        onChange(drag.current === "start" ? x : start, drag.current === "end" ? x : end);
      }}
      onPointerUp={() => (drag.current = null)}
    />
  );
}
