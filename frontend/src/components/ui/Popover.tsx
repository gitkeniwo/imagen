import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const GAP = 6;
const EDGE = 8;

// Anchored floating panel: closes on outside pointer-down and on Escape.
// The trigger stays in normal flow; the panel is positioned by `panelClassName`
// (e.g. `.custom-select-popover`, `.density-popover`). With `fixed`, the panel
// is placed in viewport coordinates under the trigger (aligned per `align`,
// clamped to the window) so a scrolling, overflow-clipped parent cannot cut it off.
export default function Popover({
  open,
  onClose,
  trigger,
  children,
  className,
  panelClassName,
  panelProps,
  fixed = false,
  align = "end",
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
  panelProps?: HTMLAttributes<HTMLDivElement>;
  fixed?: boolean;
  // Fixed panels only: which trigger edge the panel lines up with.
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

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

  useLayoutEffect(() => {
    if (!open || !fixed) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const width = panelRef.current?.offsetWidth ?? 0;
      const height = panelRef.current?.offsetHeight ?? 0;
      if (!anchor) return;
      const ideal = align === "start" ? anchor.left : anchor.right - width;
      const left = Math.max(EDGE, Math.min(ideal, window.innerWidth - width - EDGE));
      // Open upward when the panel would run off the bottom and fits above.
      const below = anchor.bottom + GAP;
      const above = anchor.top - GAP - height;
      const top = below + height > window.innerHeight - EDGE && above >= EDGE ? above : below;
      setPos({ position: "fixed", top, left, right: "auto", bottom: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, fixed, align]);

  return (
    <div className={["popover", className].filter(Boolean).join(" ")} ref={ref}>
      {trigger}
      {open && (
        <div
          {...panelProps}
          ref={panelRef}
          className={panelClassName}
          // Until measured, keep a fixed panel invisible so it never flashes in
          // its CSS position.
          style={fixed ? (pos ?? { position: "fixed", visibility: "hidden" }) : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}
