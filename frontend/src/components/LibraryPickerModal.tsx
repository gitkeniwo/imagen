import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImageRow } from "../api";
import { useI18n } from "../i18n";
import Library from "../pages/Library";
import ImageViewer, { type ViewerPager } from "./ImageViewer";
import { Button, IconButton } from "./ui/Button";
import { useIsPhone } from "../useIsPhone";
import { useBackLayer } from "../backStack";

// Full-screen Library browser for picking existing images into a form (the
// composer's references, a draft, a history record). Renders above regular
// `.overlay`/`.modal` dialogs via `.manager-overlay`'s z-index.
//
// Multi mode with `pickedIds` + `onUnpick` is a toggle: picked images keep a
// numbered check, picking one again removes it, and the header counts them.
// Clicking a tile opens the image viewer (on the phone a tap toggles the pick
// and the corner button opens the viewer); the viewer can add or remove too.
// In "single" mode, picking an image closes the picker immediately.
export default function LibraryPickerModal({
  mode,
  onPick,
  onClose,
  pickedIds,
  onUnpick,
}: {
  mode: "single" | "multi";
  onPick: (img: ImageRow) => void;
  onClose: () => void;
  pickedIds?: number[];
  onUnpick?: (img: ImageRow) => void;
}) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const [viewer, setViewer] = useState<{
    image: ImageRow;
    list: ImageRow[];
    pager?: ViewerPager;
    onIndexChange?: (globalIndex: number, image?: ImageRow) => void;
  } | null>(null);
  useBackLayer(true, onClose);

  useEffect(() => {
    // The viewer handles Escape itself while it is open.
    if (viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewer]);

  const handlePick = useCallback(
    (img: ImageRow) => {
      onPick(img);
      if (mode === "single") {
        setViewer(null);
        onClose();
      }
    },
    [mode, onClose, onPick],
  );

  const toggling = mode === "multi" && !!pickedIds && !!onUnpick;
  const picker = toggling ? { pickedIds: pickedIds!, onUnpick: onUnpick! } : undefined;

  const openViewer = useCallback(
    (
      image: ImageRow,
      list: ImageRow[] = [],
      pager?: ViewerPager,
      onIndexChange?: (globalIndex: number, image?: ImageRow) => void,
    ) => setViewer({ image, list, pager, onIndexChange }),
    [],
  );

  return createPortal(
    <div className="manager-overlay picker-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="manager-header">
        <span className="manager-title">{t("pick_from_library")}</span>
        <span className="spacer" />
        {toggling && (
          <>
            <span className="picker-count" aria-live="polite">
              {t("picker_selected_n", { n: pickedIds!.length })}
            </span>
            <Button variant="primary" size="sm" icon="check" onClick={onClose}>
              {t("done")}
            </Button>
          </>
        )}
        <IconButton
          className="manager-close"
          variant="outline"
          size="md"
          icon="close"
          label={t("close")}
          onClick={onClose}
        />
      </div>
      <div className={`manager-body${phone ? " phone-picker" : ""}`}>
        <Library
          addToTray={handlePick}
          onOpenViewer={phone && !toggling ? handlePick : openViewer}
          compact={phone}
          phone={phone}
          picker={picker}
        />
      </div>
      {viewer && (
        <ImageViewer
          nested
          image={viewer.image}
          list={viewer.list}
          pager={viewer.pager}
          onIndexChange={viewer.onIndexChange}
          onClose={() => setViewer(null)}
          onAddToTray={handlePick}
          trayIds={pickedIds}
          onRemoveFromTray={onUnpick}
          onTagsChanged={() => {}}
        />
      )}
    </div>,
    document.body,
  );
}
