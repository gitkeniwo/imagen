import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { IconButton } from "./Button";

// Bottom sheet used by the phone UI (options, tags, batch tagging).
// Portaled so no ancestor overflow/transform can clip it; sits above the
// floating tab bar (z-index 60 in styles.css) but below the viewer (100).
export default function Sheet({
  title,
  onClose,
  children,
  footer,
  className,
  hideHead = false,
  grabDraggable = false,
  focusPanel = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Hide the title row and its close button; `title` still names the dialog. */
  hideHead?: boolean;
  /** Drag the grab handle down to dismiss the sheet. */
  grabDraggable?: boolean;
  /** Focus the panel itself instead of the first control (keeps phone keyboards closed). */
  focusPanel?: boolean;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);
  const startY = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the panel; restore it when the sheet closes.
    if (focusPanel) panelRef.current?.focus();
    else panelRef.current?.querySelector<HTMLElement>("button, input, textarea, [tabindex]")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [focusPanel, onClose]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (startY.current === null) return;
    const dy = Math.max(0, event.clientY - startY.current);
    startY.current = null;
    setDragging(false);
    if (dy > 80) onClose();
    else setDragY(0);
  };

  return createPortal(
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <section
        ref={panelRef}
        className={[
          "sheet",
          className,
          dragging ? "sheet-dragging" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={focusPanel ? -1 : undefined}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        <div
          className="sheet-grab"
          aria-hidden="true"
          onPointerDown={
            grabDraggable
              ? (event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  startY.current = event.clientY;
                  setDragging(true);
                }
              : undefined
          }
          onPointerMove={
            grabDraggable
              ? (event) => {
                  if (startY.current === null) return;
                  setDragY(Math.max(0, event.clientY - startY.current));
                }
              : undefined
          }
          onPointerUp={grabDraggable ? endDrag : undefined}
          onPointerCancel={grabDraggable ? endDrag : undefined}
        />
        {!hideHead && (
          <div className="sheet-head">
            <b>{title}</b>
            <IconButton icon="close" label={t("close")} size="md" onClick={onClose} />
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </section>
    </>,
    document.body,
  );
}
