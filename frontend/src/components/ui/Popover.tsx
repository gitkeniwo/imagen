import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const GAP = 6;
const EDGE = 8;
// Above modals and the viewer (≤ 110), below toasts.
const FIXED_Z = 200;

// Anchored floating panel: closes on outside pointer-down and on Escape.
// The trigger stays in normal flow; the panel is positioned by `panelClassName`
// (e.g. `.custom-select-popover`, `.density-popover`). With `fixed`, the panel
// is placed in viewport coordinates under the trigger (aligned per `align`,
// clamped to the window) so a scrolling, overflow-clipped parent cannot cut it off.
// Fixed panels are portaled to <body>: an ancestor with a transform or
// backdrop-filter (the sticky top bar) would otherwise become their containing
// block and shift them off screen.
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
      const target = e.target as Node;
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return;
      onClose();
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
      setPos({ position: "fixed", top, left, right: "auto", bottom: "auto", zIndex: FIXED_Z });
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
      {open && !fixed && (
        <div {...panelProps} ref={panelRef} className={panelClassName}>
          {children}
        </div>
      )}
      {open &&
        fixed &&
        createPortal(
          <div
            {...panelProps}
            ref={panelRef}
            className={panelClassName}
            // Until measured, keep the panel invisible so it never flashes in
            // its CSS position.
            style={pos ?? { position: "fixed", visibility: "hidden" }}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}
