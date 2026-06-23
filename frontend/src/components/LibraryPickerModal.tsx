import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ImageRow } from "../api";
import { useI18n } from "../i18n";
import Library from "../pages/Library";

// Full-screen Library browser for picking existing images into a form that
// isn't wired to the app-level tray (e.g. AddHistoryModal's local state).
// Renders above regular `.overlay`/`.modal` dialogs via `.manager-overlay`'s
// z-index. In "single" mode, picking an image closes the picker immediately.
export default function LibraryPickerModal({
  mode,
  onPick,
  onClose,
}: {
  mode: "single" | "multi";
  onPick: (img: ImageRow) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePick = (img: ImageRow) => {
    onPick(img);
    if (mode === "single") onClose();
  };

  return createPortal(
    <div className="manager-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="manager-header">
        <span style={{ fontWeight: 600 }}>{t("pick_from_library")}</span>
        <button className="manager-close" title={t("close")} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="manager-body">
        <Library addToTray={handlePick} onOpenViewer={() => {}} />
      </div>
    </div>,
    document.body,
  );
}
