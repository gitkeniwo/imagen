import { useEffect, useState } from "react";
import { api, ImageRow, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { pressable } from "../a11y";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/ui/Button";
import { displayName } from "../displayName";
import { downloadImage } from "../components/GenerationCard";
import { useContextMenu } from "../components/ui/ContextMenu";

const PAGE_SIZE = 60;

// Recycle bin: browse soft-deleted images, restore them, or purge permanently.
export default function Bin({
  onOpenViewer,
  refreshKey = 0,
  onChanged,
}: {
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const { open: openContextMenu } = useContextMenu();
  const [images, setImages] = useState<ImageRow[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    api
      .listBin({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((r) => {
        setImages(r.images);
        setTotal(r.total);
        if (r.total > 0 && page * PAGE_SIZE >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1));
        }
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, refreshKey]);

  const restore = async (img: ImageRow) => {
    try {
      await api.restoreImage(img.id);
      load();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const purge = async (img: ImageRow) => {
    const ok = await askConfirm({
      message: t("confirm_purge"),
      confirmLabel: t("delete_forever"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.purgeImage(img.id);
      load();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  // Bin images can only be viewed, downloaded, restored or purged; no
  // reference, favorite or tag actions while they are soft-deleted.
  const openBinMenu = (img: ImageRow, trigger: HTMLElement, x: number, y: number) => {
    openContextMenu({
      x,
      y,
      trigger,
      images: [img],
      shortcuts: [
        { icon: "view", label: t("open_viewer"), onSelect: () => onOpenViewer(img, images) },
        { icon: "download", label: t("download"), onSelect: () => downloadImage(img) },
      ],
      sections: [
        [{ icon: "restore", label: t("restore"), onSelect: () => restore(img) }],
        [{ icon: "delete", label: t("delete_forever"), danger: true, onSelect: () => purge(img) }],
      ],
      ariaLabel: t("image_menu"),
    });
  };

  const emptyBin = async () => {
    const ok = await askConfirm({
      message: t("confirm_empty_bin"),
      confirmLabel: t("empty_bin"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.emptyBin();
      load();
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasPages = total > PAGE_SIZE;

  const pager = hasPages ? (
    <div className="pager">
      <button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
        {t("prev_page")}
      </button>
      <span className="muted small">
        {t("page_status", { page: page + 1, pages: pageCount, total })}
      </span>
      <button
        disabled={page >= pageCount - 1 || loading}
        onClick={() => setPage((p) => p + 1)}
      >
        {t("next_page")}
      </button>
    </div>
  ) : null;

  return (
    <div className="panel library-panel">
      <div className="bin-toolbar">
        <span className="muted small">{t("bin_hint")}</span>
        <div className="spacer" />
        {total > 0 && (
          <Button variant="danger" icon="delete" onClick={emptyBin}>
            {t("empty_bin")}
          </Button>
        )}
      </div>

      {pager}

      {loading ? (
        <p className="muted">
          <span className="spinner" /> {t("loading")}
        </p>
      ) : loadError ? (
        <div className="load-error">
          <span className="small">{t("load_error", { msg: loadError })}</span>
          <button onClick={load}>{t("retry")}</button>
        </div>
      ) : images.length === 0 ? (
        <p className="muted">{t("bin_empty_state")}</p>
      ) : (
        <div className="grid library-grid full">
          {images.map((img) => (
            <div className="card" key={img.id}>
              <div className="card-img-wrap">
                <img
                  src={imgThumbUrl(img)}
                  alt={displayName(img, t)}
                  title={t("open_viewer")}
                  onClick={() => onOpenViewer(img, images)}
                  {...pressable(
                    () => onOpenViewer(img, images),
                    (trigger, x, y) => openBinMenu(img, trigger, x, y),
                  )}
                />
              </div>
              <div className="meta bin-meta">
                <Button className="bin-restore" icon="restore" onClick={() => restore(img)}>
                  {t("restore")}
                </Button>
                <Button className="bin-purge" icon="delete" onClick={() => purge(img)}>
                  {t("delete_forever")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pager}
    </div>
  );
}
