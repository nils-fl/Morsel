import { useEffect, useRef } from "react";
import { H, W, type Frame } from "../display/frame";

/** Draws a 128x64 frame (from `source`) as a lit dot matrix, refreshed ~15 fps. */
export function ScreenPreview({ source, scale = 3, color = "#9fe9ff" }: { source: () => Frame | null; scale?: number; color?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = canvas.current?.getContext("2d");
    if (!g) return;
    // Each pixel is a (scale-1) square with a 1px gap, so the grid of the OLED shows.
    const dot = Math.max(1, scale - 1);
    const draw = () => {
      const f = source();
      g.fillStyle = "#000";
      g.fillRect(0, 0, W * scale, H * scale);
      g.fillStyle = "#080c0e";
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.fillRect(x * scale, y * scale, dot, dot);
      if (!f) return;
      g.fillStyle = color;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (f.px[y * W + x]) g.fillRect(x * scale, y * scale, dot, dot);
    };
    draw();
    const id = setInterval(draw, 66);
    return () => clearInterval(id);
  }, [source, scale, color]);
  return (
    <div className="bezel">
      <canvas
        ref={canvas}
        width={W * scale}
        height={H * scale}
        className="screen-preview"
        style={{ width: W * scale, height: H * scale, "--screen": color } as React.CSSProperties}
        title="Launchkey screen"
      />
    </div>
  );
}
