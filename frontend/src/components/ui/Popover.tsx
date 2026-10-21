import { type HTMLAttributes, type ReactNode, useEffect, useRef } from "react";

// Anchored floating panel: closes on outside pointer-down and on Escape.
// The trigger stays in normal flow; the panel is positioned by `panelClassName`
// (e.g. `.custom-select-popover`, `.density-popover`).
export default function Popover({
  open,
  onClose,
  trigger,
  children,
  className,
  panelClassName,
  panelProps,
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
  panelProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className={["popover", className].filter(Boolean).join(" ")} ref={ref}>
      {trigger}
      {open && (
        <div {...panelProps} className={panelClassName}>
          {children}
        </div>
      )}
    </div>
  );
}
