import { useEffect, useRef, useState } from "react";

// A browser-independent select (shadcn-style popover with check mark).
export default function CustomSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selected = options.find((o) => o.id === value);

  return (
    <div className="custom-select" ref={ref}>
      <button
        type="button"
        className={`custom-select-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selected?.label ?? value}</span>
        <span className="chevron">▾</span>
      </button>
      {open && (
        <div className="custom-select-popover">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="custom-select-item"
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <span className="check">{o.id === value ? "✓" : ""}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
