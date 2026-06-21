import { useEffect, useState } from "react";
import { Generation, ImageRow } from "../api";
import { useI18n } from "../i18n";
import Library from "../pages/Library";
import History from "../pages/History";
import Favorites from "../pages/Favorites";
import Bin from "../pages/Bin";

export type ManagerPanel = "library" | "history" | "favorites" | "bin";

// Full-screen overlay that hosts Library / History / Bin in their non-compact
// "full" mode, so the same components (and all their features) render large.
// Sits below the image lightbox (z-index) so thumbnails still open on top.
export default function FullscreenManager({
  initialPanel,
  onClose,
  addToTray,
  onOpenViewer,
  onReuse,
  refreshKey,
  onChanged,
}: {
  initialPanel: ManagerPanel;
  onClose: () => void;
  addToTray: (img: ImageRow) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  onReuse: (g: Generation) => void;
  refreshKey: number;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<ManagerPanel>(initialPanel);

  // Esc closes; lock background scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Defer to the image lightbox when it's open, so one Esc closes only it.
      if (e.key === "Escape" && !document.querySelector(".viewer-overlay")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("manager-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("manager-open");
    };
  }, [onClose]);

  // Reuse fills the composer behind the overlay; close so the user sees it.
  const handleReuse = (g: Generation) => {
    onReuse(g);
    onClose();
  };

  return (
    <div className="manager-overlay">
      <div className="manager-header">
        <div className="side-tabs manager-tabs">
          {(
            [
              ["library", "fa-images"],
              ["history", "fa-clock-rotate-left"],
              ["favorites", "fa-star"],
              ["bin", "fa-trash-can"],
            ] as [ManagerPanel, string][]
          ).map(([p, icon]) => (
            <button
              key={p}
              className={`tab${panel === p ? " active" : ""}`}
              title={t(`tab_${p}`)}
              onClick={() => setPanel(p)}
            >
              <i className={`fa-solid ${icon}`} />
            </button>
          ))}
        </div>
        <button className="manager-close" title={t("close")} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="manager-body">
        {panel === "library" ? (
          <Library
            addToTray={addToTray}
            onOpenViewer={onOpenViewer}
            refreshKey={refreshKey}
            onChanged={onChanged}
          />
        ) : panel === "history" ? (
          <History
            onReuse={handleReuse}
            onOpenViewer={onOpenViewer}
            refreshKey={refreshKey}
          />
        ) : panel === "favorites" ? (
          <Favorites
            onReuse={handleReuse}
            onOpenViewer={onOpenViewer}
            refreshKey={refreshKey}
            onChanged={onChanged}
          />
        ) : (
          <Bin
            onOpenViewer={onOpenViewer}
            refreshKey={refreshKey}
            onChanged={onChanged}
          />
        )}
      </div>
    </div>
  );
}
