// One swatch for a pad's or track's colour; clicking it opens the palette. Esc or a click outside closes it.
import { useEffect, useRef, useState } from "react";
import { PALETTE_CHOICES, paletteCss } from "./palette";

export function ColorPicker({ value, onPick, label = "Colour" }: { value: number; onPick: (c: number) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="color-picker" ref={box}>
      <button className="swatch-btn" style={{ "--sw": paletteCss(value) } as React.CSSProperties} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={label} title={label} />
      {open && (
        <div className="color-pop" role="listbox" aria-label={label}>
          {PALETTE_CHOICES.map((c) => (
            <button key={c} role="option" aria-selected={c === value} className={`swatch ${c === value ? "on" : ""}`} style={{ background: paletteCss(c) }}
              onClick={() => { onPick(c); setOpen(false); }} aria-label={`Colour ${c}`} />
          ))}
        </div>
      )}
    </div>
  );
}
