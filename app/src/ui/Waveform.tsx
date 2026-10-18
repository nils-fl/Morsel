import { useEffect, useRef } from "react";
import { useApp } from "../state/store";
import { drawPeaks, drawWaveBg } from "./wave";

/** Waveform with draggable start/end handles (values 0..1). `slices` draws thin chop markers. */
export function Waveform(props: {
  buffer: AudioBuffer | undefined;
  start: number;
  end: number;
  slices?: number[];
  color?: string;
  onChange: (start: number, end: number) => void;
}) {
  const { buffer, start, end, slices, color, onChange } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<"start" | "end" | null>(null);
  const theme = useApp((s) => s.theme); // colours come from CSS variables: redraw when they change

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = c.clientWidth * dpr);
    const h = (c.height = c.clientHeight * dpr);
    const g = c.getContext("2d")!;
    const css = getComputedStyle(c);
    drawWaveBg(g, css, w, h, dpr);
    if (!buffer) return;
    const fg = color || css.getPropertyValue("--wave-fg") || "#4cf";
    const d = buffer.getChannelData(0);
    const a = Math.min(start, end) * w;
    const b = Math.max(start, end) * w;
    drawPeaks(g, d, 0, d.length, w, h, fg, (x) => (x >= a && x <= b ? 1 : 0.28));
    g.fillStyle = css.getPropertyValue("--shade") || "rgba(0,0,0,.3)";
    g.fillRect(0, 0, a, h);
    g.fillRect(b, 0, w - b, h);
    g.fillStyle = css.getPropertyValue("--white") || "#e6e9ec";
    g.globalAlpha = 0.5;
    for (const m of slices ?? []) g.fillRect(Math.round(m * w), 0, dpr, h);
    g.globalAlpha = 1;
    g.fillRect(a - dpr, 0, 2 * dpr, h);
    g.fillRect(b - dpr, 0, 2 * dpr, h);
  }, [buffer, start, end, slices, color, theme]);

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
