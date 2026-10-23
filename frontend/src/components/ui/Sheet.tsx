import { type ReactNode, useEffect, useRef } from "react";
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
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the panel; restore it when the sheet closes.
    panelRef.current?.querySelector<HTMLElement>("button, input, textarea, [tabindex]")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <section
        ref={panelRef}
        className={["sheet", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <b>{title}</b>
          <IconButton icon="close" label={t("close")} size="md" onClick={onClose} />
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </section>
    </>,
    document.body,
  );
}
