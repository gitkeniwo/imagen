import { useEffect, useState } from "react";
import { Generation, ImageRow, TaskSpec } from "../api";
import { useI18n } from "../i18n";
import Library from "../pages/Library";
import History from "../pages/History";
import Favorites from "../pages/Favorites";
import Bin from "../pages/Bin";
import Drafts from "../pages/Drafts";
import PanelTabs from "./ui/PanelTabs";
import type { PanelCounts } from "../usePanelCounts";
import { IconButton } from "./ui/Button";

export type ManagerPanel = "library" | "history" | "favorites" | "drafts" | "bin";

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
  draftRefreshKey,
  canQueue,
  onQueueDraft,
  historyLive,
  counts,
  onCountsChanged,
}: {
  initialPanel: ManagerPanel;
  onClose: () => void;
  addToTray: (img: ImageRow) => void;
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  onReuse: (g: Generation) => void;
  refreshKey: number;
  onChanged?: () => void;
  draftRefreshKey: number;
  canQueue: boolean;
  onQueueDraft: (task: TaskSpec) => void;
  historyLive: boolean;
  counts: PanelCounts;
  onCountsChanged: () => void;
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
    <div className="manager-overlay" role="dialog" aria-modal="true">
      <div className="manager-header">
        <PanelTabs
          className="manager-tabs"
          value={panel}
          onChange={setPanel}
          tabs={[
            { id: "library", label: t("tab_library"), icon: "library", count: counts.library },
            { id: "history", label: t("tab_history"), icon: "history", count: counts.history },
            { id: "favorites", label: t("tab_favorites"), icon: "favorite", count: counts.favorites },
            { id: "drafts", label: t("tab_drafts"), icon: "drafts", count: counts.drafts },
            { id: "bin", label: t("tab_bin"), icon: "bin", count: counts.bin },
          ]}
        />
        <IconButton
          className="manager-close"
          variant="outline"
          size="md"
          icon="close"
          label={t("close")}
          onClick={onClose}
        />
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
            live={historyLive}
          />
        ) : panel === "favorites" ? (
          <Favorites
            onReuse={handleReuse}
            onOpenViewer={onOpenViewer}
            refreshKey={refreshKey}
            onChanged={onChanged}
          />
        ) : panel === "drafts" ? (
          <Drafts
            onChanged={onCountsChanged}
            refreshKey={draftRefreshKey}
            canQueue={canQueue}
            onQueue={onQueueDraft}
            onOpenViewer={onOpenViewer}
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
